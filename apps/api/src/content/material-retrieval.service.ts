import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  assetRecord,
  deterministicEmbedding,
  embeddingProfileVersion,
  type FrozenImageAsset,
  imageAssetDetails,
  isMedicalAnswerEvidence,
  ModelCredentialCipher,
  modelCredentialAssociatedData,
  OpenAICompatibleEmbeddingProvider,
  readMedicalMaterial,
  resolveEmbeddingProfile,
} from "@xhs-agentic/ai-gateway";
import { Prisma, type RuntimePolicy } from "@xhs-agentic/database";
import { PrismaService } from "../database/prisma.service";
import { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import {
  effectivePromotionFocus,
  matchesPromotionFocus,
  selectPromotionFocus,
} from "./promotion-focus";

export type RetrievalScope = Readonly<{ enterpriseId: string; tenantId: string }>;

export type MaterialRetrievalHit = Readonly<{
  chunkId: string;
  enterpriseId: string | null;
  hitReasons: readonly string[];
  lexicalScore: number;
  materialId: string;
  materialScopeKey: string;
  materialSeriesId: string;
  materialTitle: string;
  materialType: "DOCUMENT" | "IMAGE_REFERENCE" | "LINK" | "TEXT";
  materialVersion: number;
  rank: number;
  score: number;
  snippet: string;
  tagScore: number;
  vectorScore: number;
}>;

export type MaterialRetrievalResult = Readonly<{
  focusEntityIds?: string[];
  focusOptions?: {
    id: string;
    name: string;
    aliases: string[];
    type: string;
    enterpriseId: string | null;
  }[];
  embeddingUsage?: {
    providerId: string;
    modelId: string;
    inputUnits?: number;
    estimatedCost: number | null;
    providerRequestId?: string;
  };
  images?: readonly MaterialImageCandidate[];
  imageSelectionRequired?: boolean;
  contextCharacters: number;
  hits: readonly MaterialRetrievalHit[];
  query: string;
  strategyVersion: string;
}>;

export type MaterialImageCandidate = {
  artifactId: string;
  materialId: string;
  title: string;
  description: string;
  fileName: string;
  usage: "REFERENCE" | "LOGO";
  score: number;
  enterpriseId: string | null;
};

type LexicalRow = Readonly<{ chunkId: string; lexicalScore: number }>;
type VectorRow = Readonly<{ chunkId: string; vectorScore: number }>;

@Injectable()
export class MaterialRetrievalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantCapabilityService)
    private readonly capabilities: TenantCapabilityService,
  ) {}

  async retrieve(
    scope: RetrievalScope,
    prompt: string,
    now = new Date(),
    requestedTopK?: number,
    focusEntityIds?: readonly string[],
    medical = false,
  ): Promise<MaterialRetrievalResult> {
    const [policy, capability, enterprise] = await Promise.all([
      this.prisma.runtimePolicy.findUnique({ where: { id: "platform" } }),
      this.capabilities.current(scope.tenantId, this.prisma),
      this.prisma.enterprise.findFirst({
        select: { brandName: true, city: true, industry: true, name: true },
        where: { id: scope.enterpriseId, status: "ACTIVE", tenantId: scope.tenantId },
      }),
    ]);
    const geoEntities = await this.prisma.geoEntity.findMany({
      include: {
        topics: {
          where: { status: "ACTIVE" },
          orderBy: [{ priority: "desc" }, { version: "desc" }],
          take: 20,
        },
      },
      orderBy: [{ version: "asc" }, { updatedAt: "asc" }],
      where: {
        OR: capability.groupSharedMaterialsEnabled
          ? [{ enterpriseId: scope.enterpriseId }, { enterpriseId: null }]
          : [{ enterpriseId: scope.enterpriseId }],
        status: "ACTIVE",
        tenantId: scope.tenantId,
      },
    });
    const focusOptions = medical ? [] : effectivePromotionFocus(geoEntities, scope.enterpriseId);
    const {
      candidates: imageCandidates,
      ambiguousNames,
      matchedNames,
    } = await this.imageCandidates(scope, prompt, now, medical);
    const selectedFocus = selectPromotionFocus(
      focusOptions,
      prompt,
      medical ? [] : focusEntityIds,
    ).filter(
      (entity) =>
        !ambiguousNames.has(entity.name) &&
        (entity.type !== "DOCTOR" ||
          focusEntityIds !== undefined ||
          !matchedNames.size ||
          matchedNames.has(entity.name.normalize("NFKC").toLowerCase().trim())),
    );
    if (!policy) throw new Error("Platform runtime policy is not initialized");
    const includeShared = capability.groupSharedMaterialsEnabled;
    const scopeKeys = includeShared ? [scope.enterpriseId, "__tenant__"] : [scope.enterpriseId];
    const query = medical
      ? prompt.trim().slice(0, 8_000)
      : buildQuery(prompt, enterprise, selectedFocus);
    const profile = await this.queryEmbedding(query, policy);
    const candidateLimit = Math.max(
      50,
      Math.min(500, (requestedTopK ?? policy.retrievalTopK) * 30),
    );
    const lexicalRows = await this.lexicalCandidates(
      scope,
      scopeKeys,
      query,
      now,
      candidateLimit,
      medical,
    );
    const vectorRows = await this.vectorCandidates(
      scope,
      scopeKeys,
      profile.profileVersion,
      profile.vector,
      now,
      candidateLimit,
      medical,
    );
    const lexicalByChunk = new Map(
      lexicalRows.map((row) => [row.chunkId, clamp(Number(row.lexicalScore))]),
    );
    const vectorByChunk = new Map(
      vectorRows.map((row) => [row.chunkId, clamp(Number(row.vectorScore))]),
    );
    const chunkIds = [...new Set([...lexicalByChunk.keys(), ...vectorByChunk.keys()])];
    const chunks = await this.prisma.materialChunk.findMany({
      include: { material: true },
      where: {
        id: { in: chunkIds },
        scopeKey: { in: scopeKeys },
        tenantId: scope.tenantId,
        material: eligibleMaterialWhere(now),
      },
    });
    const scored = chunks
      .filter((chunk) => {
        if (
          assetRecord(assetRecord(chunk.material.structuredFacts).medicalMaterial).purpose ===
          "ARCHIVE"
        )
          return false;
        if (medical) return isMedicalAnswerEvidence(chunk.material);
        if (chunk.material.type !== "IMAGE_REFERENCE") {
          const entities = assetRecord(chunk.material.analysis).entities;
          const names = Array.isArray(entities)
            ? entities
                .map(assetRecord)
                .filter((entity) => entity.kind === "PERSON" && entity.source !== "FILENAME")
                .map((entity) => entity.name)
                .filter((name): name is string => typeof name === "string")
            : [];
          return (
            !names.some((name) => ambiguousNames.has(name)) &&
            (!matchedNames.size ||
              !names.length ||
              names.some((name) => matchedNames.has(name.normalize("NFKC").toLowerCase().trim())))
          );
        }
        const artifactId = assetRecord(chunk.metadata).artifactId;
        return imageCandidates.some(
          (image) =>
            image.materialId === chunk.materialId &&
            (!artifactId || image.artifactId === artifactId) &&
            (image.usage === "LOGO" || (image.score > 0 && !image.requiresConfirmation)),
        );
      })
      .map((chunk) => {
        const lexicalScore = lexicalByChunk.get(chunk.id) ?? 0;
        const vectorScore = vectorByChunk.get(chunk.id) ?? 0;
        const tagScore = structuredMatchScore(
          query,
          chunk.material.tags,
          chunk.material.structuredFacts,
        );
        const privateBoost = chunk.enterpriseId === scope.enterpriseId ? 0.03 : 0;
        const score = clamp(
          lexicalScore * 0.45 + vectorScore * 0.4 + tagScore * 0.15 + privateBoost,
        );
        const hitReasons = [
          lexicalScore >= 0.1 ? "文案关键词命中" : undefined,
          vectorScore >= 0.55 ? "语义相关" : undefined,
          tagScore > 0 ? "标签或结构化事实命中" : undefined,
          chunk.enterpriseId === scope.enterpriseId ? "企业私有素材" : "集团公共素材",
        ].filter((value): value is string => Boolean(value));
        return { chunk, hitReasons, lexicalScore, score, tagScore, vectorScore };
      })
      .filter(
        (candidate) => !medical || candidate.lexicalScore >= 0.1 || candidate.vectorScore >= 0.55,
      );
    scored.sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.chunk.enterpriseId === scope.enterpriseId) -
          Number(left.chunk.enterpriseId === scope.enterpriseId) ||
        left.chunk.materialId.localeCompare(right.chunk.materialId) ||
        left.chunk.ordinal - right.chunk.ordinal,
    );
    const selected: typeof scored = [];
    const materialCounts = new Map<string, number>();
    const checksums = new Set<string>();
    let contextCharacters = 0;
    const topK = Math.max(1, Math.min(requestedTopK ?? policy.retrievalTopK, 50));
    for (const candidate of scored) {
      if (selected.length >= topK) break;
      if ((materialCounts.get(candidate.chunk.materialId) ?? 0) >= 3) continue;
      if (checksums.has(candidate.chunk.textChecksum)) continue;
      const remaining = policy.retrievalMaxContextCharacters - contextCharacters;
      if (remaining < 120) break;
      if (candidate.chunk.text.length > remaining && selected.length > 0) continue;
      selected.push(candidate);
      checksums.add(candidate.chunk.textChecksum);
      materialCounts.set(
        candidate.chunk.materialId,
        (materialCounts.get(candidate.chunk.materialId) ?? 0) + 1,
      );
      contextCharacters += Math.min(candidate.chunk.text.length, remaining);
    }
    return {
      focusEntityIds: selectedFocus.map(({ id }) => id),
      focusOptions: focusOptions.map(({ id, name, aliases, type, enterpriseId }) => ({
        id,
        name,
        aliases,
        type,
        enterpriseId,
      })),
      imageSelectionRequired: imageCandidates.some((image) => image.requiresConfirmation),
      images: [
        ...imageCandidates.filter((item) => item.usage === "REFERENCE").slice(0, 40),
        ...imageCandidates
          .filter((item) => item.usage === "LOGO")
          .sort(
            (a, b) =>
              Number(b.enterpriseId === scope.enterpriseId) -
              Number(a.enterpriseId === scope.enterpriseId),
          )
          .slice(0, 8),
      ].map(
        ({
          frozen: _frozen,
          personMismatch: _mismatch,
          namedMatch: _named,
          requiresConfirmation: _confirmation,
          ...candidate
        }) => ({
          ...candidate,
          description: candidate.description.slice(0, 700),
        }),
      ),
      contextCharacters,
      embeddingUsage: profile.usage,
      hits: selected.map((candidate, index) => ({
        chunkId: candidate.chunk.id,
        enterpriseId: candidate.chunk.enterpriseId,
        hitReasons: candidate.hitReasons,
        lexicalScore: round(candidate.lexicalScore),
        materialId: candidate.chunk.materialId,
        materialScopeKey: candidate.chunk.scopeKey,
        materialSeriesId: candidate.chunk.material.seriesId,
        materialTitle: candidate.chunk.material.title,
        materialType: candidate.chunk.material.type,
        materialVersion: candidate.chunk.material.version,
        rank: index + 1,
        score: round(candidate.score),
        snippet: candidate.chunk.text.slice(
          0,
          policy.retrievalMaxContextCharacters -
            selected.slice(0, index).reduce((sum, item) => sum + item.chunk.text.length, 0),
        ),
        tagScore: round(candidate.tagScore),
        vectorScore: round(candidate.vectorScore),
      })),
      query,
      strategyVersion: policy.retrievalStrategyVersion,
    };
  }

  private async imageCandidates(scope: RetrievalScope, prompt: string, now: Date, medical = false) {
    const capability = await this.capabilities.current(scope.tenantId, this.prisma);
    const availableRows = await this.prisma.material.findMany({
      where: {
        ...eligibleMaterialWhere(now),
        tenantId: scope.tenantId,
        type: "IMAGE_REFERENCE",
        scopeKey: {
          in: capability.groupSharedMaterialsEnabled
            ? [scope.enterpriseId, "__tenant__"]
            : [scope.enterpriseId],
        },
      },
      include: { artifacts: { where: { status: { in: ["STORED", "VERIFIED"] } } } },
      orderBy: { updatedAt: "desc" },
      take: 500,
    });
    const rows = availableRows.filter(
      (material) =>
        assetRecord(assetRecord(material.structuredFacts).medicalMaterial).purpose !== "ARCHIVE",
    );
    if (medical) {
      const candidates = rows.flatMap((material) => {
        const policy = readMedicalMaterial(assetRecord(material.structuredFacts).medicalMaterial);
        if (policy?.purpose !== "REAL_SCENE") return [];
        return material.artifacts.flatMap((artifact) => {
          const details = imageAssetDetails(artifact.metadata);
          const annotation = readMedicalMaterial(assetRecord(artifact.metadata).medicalMaterial);
          if (
            details.usage !== "REFERENCE" ||
            details.usabilityStatus !== "USABLE" ||
            annotation?.purpose !== "REAL_SCENE" ||
            !artifact.objectKey ||
            !artifact.checksum ||
            !artifact.mimeType.startsWith("image/")
          )
            return [];
          const description = details.description || `真实场景：${annotation.sceneType}`;
          const frozen: FrozenImageAsset = {
            artifactId: artifact.id,
            materialId: material.id,
            objectKey: artifact.objectKey,
            checksum: artifact.checksum,
            mimeType: artifact.mimeType,
            description,
            usage: "REFERENCE",
            privacyConfirmed: true,
            authorizationConfirmed: true,
          };
          return [
            {
              artifactId: artifact.id,
              materialId: material.id,
              title: material.title,
              description,
              fileName: artifact.originalFileName ?? material.title,
              usage: "REFERENCE" as const,
              enterpriseId: material.enterpriseId,
              frozen,
              namedMatch: false,
              personMismatch: false,
              requiresConfirmation: false,
              score: 1,
            },
          ];
        });
      });
      return { candidates, ambiguousNames: new Set<string>(), matchedNames: new Set<string>() };
    }
    const configuredPeople = await this.prisma.geoEntity.findMany({
      select: { name: true, aliases: true, key: true, enterpriseId: true },
      where: {
        tenantId: scope.tenantId,
        status: "ACTIVE",
        type: "DOCTOR",
        OR: capability.groupSharedMaterialsEnabled
          ? [{ enterpriseId: scope.enterpriseId }, { enterpriseId: null }]
          : [{ enterpriseId: scope.enterpriseId }],
      },
    });
    const candidates = rows.flatMap((material) =>
      material.artifacts.flatMap((artifact) => {
        const details = imageAssetDetails(artifact.metadata);
        const annotation = assetRecord(assetRecord(artifact.metadata).medicalMaterial);
        const parentAnnotation = assetRecord(assetRecord(material.structuredFacts).medicalMaterial);
        if (
          annotation.purpose === "ARCHIVE" ||
          ((annotation.purpose === "REAL_SCENE" || parentAnnotation.purpose === "REAL_SCENE") &&
            (readMedicalMaterial(annotation)?.purpose !== "REAL_SCENE" ||
              readMedicalMaterial(parentAnnotation)?.purpose !== "REAL_SCENE"))
        )
          return [];
        if (!artifact.objectKey || !artifact.checksum || details.usabilityStatus === "NEEDS_INPUT")
          return [];
        // Legacy single-image records retain their established availability. Legacy bundles
        // need per-image analysis before they can safely become visual references.
        if (details.usabilityStatus !== "USABLE" && material.artifacts.length !== 1) return [];
        const analysis = Object.keys(details.analysis).length
          ? details.analysis
          : material.artifacts.length === 1
            ? assetRecord(material.analysis)
            : {};
        const entities = Array.isArray(analysis.entities) ? analysis.entities.map(assetRecord) : [];
        const people = entities
          .filter(
            (entity) =>
              entity.kind === "PERSON" &&
              entity.source !== "FILENAME" &&
              typeof entity.name === "string",
          )
          .map((entity) => ({
            name: entity.name as string,
            aliases: Array.isArray(entity.aliases)
              ? entity.aliases.filter((value): value is string => typeof value === "string")
              : [],
          }));
        const person = people.length === 1 ? people[0] : undefined;
        if (person && /^[\p{Script=Han}]{2,4}$/u.test(person.name)) {
          const identityText = [
            details.description,
            material.artifacts.length === 1 ? material.supplement : "",
            analysis.recognizedText,
          ]
            .filter((value): value is string => typeof value === "string")
            .join("\n")
            .replaceAll("\\n", "\n");
          const roles = identityText
            .split("\n")
            .filter((line) => line.includes(person.name) || /^\s*(职务|职称|职位)[：:]/u.test(line))
            .flatMap((line) => line.match(/院长|主任|教授|医生|医师|博士/gu) ?? []);
          if (identityText.includes(person.name)) {
            person.aliases.push(
              ...roles.flatMap((role) => [
                person.name.slice(0, 1) + role,
                person.name.slice(0, 2) + role,
              ]),
            );
          }
        }
        const keywords = [
          ...(Array.isArray(analysis.keywords) ? analysis.keywords : material.tags),
          ...entities.flatMap((entity) => [
            entity.name,
            ...(Array.isArray(entity.aliases) ? entity.aliases : []),
          ]),
        ].filter((word): word is string => typeof word === "string" && word.length >= 2);
        const description = [
          details.description,
          analysis.visualDescription,
          material.artifacts.length === 1 ? material.supplement : "",
        ]
          .filter((value) => typeof value === "string" && value)
          .join("\n")
          .slice(0, 4000);
        const frozen: FrozenImageAsset = {
          artifactId: artifact.id,
          materialId: material.id,
          objectKey: artifact.objectKey,
          checksum: artifact.checksum,
          mimeType: artifact.mimeType,
          description,
          usage: details.usage,
        };
        return [
          {
            people,
            keywords,
            personFocused: analysis.personFocused === true || analysis.identityRequired === true,
            candidate: {
              artifactId: artifact.id,
              materialId: material.id,
              title: material.title,
              description,
              fileName: artifact.originalFileName ?? material.title,
              usage: details.usage,
              enterpriseId: material.enterpriseId,
              frozen,
            },
          },
        ];
      }),
    );
    const people = [
      ...effectivePromotionFocus(configuredPeople, scope.enterpriseId),
      ...candidates.flatMap((item) => item.people),
    ];
    for (const person of people) {
      person.aliases = person.aliases.filter(
        (alias) =>
          !/^(?:副|业务)?(?:院长|主任|教授|医生|医师|博士)(?:医师)?$/u.test(
            alias.normalize("NFKC").trim(),
          ),
      );
    }
    const exactTargets = people.filter((person) =>
      matchesPromotionFocus(prompt, { name: person.name, aliases: [] }),
    );
    const confirmedTargets = people.filter((person) => matchesPromotionFocus(prompt, person));
    const shortTitleTargets = people.filter(
      (person) =>
        /^[\p{Script=Han}]{2,4}$/u.test(person.name) &&
        ["院长", "主任", "教授", "医生", "医师", "博士"].some((role) =>
          matchesPromotionFocus(prompt, {
            name: person.name.slice(0, 1) + role,
            aliases: [person.name.slice(0, 2) + role],
          }),
        ),
    );
    // Keep ambiguous people as candidates, but never treat their shared title as identity confirmation.
    const aliasOwners = new Map<string, Set<string>>();
    for (const person of people) {
      for (const alias of person.aliases) {
        const term = alias.normalize("NFKC").toLowerCase().trim();
        const owners = aliasOwners.get(term) ?? new Set<string>();
        owners.add(person.name);
        aliasOwners.set(term, owners);
      }
    }
    const ambiguousNames = new Set<string>();
    if (!exactTargets.length) {
      for (const [alias, owners] of aliasOwners) {
        if (owners.size > 1 && matchesPromotionFocus(prompt, { name: alias, aliases: [] })) {
          for (const name of owners) ambiguousNames.add(name);
        }
      }
      if (
        new Set(shortTitleTargets.map((person) => person.name)).size > 1 ||
        !confirmedTargets.length
      ) {
        for (const person of shortTitleTargets) ambiguousNames.add(person.name);
      }
    }
    const targets = exactTargets.length
      ? exactTargets
      : people.filter(
          (person) => confirmedTargets.includes(person) || ambiguousNames.has(person.name),
        );
    const matchedNames = new Set(
      targets.map((person) => person.name.normalize("NFKC").toLowerCase().trim()),
    );
    const query = prompt.normalize("NFKC").toLowerCase();
    const ranked = candidates
      .map(({ candidate, people: extractedPeople, keywords, personFocused }) => {
        const subjects = extractedPeople.length
          ? extractedPeople
          : people.filter((person) => matchesPromotionFocus(candidate.description, person));
        const namedMatch = subjects.some((person) =>
          matchedNames.has(person.name.normalize("NFKC").toLowerCase().trim()),
        );
        const personMismatch =
          targets.length > 0 && (subjects.length > 0 || personFocused) && !namedMatch;
        const keywordScore = [
          ...new Set(keywords.map((word) => word.normalize("NFKC").toLowerCase())),
        ].filter((word) => query.includes(word)).length;
        return {
          ...candidate,
          namedMatch,
          personMismatch,
          requiresConfirmation:
            candidate.usage === "REFERENCE" &&
            subjects.some((person) => ambiguousNames.has(person.name)),
          score:
            candidate.usage === "LOGO" || ((subjects.length > 0 || personFocused) && !namedMatch)
              ? 0
              : keywordScore + (namedMatch ? 5 : 0),
        };
      })
      .sort((a, b) => Number(b.namedMatch) - Number(a.namedMatch) || b.score - a.score);
    return { candidates: ranked, ambiguousNames, matchedNames };
  }

  async selectImageAssets(
    scope: RetrievalScope,
    prompt: string,
    referenceArtifactIds?: string[],
    logoArtifactId?: string | null,
    medical = false,
  ): Promise<FrozenImageAsset[]> {
    const { candidates } = await this.imageCandidates(scope, prompt, new Date(), medical);
    const references =
      referenceArtifactIds === undefined
        ? candidates.some((item) => item.requiresConfirmation)
          ? []
          : candidates.filter((item) => item.usage === "REFERENCE" && item.score > 0).slice(0, 1)
        : referenceArtifactIds.map((id) => {
            const candidate = candidates.find(
              (item) => item.artifactId === id && item.usage === "REFERENCE",
            );
            if (!candidate) throw new ConflictException("选中的参考图已不可用，请重新选择");
            if (candidate.personMismatch)
              throw new ConflictException("选中的人物参考图与本次主题不匹配，请重新选择");
            return candidate;
          });
    const availableLogos = candidates.filter((item) => item.usage === "LOGO");
    const enterpriseLogos = availableLogos.filter(
      (item) => item.enterpriseId === scope.enterpriseId,
    );
    const logos =
      logoArtifactId === null
        ? []
        : logoArtifactId
          ? availableLogos.filter((item) => item.artifactId === logoArtifactId)
          : (enterpriseLogos.length ? enterpriseLogos : availableLogos).slice(0, 8);
    if (logoArtifactId && !logos.length)
      throw new ConflictException("选中的品牌 Logo 已不可用，请重新选择");
    return [...references, ...logos].map((item) => item.frozen);
  }

  async imageOptions(scope: RetrievalScope, query: string) {
    const { candidates } = await this.imageCandidates(scope, query, new Date());
    return candidates
      .filter((candidate) => candidate.usage === "REFERENCE" && !candidate.personMismatch)
      .slice(0, 100)
      .map(({ artifactId, title, description }) => ({
        artifactId,
        title,
        description: description.slice(0, 700),
      }));
  }

  private async lexicalCandidates(
    scope: RetrievalScope,
    scopeKeys: string[],
    query: string,
    now: Date,
    limit: number,
    medical: boolean,
  ): Promise<LexicalRow[]> {
    return this.prisma.$queryRaw<LexicalRow[]>(Prisma.sql`
      WITH retrieval_query AS (
        SELECT websearch_to_tsquery('simple', ${query}) AS tsq, ${query}::text AS raw_query
      )
      SELECT
        chunk.id AS "chunkId",
        GREATEST(
          ts_rank_cd(chunk.search_vector, retrieval_query.tsq),
          similarity(chunk.text, retrieval_query.raw_query),
          ${
            medical
              ? Prisma.sql`similarity(COALESCE(material.structured_facts->'medicalMaterial'->>'question', ''), retrieval_query.raw_query)`
              : Prisma.sql`similarity(array_to_string(material.tags, ' '), retrieval_query.raw_query),
          similarity(COALESCE(material.structured_facts::text, ''), retrieval_query.raw_query)
          , CASE WHEN EXISTS (
            SELECT 1 FROM unnest(material.tags) AS tag
            WHERE length(tag) >= 2 AND position(lower(tag) in lower(retrieval_query.raw_query)) > 0
          ) THEN 0.8 ELSE 0 END`
          }
        )::double precision AS "lexicalScore"
      FROM material_chunks AS chunk
      JOIN materials AS material
        ON material.id = chunk.material_id
        AND material.tenant_id = chunk.tenant_id
        AND material.scope_key = chunk.scope_key
      CROSS JOIN retrieval_query
      WHERE chunk.tenant_id = ${scope.tenantId}
        AND chunk.scope_key IN (${Prisma.join(scopeKeys)})
        AND material.status = 'ACTIVE'::material_status
        AND material.authorization_status = 'AUTHORIZED'::material_authorization_status
        AND material.ingestion_status = 'READY'::material_ingestion_status
        AND material.usability_status = 'USABLE'::material_usability_status
        AND COALESCE(material.structured_facts->'medicalMaterial'->>'purpose', '') <> 'ARCHIVE'
        ${
          medical
            ? Prisma.sql`AND material.type IN ('TEXT', 'DOCUMENT', 'LINK')
        AND material.structured_facts->'medicalMaterial'->>'schemaVersion' = 'medical-material-v1'
        AND material.structured_facts->'medicalMaterial'->>'purpose' = 'ANSWER_EVIDENCE'`
            : Prisma.empty
        }
        AND (material.valid_from IS NULL OR material.valid_from <= ${now})
        AND (material.expires_at IS NULL OR material.expires_at > ${now})
      ORDER BY "lexicalScore" DESC, chunk.id ASC
      LIMIT ${limit}
    `);
  }

  private async vectorCandidates(
    scope: RetrievalScope,
    scopeKeys: string[],
    profileVersion: string,
    vector: readonly number[],
    now: Date,
    limit: number,
    medical: boolean,
  ): Promise<VectorRow[]> {
    if (vector.length === 0) return [];
    return this.prisma.$queryRaw<VectorRow[]>(Prisma.sql`
      WITH query_vector AS (
        SELECT ARRAY[${Prisma.join(vector)}]::double precision[] AS value
      )
      SELECT
        embedding.chunk_id AS "chunkId",
        GREATEST(
          0,
          LEAST(
            1,
            ("xhs_cosine_similarity"(embedding.vector, query_vector.value) + 1) / 2
          )
        )::double precision AS "vectorScore"
      FROM material_embeddings AS embedding
      JOIN materials AS material
        ON material.id = embedding.material_id
        AND material.tenant_id = embedding.tenant_id
        AND material.scope_key = embedding.scope_key
      CROSS JOIN query_vector
      WHERE embedding.tenant_id = ${scope.tenantId}
        AND embedding.scope_key IN (${Prisma.join(scopeKeys)})
        AND embedding.profile_version = ${profileVersion}
        AND embedding.dimension = ${vector.length}
        AND material.status = 'ACTIVE'::material_status
        AND material.authorization_status = 'AUTHORIZED'::material_authorization_status
        AND material.ingestion_status = 'READY'::material_ingestion_status
        AND material.usability_status = 'USABLE'::material_usability_status
        AND COALESCE(material.structured_facts->'medicalMaterial'->>'purpose', '') <> 'ARCHIVE'
        ${
          medical
            ? Prisma.sql`AND material.type IN ('TEXT', 'DOCUMENT', 'LINK')
        AND material.structured_facts->'medicalMaterial'->>'schemaVersion' = 'medical-material-v1'
        AND material.structured_facts->'medicalMaterial'->>'purpose' = 'ANSWER_EVIDENCE'`
            : Prisma.empty
        }
        AND (material.valid_from IS NULL OR material.valid_from <= ${now})
        AND (material.expires_at IS NULL OR material.expires_at > ${now})
      ORDER BY "vectorScore" DESC, embedding.chunk_id ASC
      LIMIT ${limit}
    `);
  }

  private async queryEmbedding(query: string, policy: RuntimePolicy) {
    if (!policy.embeddingModelId) {
      return {
        profileVersion: "deterministic-char-ngram-v1",
        vector: deterministicEmbedding(query),
        usage: { providerId: "local", modelId: "deterministic-char-ngram-v1", estimatedCost: 0 },
      };
    }
    const model = await this.prisma.modelDefinition.findFirst({
      include: { provider: { include: { activeCredential: true } } },
      where: {
        capabilities: { has: "EMBEDDING" },
        id: policy.embeddingModelId,
        provider: { status: "ACTIVE", synthetic: false },
        status: "ACTIVE",
        synthetic: false,
      },
    });
    const credential = model?.provider.activeCredential;
    if (!model || credential?.status !== "ACTIVE") {
      throw new Error("Configured platform embedding model is unavailable");
    }
    const apiKey = ModelCredentialCipher.fromEnvironment().decrypt(
      credential,
      modelCredentialAssociatedData(model.providerId, credential.id),
    );
    const provider = new OpenAICompatibleEmbeddingProvider({
      apiKey,
      baseUrl: model.provider.baseUrl,
      providerId: model.provider.id,
      timeoutMs: model.provider.timeoutMs,
    });
    const result = await provider.embed(model.externalModelId, [query], {
      inputKind: "QUERY",
      profile: resolveEmbeddingProfile(model),
    });
    const vector = result.vectors[0];
    if (!vector) throw new Error("Embedding provider returned no query vector");
    return {
      profileVersion: embeddingProfileVersion(model),
      vector: [...vector],
      usage: {
        providerId: model.providerId,
        modelId: model.externalModelId,
        inputUnits: result.usage.inputUnits,
        providerRequestId: result.providerRequestId,
        estimatedCost: embeddingCost(model.metadata, result.usage.inputUnits),
      },
    };
  }
}

