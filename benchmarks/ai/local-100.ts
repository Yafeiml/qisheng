import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { PrismaClient } from "@xhs-agentic/database";
import { GenerationRuntime } from "../../apps/worker/src/generation-runtime";
import { S3CompatibleObjectStorage } from "../../packages/object-storage/src";

const apiBase = process.env.PILOT_LOCAL_API_BASE ?? "http://127.0.0.1:3100";
const marker = `${Date.now()}`.slice(-6);

async function run(): Promise<void> {
  const startedAt = performance.now();
  const platformAuth = await request("/auth/dev/admin-token", {
    body: { phone: process.env.DEV_PLATFORM_ADMIN_PHONE ?? "13800000000" },
    method: "POST",
  });
  const platformToken = stringField(platformAuth, "accessToken");
  const tenant = await request("/platform/tenants", {
    body: { customerType: "SINGLE_ENTERPRISE", name: `Pilot 100 ${marker}` },
    method: "POST",
    token: platformToken,
  });
  const tenantId = stringField(tenant, "id");
  const enterprise = await request(`/platform/tenants/${tenantId}/enterprises`, {
    body: { code: `pilot-${marker}`, name: `Pilot 100 企业 ${marker}` },
    method: "POST",
    token: platformToken,
  });
  const enterpriseId = stringField(enterprise, "id");
  const adminPhone = `166${marker}99`;
  await request(`/platform/tenants/${tenantId}/admins`, {
    body: { phone: adminPhone },
    method: "POST",
    token: platformToken,
  });
  const tenantAuth = await request("/auth/dev/admin-token", {
    body: { phone: adminPhone },
    method: "POST",
  });
  const tenantToken = stringField(tenantAuth, "accessToken");
  const members = Array.from({ length: 100 }, (_, index) => ({
    employeeNo: `PILOT-${index + 1}`,
    name: `试点员工 ${index + 1}`,
    phone: `155${marker}${index.toString().padStart(2, "0")}`,
  }));
  const imported = await request(
    `/console/tenants/${tenantId}/enterprises/${enterpriseId}/memberships/import`,
    { body: { members }, method: "POST", token: tenantToken },
  );
  const memberships = arrayField(imported, "memberships");
  await parallelMap(memberships, 10, async (membership) => {
    await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/memberships/${stringField(membership, "id")}/enable`,
      { body: { reason: "Pilot 100 benchmark" }, method: "POST", token: tenantToken },
    );
  });
  await request(`/console/tenants/${tenantId}/enterprises/${enterpriseId}/materials`, {
    body: {
      authorizationConfirmed: true,
      content:
        "全飞秒 Pro 测试素材：传播应说明专业设备、规范术前评估和个体差异，不得承诺绝对效果。",
      tags: ["全飞秒Pro", "设备", "评估"],
      title: "Pilot 100 已授权测试素材",
      type: "TEXT",
    },
    method: "POST",
    token: tenantToken,
  });
  await waitForEffectiveMaterial({ enterpriseId, tenantId, token: tenantToken });
  const campaignCreatedAt = performance.now();
  const campaign = await request(
    `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns`,
    {
      body: {
        prompt: "生成全飞秒 Pro 小红书风格科普，侧重设备、规范评估和理性选择，不做绝对效果承诺。",
        title: `Pilot 100 生成基准 ${marker}`,
        visibleAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      method: "POST",
      token: tenantToken,
    },
  );
  const campaignRequestMs = performance.now() - campaignCreatedAt;
  const campaignId = stringField(campaign, "id");
  let detail = campaign;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (["GENERATION_FAILED", "REVIEW_PENDING"].includes(stringField(detail, "status"))) break;
    await delay(500);
    detail = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseId}/campaigns/${campaignId}`,
      { token: tenantToken },
    );
  }
  if (stringField(detail, "status") !== "REVIEW_PENDING") {
    throw new Error(`Pilot campaign did not succeed: ${stringField(detail, "status")}`);
  }
  const contents = arrayField(detail, "employeeContents");
  const runs = arrayField(detail, "generationRuns");
  const run = record(runs[0]);
  const workItems = arrayField(run, "workItems");
  const invocationCount = await countModelInvocations({ campaignId, tenantId });
  const storedImageCount = await countStoredImages({ campaignId, tenantId });
  const images = contents.flatMap((content) => arrayField(record(content), "images"));
  const checksums = images.map((image) => stringField(image, "checksum"));
  const perceptualHashes = images.map((image) => stringField(image, "perceptualHash"));
  const deliveredChecksums = new Set<string>();
  await parallelMap(images, 10, async (image) => {
    const row = record(image);
    const response = await fetch(stringField(row, "imageUrl"));
    if (!response.ok) {
      throw new Error(`Stored image delivery failed with HTTP ${response.status}`);
    }
    const checksum = createHash("sha256")
      .update(Buffer.from(await response.arrayBuffer()))
      .digest("hex");
    if (checksum !== stringField(row, "checksum")) {
      throw new Error("Delivered image bytes do not match the database checksum");
    }
    deliveredChecksums.add(checksum);
  });
  const succeededWorkItems = workItems.filter(
    (item) => stringField(item, "status") === "SUCCEEDED",
  );
  const failedWorkItems = workItems.filter((item) => stringField(item, "status") === "FAILED");
  const latencies = workItems
    .map((item) => {
      const row = record(item);
      return (
        new Date(stringField(row, "finishedAt")).getTime() -
        new Date(stringField(row, "startedAt")).getTime()
      );
    })
    .sort((left, right) => left - right);
  const duplicateReplay = await verifySucceededReplay({ campaignId, tenantId });
  const report = {
    benchmark: "pilot-local-bullmq-postgres-minio-100",
    campaignId,
    deliveredImages: deliveredChecksums.size,
    duplicateReplay,
    exactUniqueImages: new Set(checksums).size,
    generated: contents.length,
    invocations: invocationCount,
    latencyMs: {
      campaignGeneration: performance.now() - campaignCreatedAt,
      campaignRequest: campaignRequestMs,
      p50WorkItem: percentile(latencies, 0.5),
      p95WorkItem: percentile(latencies, 0.95),
      setupAndGeneration: performance.now() - startedAt,
    },
    perceptualUniqueImages: new Set(perceptualHashes).size,
    requested: 100,
    storedImages: storedImageCount,
    synthetic: true,
    tenantId,
    warning: "LOCAL_SYNTHETIC_LOAD_TEST_NOT_VALID_FOR_REAL_PROVIDER_QUALITY_OR_COST",
    workItems: {
      failed: failedWorkItems.length,
      retried: workItems.filter((item) => numberField(item, "attemptCount") > 1).length,
      succeeded: succeededWorkItems.length,
      totalAttempts: workItems.reduce<number>(
        (total, item) => total + numberField(item, "attemptCount"),
        0,
      ),
    },
  };
  if (
    report.generated !== 100 ||
    report.exactUniqueImages !== 100 ||
    report.perceptualUniqueImages !== 100 ||
    report.storedImages !== 100 ||
    report.deliveredImages !== 100 ||
    report.workItems.succeeded !== 100 ||
    report.workItems.failed !== 0 ||
    report.latencyMs.campaignRequest >= 800 ||
    !report.duplicateReplay.noOp
  ) {
    throw new Error(`Pilot 100 invariants failed: ${JSON.stringify(report)}`);
  }
  await mkdir(".artifacts", { recursive: true });
  await writeFile(".artifacts/pilot-local-100-report.json", `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function verifySucceededReplay(input: { campaignId: string; tenantId: string }) {
  const prisma = new PrismaClient();
  const storage = new S3CompatibleObjectStorage({
    accessKeyId: requiredEnv("OBJECT_STORAGE_ACCESS_KEY"),
    bucket: requiredEnv("OBJECT_STORAGE_BUCKET"),
    endpoint: requiredEnv("OBJECT_STORAGE_ENDPOINT"),
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false",
    region: requiredEnv("OBJECT_STORAGE_REGION"),
    secretAccessKey: requiredEnv("OBJECT_STORAGE_SECRET_KEY"),
  });
  try {
    const workItem = await prisma.generationWorkItem.findFirstOrThrow({
      orderBy: { createdAt: "asc" },
      where: { campaignId: input.campaignId, status: "SUCCEEDED", tenantId: input.tenantId },
    });
    const before = await replaySnapshot(prisma, input.campaignId, input.tenantId);
    const runtime = new GenerationRuntime(prisma, storage);
    const lease = await runtime.claimWorkItem(
      workItem.id,
      input.tenantId,
      workItem.queueVersion,
      "pilot-replay-check",
    );
    if (lease) await runtime.generateWorkItem(lease);
    const after = await replaySnapshot(prisma, input.campaignId, input.tenantId);
    return {
      after,
      before,
      noOp: lease === null && JSON.stringify(before) === JSON.stringify(after),
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function countModelInvocations(input: {
  campaignId: string;
  tenantId: string;
}): Promise<number> {
  const prisma = new PrismaClient();
  try {
    return await prisma.modelInvocation.count({ where: input });
  } finally {
    await prisma.$disconnect();
  }
}

async function countStoredImages(input: { campaignId: string; tenantId: string }): Promise<number> {
  const prisma = new PrismaClient();
  try {
    return await prisma.generatedImage.count({
      where: { ...input, storageKey: { not: null } },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function replaySnapshot(prisma: PrismaClient, campaignId: string, tenantId: string) {
  const [contents, images, tasks] = await Promise.all([
    prisma.employeeContent.count({ where: { campaignId, tenantId } }),
    prisma.generatedImage.count({ where: { campaignId, tenantId } }),
    prisma.distributionTask.count({ where: { campaignId, tenantId } }),
  ]);
  return {
    contents,
    images,
    tasks,
  };
}

async function request(
  path: string,
  options: { body?: unknown; method?: string; token?: string } = {},
): Promise<Record<string, unknown>> {
  const method = options.method ?? "GET";
  const response = await fetch(`${apiBase}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET" ? {} : { "Idempotency-Key": `pilot-100-${randomUUID()}` }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    method,
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(payload)}`);
  return record(payload);
}

async function parallelMap<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value !== undefined) await operation(value);
      }
    }),
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object response");
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  const result = record(value)[field];
  if (typeof result !== "string") throw new Error(`Expected string field: ${field}`);
  return result;
}

function arrayField(value: unknown, field: string): unknown[] {
  const result = record(value)[field];
  if (!Array.isArray(result)) throw new Error(`Expected array field: ${field}`);
  return result;
}

function numberField(value: unknown, field: string): number {
  const result = record(value)[field];
  if (typeof result !== "number") throw new Error(`Expected number field: ${field}`);
  return result;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForEffectiveMaterial(input: {
  enterpriseId: string;
  tenantId: string;
  token: string;
}): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const workspace = await request(
      `/console/tenants/${input.tenantId}/enterprises/${input.enterpriseId}/workspace`,
      { token: input.token },
    );
    if (numberField(record(workspace.counts), "effectiveMaterials") > 0) return;
    await delay(250);
  }
  throw new Error("Pilot material ingestion did not become ready within 30 seconds");
}

function requiredEnv(
  name:
    | "OBJECT_STORAGE_ACCESS_KEY"
    | "OBJECT_STORAGE_BUCKET"
    | "OBJECT_STORAGE_ENDPOINT"
    | "OBJECT_STORAGE_REGION"
    | "OBJECT_STORAGE_SECRET_KEY",
): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Pilot 100 benchmark failed"}\n`,
  );
  process.exitCode = 1;
});
