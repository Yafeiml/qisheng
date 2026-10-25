import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { GenerationLabInput } from "@xhs-agentic/ai-gateway";
import type { Prisma } from "@xhs-agentic/database";
import sharp from "sharp";
import { RequestAccessContext } from "../access/request-access-context";
import {
  MedicalPlanningService,
  medicalInternalBrief,
  medicalRetrievalQuery,
} from "../campaign/medical-planning.service";
import { ContentService } from "../content/content.service";
import {
  assertFrozenImageAssetsCurrent,
  freezeGenerationInput,
  freezeIndustryGenerationGuidance,
} from "../content/freeze-generation-input";
import { MaterialRetrievalService } from "../content/material-retrieval.service";
import { PrismaService } from "../database/prisma.service";
import { ModelConfigurationService } from "../model-configuration/model-configuration.service";
import { GenerationStyleService } from "../platform-settings/generation-style.service";
import { PlatformObjectStorageService } from "../platform-settings/platform-object-storage.service";
import type { LabCheckDto, LabExecuteDto, LabPromoteDto } from "./generation-lab.dto";

const assetSelect = {
  id: true,
  kind: true,
  description: true,
  mimeType: true,
  checksum: true,
} as const;
const include = {
  assets: { select: assetSelect },
  calls: { orderBy: { createdAt: "asc" as const } },
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class GenerationLabService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly access: RequestAccessContext,
    @Inject(MaterialRetrievalService) private readonly retrieval: MaterialRetrievalService,
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(GenerationStyleService) private readonly styles: GenerationStyleService,
    @Inject(ModelConfigurationService) private readonly models: ModelConfigurationService,
    @Inject(PlatformObjectStorageService) private readonly storage: PlatformObjectStorageService,
    @Inject(MedicalPlanningService) private readonly medicalPlanning?: MedicalPlanningService,
  ) {}

  private principal() {
    const user = this.access.requireSaasAdmin();
    if (user.scope.type !== "PLATFORM" || !user.permissions.includes("platform.model.manage"))
      throw new ForbiddenException("仅平台模型管理员可使用生成测试台");
    return user;
  }
  private async enterprise(id: string) {
    const row = await this.prisma.enterprise.findFirst({
      where: { id, status: "ACTIVE", tenant: { status: "ACTIVE" } },
      select: { id: true, tenantId: true, name: true, industry: true },
    });
    if (!row) throw new NotFoundException("企业不存在或已停用");
    return row;
  }
  async options(search = "") {
    this.principal();
    const [enterprises, styles] = await Promise.all([
      this.prisma.enterprise.findMany({
        where: {
          status: "ACTIVE",
          tenant: { status: "ACTIVE" },
          ...(search
            ? { name: { contains: search.slice(0, 100), mode: "insensitive" as const } }
            : {}),
        },
        select: { id: true, name: true, tenant: { select: { name: true } } },
        orderBy: { name: "asc" },
        take: 100,
      }),
      this.styles.platformCurrent(),
    ]);
    return { enterprises, styles };
  }
  async medicalOptions(enterpriseId: string) {
    this.principal();
    const enterprise = await this.enterprise(enterpriseId);
    if (!this.medicalPlanning) throw new ConflictException("医疗计划服务不可用");
    const options = await this.medicalPlanning.options({
      tenantId: enterprise.tenantId,
      enterpriseId,
    });
    const images = await this.retrieval.imageOptions(
      { tenantId: enterprise.tenantId, enterpriseId },
      options.topics.map(({ question }) => question).join("；"),
    );
    const members = await this.prisma.enterpriseMembership.findMany({
      where: {
        tenantId: enterprise.tenantId,
        enterpriseId,
        status: { in: ["ACTIVE", "PENDING_BIND"] },
        seatStatus: "ENABLED",
      },
      select: { id: true, name: true, publisherContext: true },
      take: 5000,
    });
    return { ...options, members, images };
  }
  async list(cursor?: string) {
    this.principal();
    return this.prisma.generationLabRun.findMany({
      where: { status: { not: "ARCHIVED" } },
      select: {
        id: true,
        title: true,
        status: true,
        action: true,
        enterpriseId: true,
        parentId: true,
        createdAt: true,
        reviewStatus: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 40,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }
  async get(id: string) {
    this.principal();
    const row = await this.prisma.generationLabRun.findUnique({ where: { id }, include });
    if (!row || row.status === "ARCHIVED") throw new NotFoundException("测试版本不存在");
    return row;
  }
  async check(input: LabCheckDto) {
    const user = this.principal();
    const enterprise = await this.enterprise(input.enterpriseId);
    const scope = { enterpriseId: enterprise.id, tenantId: enterprise.tenantId };
    const medicalPlan = this.medicalPlanning
      ? await this.medicalPlanning.resolve(scope, {
          selection: input.selection,
          membershipIds: input.membershipIds,
          referenceArtifactIds: input.referenceArtifactIds,
          prompt: input.brief,
          contentDirectionPresetId: input.contentDirectionPresetId,
          imageStylePresetId: input.imageStylePresetId,
        })
      : null;
    const brief = medicalPlan ? medicalInternalBrief(medicalPlan) : (input.brief ?? "");
    if (!brief) throw new BadRequestException("请填写测试要求");
    const query = medicalPlan
      ? medicalRetrievalQuery(medicalPlan)
      : input.keywords?.trim() || brief;
    const [generationStyle, route] = await Promise.all([
      this.styles.snapshot(medicalPlan ? undefined : input),
      this.models.freezeGenerationRoute(
        scope.tenantId,
        scope.enterpriseId,
        !medicalPlan || medicalPlan.imageMode === "ILLUSTRATION",
      ),
    ]);
    if (route.synthetic) throw new ConflictException("测试台需要真实模型路由，请先完成模型配置");
    const snapshot = {
      industryGuidance: await freezeIndustryGenerationGuidance(this.prisma, enterprise.industry),
      ...(medicalPlan ? { medicalPlan, selectionSnapshot: medicalPlan } : {}),
      brief,
      keywords: medicalPlan ? "" : (input.keywords ?? ""),
      enterpriseName: enterprise.name,
      generationStyle,
      retrieval: { query, hits: [], images: [] },
      imageAssets: [],
      materialSummary: "",
      geoSummary: "",
      sensitiveRuleSummary: "",
      sensitiveRules: [],
      sourceContext: { materialCheckFailed: true },
      seed: randomUUID(),
      route: {
        ...route,
        maxAttemptsPerModel: 1,
        text: { ...route.text, fallbacks: [] },
        image: { ...route.image, fallbacks: [] },
      },
    };
    const run = await this.prisma.generationLabRun.create({
      data: {
        ...scope,
        createdBy: user.userId,
        title: input.title,
        status: "CHECKING",
        input: json(snapshot),
      },
    });
    const call = await this.prisma.generationLabCall.create({
      data: {
        runId: run.id,
        kind: "RETRIEVAL",
        providerId: "material-retrieval",
        modelId: "pending",
        request: { query },
        usage: { estimatedCost: null },
      },
    });
    const started = Date.now();
    try {
      const retrieval = await this.retrieval.retrieve(scope, query);
      if (medicalPlan && !retrieval.hits.length)
        throw new ConflictException("所选问题缺少有效回答依据；环境照片和存档资料不能代替依据");
      await this.prisma.generationLabCall.update({
        where: { id: call.id },
        data: {
          status: "SUCCEEDED",
          latencyMs: Date.now() - started,
          providerId: retrieval.embeddingUsage?.providerId ?? "material-retrieval",
          modelId: retrieval.embeddingUsage?.modelId ?? retrieval.strategyVersion,
          request: { query: retrieval.query },
          usage: json(retrieval.embeddingUsage ?? { estimatedCost: null, note: "检索用量未知" }),
        },
      });
      const [context, imageAssets] = await Promise.all([
        this.content.generationContext(
          scope.tenantId,
          scope.enterpriseId,
          new Date(),
          [...new Set(retrieval.hits.map((h) => h.materialId))],
          retrieval.focusEntityIds ?? [],
        ),
        this.retrieval.selectImageAssets(
          scope,
          query,
          medicalPlan ? (input.referenceArtifactIds ?? []) : undefined,
          medicalPlan ? null : undefined,
        ),
      ]);
      await this.prisma.generationLabRun.updateMany({
        where: { id: run.id, status: "CHECKING" },
        data: {
          status: "DRAFT",
          input: json({
            ...snapshot,
            ...freezeGenerationInput(context, retrieval, generationStyle),
            retrieval,
            imageAssets,
          }),
        },
      });
    } catch {
      // Preserve the attempt, even when material retrieval fails after a billable embedding call.
      await this.prisma.generationLabCall.updateMany({
        where: { id: call.id, status: "STARTED" },
        data: {
          status: "FAILED",
          latencyMs: Date.now() - started,
          error: "素材检索未完成，未自动重试；供应商费用可能已发生",
        },
      });
      await this.prisma.generationLabRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          error: "素材检查未完成，请核对检索模型配置后新建测试",
          input: json({ ...snapshot, sourceContext: { materialCheckFailed: true } }),
        },
      });
    }
    return this.get(run.id);
  }
  async fork(id: string) {
    const user = this.principal();
    const previous = await this.get(id);
    if (
      ["CHECKING", "QUEUED", "RUNNING"].includes(previous.status) ||
      ["QUEUED", "RUNNING"].includes(previous.reviewStatus)
    )
      throw new ConflictException("请等待当前测试完成");
    await this.enterprise(previous.enterpriseId);
    const snapshot = previous.input as unknown as GenerationLabInput;
    if (snapshot.sourceContext?.materialCheckFailed)
      throw new ConflictException("素材检查未完成，请新建测试重新检查");
    const result = previous.result as { copy?: GenerationLabInput["copy"] } | null;
    return this.prisma.$transaction(async (tx) => {
      const assets = await tx.generationLabAsset.findMany({
        where: { runId: id, kind: "REFERENCE" },
      });
      return tx.generationLabRun.create({
        data: {
          title: previous.title,
          createdBy: user.userId,
          enterpriseId: previous.enterpriseId,
          tenantId: previous.tenantId,
          parentId: id,
          input: json({ ...snapshot, copy: result?.copy ?? snapshot.copy }),
          assets: {
            create: assets.map(({ kind, bytes, checksum, mimeType, description }) => ({
              kind,
              bytes,
              checksum,
              mimeType,
              description,
            })),
          },
        },
        include,
      });
    });
  }
  async execute(id: string, input: LabExecuteDto) {
    const run = await this.get(id);
    if (run.status !== "DRAFT") throw new ConflictException("此版本已提交，请复制版本再进行测试");
    await this.enterprise(run.enterpriseId);
    const snapshot = run.input as unknown as GenerationLabInput;
    if (
      snapshot.medicalPlan &&
      (input.copy ||
        input.logoArtifactId ||
        (input.copyBasePrompt !== undefined &&
          input.copyBasePrompt !== snapshot.generationStyle.copyBasePrompt) ||
        (input.imageBasePrompt !== undefined &&
          input.imageBasePrompt !== snapshot.generationStyle.imageBasePrompt) ||
        (input.contentDirectionPrompt !== undefined &&
          input.contentDirectionPrompt !== snapshot.generationStyle.contentDirection.prompt) ||
        (input.imageStylePrompt !== undefined &&
          input.imageStylePrompt !== snapshot.generationStyle.imageStyle.prompt))
    )
      throw new ConflictException(
        "医疗测试使用冻结选择计划，不能提交手写文案、Logo 或修改提示词旁路",
      );
    if (input.action === "IMAGE" && !input.copy && !snapshot.copy)
      throw new BadRequestException("请先生成或填写文案与图片提示词");
    const imageAssets = await this.retrieval.selectImageAssets(
      { tenantId: run.tenantId, enterpriseId: run.enterpriseId },
      snapshot.medicalPlan
        ? medicalRetrievalQuery(snapshot.medicalPlan)
        : snapshot.keywords || snapshot.brief,
      input.referenceArtifactIds,
      snapshot.medicalPlan ? null : input.logoArtifactId || undefined,
      Boolean(snapshot.medicalPlan),
    );
    // Reuse frozen identity/descriptions when continuing a version, after checking availability.
    for (let index = 0; index < imageAssets.length; index++) {
      const asset = imageAssets[index];
      const frozenAsset = snapshot.imageAssets.find((a) => a.artifactId === asset?.artifactId);
      if (!asset || !frozenAsset) continue;
      if (asset.checksum !== frozenAsset.checksum || asset.objectKey !== frozenAsset.objectKey)
        throw new ConflictException("参考图片已发生变化，请重新检查素材");
      imageAssets[index] = frozenAsset;
    }
    if (input.logoArtifactId === "")
      imageAssets.splice(0, imageAssets.length, ...imageAssets.filter((a) => a.usage !== "LOGO"));
    if (
      snapshot.medicalPlan &&
      JSON.stringify(imageAssets.map(({ artifactId }) => artifactId).sort()) !==
        JSON.stringify(snapshot.imageAssets.map(({ artifactId }) => artifactId).sort())
    )
      throw new ConflictException("医疗测试更换素材需要新建计划重新核验");
    const frozen: GenerationLabInput = {
      ...snapshot,
      imageAssets,
      copy: input.copy ?? snapshot.copy,
      generationStyle: {
        ...snapshot.generationStyle,
        copyBasePrompt: input.copyBasePrompt ?? snapshot.generationStyle.copyBasePrompt,
        imageBasePrompt: input.imageBasePrompt ?? snapshot.generationStyle.imageBasePrompt,
        contentDirection: {
          ...snapshot.generationStyle.contentDirection,
          prompt: input.contentDirectionPrompt ?? snapshot.generationStyle.contentDirection.prompt,
        },
        imageStyle: {
          ...snapshot.generationStyle.imageStyle,
          prompt: input.imageStylePrompt ?? snapshot.generationStyle.imageStyle.prompt,
        },
      },
    };
    await this.prisma.$transaction(async (tx) => {
      if (snapshot.medicalPlan) {
        if (!this.medicalPlanning) throw new ConflictException("医疗计划服务不可用");
        await this.medicalPlanning.assertCurrent(
          tx,
          { tenantId: run.tenantId, enterpriseId: run.enterpriseId },
          snapshot.medicalPlan,
        );
        await assertFrozenImageAssetsCurrent(
          tx,
          { tenantId: run.tenantId, enterpriseId: run.enterpriseId },
          imageAssets,
        );
      }
      // Serialize upload, removal and submission; never let an upload slip into a running job.
      const changed = await tx.generationLabRun.updateMany({
        where: { id, status: "DRAFT" },
        data: { status: "QUEUED", action: input.action, input: json(frozen) },
      });
      if (changed.count !== 1) throw new ConflictException("此版本已提交");
      const count = await tx.generationLabAsset.count({ where: { runId: id, kind: "REFERENCE" } });
      if (count + imageAssets.filter((a) => a.usage === "REFERENCE").length > 3)
        throw new BadRequestException("临时图片和资料库参考图合计最多 3 张");
    });
    return this.get(id);
  }
  async review(id: string) {
    const run = await this.get(id);
    await this.enterprise(run.enterpriseId);
    if (run.status !== "SUCCEEDED" || !run.assets.some((a) => a.kind === "POSTER"))
      throw new ConflictException("请先完成文案和海报，再审核完整结果");
    const updated = await this.prisma.generationLabRun.updateMany({
      where: { id, status: "SUCCEEDED", reviewStatus: "NONE" },
      data: { reviewStatus: "QUEUED" },
    });
    if (updated.count !== 1) throw new ConflictException("本版本已提交过审核，不会重复调用");
    return this.get(id);
  }
  async upload(id: string, file: { buffer: Buffer } | undefined, description: string) {
    const run = await this.get(id);
    if ((run.input as unknown as GenerationLabInput).medicalPlan)
      throw new ConflictException("医疗原图必须从有授权和隐私确认的素材库选择，不支持临时图旁路");
    if (!file?.buffer.length) throw new BadRequestException("请选择图片");
    let bytes: Buffer;
    try {
      const image = sharp(file.buffer, { limitInputPixels: 25_000_000, animated: false });
      const meta = await image.metadata();
      if (!["jpeg", "png", "webp"].includes(meta.format ?? "") || (meta.pages ?? 1) > 1)
        throw new Error("Unsupported image");
      bytes = await image
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      if (bytes.length > 4 * 1024 * 1024) throw new Error("Image too large");
    } catch {
      throw new BadRequestException("请使用 4 MB 以内的 JPG、PNG 或 WebP 静态图片");
    }
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.generationLabRun.updateMany({
        where: { id, status: "DRAFT" },
        data: { updatedAt: new Date() },
      });
      if (locked.count !== 1) throw new ConflictException("只能修改未提交的测试版本");
      if ((await tx.generationLabAsset.count({ where: { runId: id, kind: "REFERENCE" } })) >= 3)
        throw new BadRequestException("临时参考图最多 3 张");
      await tx.generationLabAsset.create({
        data: {
          runId: id,
          kind: "REFERENCE",
          description,
          bytes: new Uint8Array(bytes),
          checksum: createHash("sha256").update(bytes).digest("hex"),
          mimeType: "image/png",
        },
      });
    });
    return this.get(id);
  }
  async removeAsset(id: string, assetId: string) {
    await this.get(id);
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.generationLabRun.updateMany({
        where: { id, status: "DRAFT" },
        data: { updatedAt: new Date() },
      });
      if (!locked.count) throw new ConflictException("只能修改未提交的测试版本");
      await tx.generationLabAsset.deleteMany({
        where: { id: assetId, runId: id, kind: "REFERENCE" },
      });
    });
    return this.get(id);
  }
  async image(id: string, assetId: string) {
    const run = await this.get(id);
    const asset = await this.prisma.generationLabAsset.findFirst({
      where: { runId: id, id: assetId },
    });
    if (asset) return Buffer.from(asset.bytes);
    const snapshot = run.input as unknown as GenerationLabInput;
    const candidate = snapshot.retrieval.images?.find((a) => a.artifactId === assetId);
    if (!candidate) throw new NotFoundException("图片不存在");
    // Revalidate scope/capability/authorization; never accept an arbitrary object key.
    const [selected] = await this.retrieval
      .selectImageAssets(
        { tenantId: run.tenantId, enterpriseId: run.enterpriseId },
        snapshot.medicalPlan
          ? medicalRetrievalQuery(snapshot.medicalPlan)
          : snapshot.keywords || snapshot.brief,
        candidate.usage === "REFERENCE" ? [assetId] : [],
        candidate.usage === "LOGO" ? assetId : undefined,
        Boolean(snapshot.medicalPlan),
      )
      .then((rows) => rows.filter((a) => a.artifactId === assetId));
    if (!selected) throw new NotFoundException("图片已不可用");
    const { storage } = await this.storage.current();
    const bytes = await storage.get(selected.objectKey, 25 * 1024 * 1024);
    return sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  }
  async archive(id: string) {
    const user = this.principal();
    await this.get(id);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.generationLabRun.updateMany({
        where: {
          id,
          status: { notIn: ["CHECKING", "QUEUED", "RUNNING"] },
          reviewStatus: { notIn: ["QUEUED", "RUNNING"] },
        },
        data: { status: "ARCHIVED" },
      });
      if (!updated.count) throw new ConflictException("运行中不能归档");
      await tx.generationLabAsset.deleteMany({ where: { runId: id } });
      await tx.auditLog.create({
        data: {
          action: "generation-lab.archive",
          actorType: "USER",
          actorUserId: user.userId,
          resourceType: "GenerationLabRun",
          resourceId: id,
        },
      });
    });
    return { archived: true };
  }
  async promote(id: string, input: LabPromoteDto) {
    const user = this.principal();
    if (!user.permissions.includes("platform.settings.manage"))
      throw new ForbiddenException("需要平台设置管理权限");
    const run = await this.get(id);
    if (run.status !== "SUCCEEDED") throw new ConflictException("仅能保存已完成的测试配置");
    const snapshot = run.input as unknown as GenerationLabInput;
    if (snapshot.medicalPlan && input.kind === "TEMPLATE")
      throw new ConflictException("医疗选择模板请在企业活动规划中保存；测试提示词不能替代医疗选择");
    const config = await this.styles.platformCurrent();
    if (config.version !== input.version)
      throw new ConflictException("线上配置已更新，请刷新后再确认保存");
    if (input.kind === "TEMPLATE") {
      await this.enterprise(run.enterpriseId);
      // Templates can reference only saved presets; unsaved test prompts must be promoted first.
      const style = snapshot.generationStyle;
      for (const [kind, selected] of [
        ["contentDirections", style.contentDirection],
        ["imageStyles", style.imageStyle],
      ] as const) {
        if (
          !config[kind].some(
            (p) => p.id === selected.id && p.enabled && p.prompt === selected.prompt,
          )
        )
          throw new ConflictException("请先保存调整后的内容方向/图片风格，再使用对应预设创建模板");
      }
      const row = await this.prisma.$transaction(async (tx) => {
        const template = await tx.campaignTemplate.create({
          data: {
            tenantId: run.tenantId,
            enterpriseId: run.enterpriseId,
            createdBy: user.userId,
            name: input.name,
            title: run.title,
            prompt: snapshot.brief,
            imageCount: 1,
            contentDirection: style.contentDirection.name,
            imageStyle: style.imageStyle.name,
            contentDirectionPresetId: style.contentDirection.id,
            imageStylePresetId: style.imageStyle.id,
          },
        });
        await tx.auditLog.create({
          data: {
            actorType: "USER",
            actorUserId: user.userId,
            action: "generation-lab.promote-template",
            resourceType: "CampaignTemplate",
            resourceId: template.id,
            metadata: { runId: id },
          },
        });
        return template;
      });
      return { id: row.id };
    }
    if (input.kind === "GLOBAL")
      return this.styles.save({
        ...config,
        copyBasePrompt: snapshot.generationStyle.copyBasePrompt,
        imageBasePrompt: snapshot.generationStyle.imageBasePrompt,
      });
    const kind = input.kind === "CONTENT" ? "contentDirections" : "imageStyles";
    const prompt =
      input.kind === "CONTENT"
        ? snapshot.generationStyle.contentDirection.prompt
        : snapshot.generationStyle.imageStyle.prompt;
    if (config[kind].length >= 40) throw new ConflictException("预设已达 40 项上限");
    return this.styles.save({
      ...config,
      [kind]: [
        ...config[kind],
        {
          id: `lab-${randomUUID()}`,
          name: input.name,
          description: "生成测试台验证后保存",
          prompt,
          enabled: true,
          isDefault: false,
        },
      ],
    });
  }
}