function embeddingCost(
  metadata: Prisma.JsonValue | null,
  units: number | undefined,
): number | null {
  const price = assetRecord(metadata).inputCostPerMillionUnits;
  return typeof price === "number" && Number.isFinite(price) && price >= 0 && units !== undefined
    ? (price * units) / 1_000_000
    : null;
}

function eligibleMaterialWhere(now: Date) {
  return {
    AND: [
      { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    ],
    authorizationStatus: "AUTHORIZED" as const,
    ingestionStatus: "READY" as const,
    usabilityStatus: "USABLE" as const,
    status: "ACTIVE" as const,
  };
}

function buildQuery(
  prompt: string,
  enterprise: Readonly<{
    brandName: string | null;
    city: string | null;
    industry: string | null;
    name: string;
  }> | null,
  geoEntities: readonly Readonly<{
    aliases: string[];
    name: string;
    topics: readonly Readonly<{ intent: string; question: string }>[];
  }>[],
): string {
  return [
    prompt,
    enterprise?.name,
    enterprise?.brandName,
    enterprise?.industry,
    enterprise?.city,
    ...geoEntities.flatMap((entity) => [
      entity.name,
      ...entity.aliases,
      ...entity.topics.flatMap((topic) => [topic.intent, topic.question]),
    ]),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .slice(0, 8_000);
}

function structuredMatchScore(
  query: string,
  tags: readonly string[],
  facts: Prisma.JsonValue | null,
): number {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const values = [...tags, facts ? JSON.stringify(facts) : ""]
    .map((value) => value.normalize("NFKC").toLocaleLowerCase().trim())
    .filter(Boolean);
  if (values.length === 0) return 0;
  const matches = values.filter(
    (value) => normalized.includes(value) || value.includes(normalized),
  ).length;
  return clamp(matches / Math.min(values.length, 4));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
