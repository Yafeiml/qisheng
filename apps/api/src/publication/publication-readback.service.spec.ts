import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestAccessContext } from "../access/request-access-context";
import type { PrismaService } from "../database/prisma.service";
import type { PublicationReadbackConfigurationService } from "../platform-settings/publication-readback.configuration";
import type { TenantCapabilityService } from "../resource-policy/tenant-capability.service";
import type { ReadbackResultDto } from "./publication-readback.dto";
import { PublicationReadbackService } from "./publication-readback.service";
import { managedReadbackNodeKey } from "./publication-readback-node-key";
import { PublicationShortUrlError, resolvePublicationShortUrl } from "./publication-short-url";
import { normalizePublicationUrl } from "./publication-url";

vi.mock("./publication-short-url", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./publication-short-url")>()),
  resolvePublicationShortUrl: vi.fn(),
}));
vi.mock("./publication-readback-node-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./publication-readback-node-key")>()),
  managedReadbackNodeKey: vi.fn().mockReturnValue(null),
}));

const shortUrl = "https://xhslink.cn/o/Short123";
const noteUrl = "https://www.xiaohongshu.com/explore/000000000000000000000001";

function fixture(url = shortUrl) {
  vi.mocked(managedReadbackNodeKey).mockReturnValue(null);
  vi.stubEnv("PUBLICATION_READBACK_ENABLED", "true");
  const target = normalizePublicationUrl(url);
  const candidate = {
    id: "job12345",
    submissionId: "submission12345",
    status: "QUEUED",
    dueAt: new Date(Date.now() - 1_000),
    submission: {
      canonicalKey: target.canonicalKey,
      normalizedUrl: target.normalizedUrl,
      rawUrl: `笔记分享 ${url} 复制这段话进入小红书`,
      status: "VERIFYING",
    },
  };
  const prisma = {
    publicationCollectorState: { findUnique: vi.fn().mockResolvedValue(null) },
    publicationCollectorRequestNonce: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    publicationCollectionJob: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([candidate]),
      findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    publicationReadbackBudget: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    publicationReadbackNode: { findMany: vi.fn().mockResolvedValue([]) },
    publishSubmission: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (run: (tx: unknown) => unknown) => run(prisma));
  const configuration = {
    enabled: vi
      .fn()
      .mockImplementation(async () => process.env.PUBLICATION_READBACK_ENABLED === "true"),
    recoverExpiredLeases: vi.fn(),
    runtime: vi.fn().mockImplementation(async () => ({
      enabled: process.env.PUBLICATION_READBACK_ENABLED === "true",
      externalMode: true,
      verified: true,
      endpoint: "https://collector.example.com/detail",
      token: "private-provider-token",
    })),
  };
  const service = new PublicationReadbackService(
    prisma as unknown as PrismaService,
    {} as RequestAccessContext,
    {} as TenantCapabilityService,
    configuration as unknown as PublicationReadbackConfigurationService,
  );
  return { candidate, prisma, service, configuration };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("readback node panel links", () => {
  it("refunds a not-yet-delivered lease and returns it to manual review if readback is disabled during claim", async () => {
    const { service, configuration, prisma } = fixture(noteUrl);
    configuration.runtime.mockResolvedValueOnce({
      enabled: true,
      verified: true,
      externalMode: true,
      endpoint: "https://collector.example.com/detail",
      token: "private-provider-token",
    });
    configuration.runtime.mockResolvedValueOnce({
      enabled: false,
      verified: true,
      externalMode: false,
      endpoint: "https://collector.example.com/detail",
      token: "private-provider-token",
    });
    expect(await service.claim("external-node")).toMatchObject({ paused: true, job: null });
    expect(prisma.publicationReadbackBudget.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: { decrement: 1 } } }),
    );
    expect(prisma.publicationCollectionJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_REVIEW", attempts: { decrement: 1 } }),
      }),
    );
    expect(prisma.publishSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "MANUAL_REVIEW" }) }),
    );
  });
  it("keeps disabled readback quiet and never considers it a main-service outage", async () => {
    const { service } = fixture();
    vi.stubEnv("PUBLICATION_READBACK_ENABLED", "false");
    await expect(service.health()).resolves.toMatchObject({
      paused: true,
      reason: "READBACK_DISABLED",
      alert: null,
    });
  });

  it("returns provider credentials only to a managed identity that actually receives a job", async () => {
    const { service } = fixture(noteUrl);
    vi.mocked(managedReadbackNodeKey).mockReturnValue("managed-key".repeat(8));
    await expect(service.claimManaged("external-node")).rejects.toThrow("同机回读节点");
    const result = await service.claimManaged("selfhost-readback");
    expect(result).toMatchObject({
      provider: { token: "private-provider-token" },
      job: { noteId: "000000000000000000000001" },
    });
    const plain = await service.claim("external-node");
    expect(plain).not.toHaveProperty("provider");
    expect(JSON.stringify(plain)).not.toContain("private-provider-token");
  });

  it("never returns provider credentials for paused, unverified or idle managed claims", async () => {
    const { service, configuration, prisma } = fixture(noteUrl);
    vi.mocked(managedReadbackNodeKey).mockReturnValue("managed-key".repeat(8));
    configuration.runtime.mockResolvedValueOnce({
      enabled: true,
      verified: false,
      externalMode: false,
      endpoint: "https://collector.example.com/detail",
      token: "private-provider-token",
    });
    expect(await service.claimManaged("selfhost-readback")).toMatchObject({
      paused: true,
      job: null,
      provider: null,
    });
    expect(prisma.publicationReadbackBudget.updateMany).not.toHaveBeenCalled();
    prisma.publicationCollectionJob.findMany.mockResolvedValue([]);
    expect(await service.claimManaged("selfhost-readback")).toMatchObject({
      job: null,
      provider: null,
    });
  });
  it.each([
    ["http://localhost:23110/", "localhost"],
    ["http://192.168.1.20:8080/", "192.168.1.20"],
    ["https://collector.example.com:8443/", "collector.example.com"],
    ["http://[::1]:13110/", "[::1]"],
  ])("shows a node's reported panel URL %s", async (panelUrl, panelHost) => {
    const { prisma, service } = fixture();
    vi.stubEnv("PUBLICATION_READBACK_NODE_KEYS_JSON", JSON.stringify({ node123: "secret" }));
    prisma.publicationCollectionJob.findMany.mockResolvedValue([]);
    prisma.publicationReadbackNode.findMany.mockResolvedValue([
      { id: "node123", panelUrl, panelHost: "100.64.0.1", lastSeenAt: new Date() },
    ]);
    expect((await service.adminOperations()).nodes).toMatchObject([
      { id: "node123", panelUrl, panelHost, online: true },
    ]);
  });

  it("keeps valid historical IPv4 links and excludes invalid stored addresses", async () => {
    const { prisma, service } = fixture();
    vi.stubEnv(
      "PUBLICATION_READBACK_NODE_KEYS_JSON",
      JSON.stringify({ node123: "secret", node456: "secret", node789: "secret" }),
    );
    prisma.publicationCollectionJob.findMany.mockResolvedValue([]);
    prisma.publicationReadbackNode.findMany.mockResolvedValue([
      { id: "node123", panelUrl: null, panelHost: "127.0.0.1", lastSeenAt: new Date() },
      {
        id: "node456",
        panelUrl: "javascript:alert(1)",
        panelHost: "invalid-host",
        lastSeenAt: new Date(),
      },
      {
        id: "node789",
        panelUrl: "https://user:pass@collector.example.com/",
        panelHost: null,
        lastSeenAt: new Date(),
      },
    ]);
    expect((await service.adminOperations()).nodes).toMatchObject([
      { id: "node123", panelUrl: "http://127.0.0.1:13110/", panelHost: "127.0.0.1" },
      { id: "node456", panelUrl: null, panelHost: null },
      { id: "node789", panelUrl: null, panelHost: null },
    ]);
  });
});

describe("readback short-link claim", () => {
  it("stores the canonical identity before reserving a paid lease, without changing submission time", async () => {
    const { candidate, prisma, service } = fixture();
    vi.mocked(resolvePublicationShortUrl).mockResolvedValue(normalizePublicationUrl(noteUrl));
    const outcome = await service.claim("node12345");
    expect(outcome.job).toMatchObject({ id: candidate.id, noteId: "000000000000000000000001" });
    expect(resolvePublicationShortUrl).toHaveBeenCalledWith(candidate.submission.rawUrl);
    expect(prisma.publishSubmission.updateMany).toHaveBeenCalledWith({
      data: {
        canonicalKey: "xhs:note:000000000000000000000001",
        normalizedUrl: noteUrl,
        resolvedUrl: noteUrl,
      },
      where: {
        id: candidate.submissionId,
        status: "VERIFYING",
        canonicalKey: candidate.submission.canonicalKey,
        normalizedUrl: candidate.submission.normalizedUrl,
        collectionJobs: {
          some: { id: candidate.id, kind: "READBACK", status: "QUEUED", leaseToken: null },
        },
      },
    });
    expect(prisma.publishSubmission.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.publicationReadbackBudget.updateMany.mock.invocationCallOrder[0] ?? 0,
    );
    expect(JSON.stringify(outcome)).not.toContain("xhslink");
  });

  it("does not reserve a paid lease if the submission changed during expansion", async () => {
    const { prisma, service } = fixture();
    vi.mocked(resolvePublicationShortUrl).mockResolvedValue(normalizePublicationUrl(noteUrl));
    prisma.publishSubmission.updateMany.mockResolvedValue({ count: 0 });
    expect((await service.claim("node12345")).job).toBeNull();
    expect(prisma.publicationReadbackBudget.updateMany).not.toHaveBeenCalled();
    expect(prisma.publicationCollectionJob.updateMany).not.toHaveBeenCalled();
  });

  it("quarantines an unresolved link without reserving a paid lease and expands at most one per claim", async () => {
    const { candidate, prisma, service } = fixture();
    prisma.publicationCollectionJob.findMany.mockResolvedValue([
      candidate,
      { ...candidate, id: "job67890", submissionId: "submission67890" },
    ]);
    vi.mocked(resolvePublicationShortUrl).mockRejectedValue(
      new PublicationShortUrlError("SHORT_URL_TARGET_INVALID"),
    );
    expect((await service.claim("node12345")).job).toBeNull();
    expect(resolvePublicationShortUrl).toHaveBeenCalledTimes(1);
    expect(prisma.publicationReadbackBudget.updateMany).not.toHaveBeenCalled();
    expect(prisma.publicationCollectionJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NEEDS_REVIEW",
          errorCode: "SHORT_URL_TARGET_INVALID",
        }),
      }),
    );
    expect(prisma.publishSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "MANUAL_REVIEW" }) }),
    );
  });

  it("keeps the existing long-link claim path without an extra identity update", async () => {
    const { prisma, service } = fixture(noteUrl);
    expect((await service.claim("node12345")).job).toMatchObject({
      noteId: "000000000000000000000001",
    });
    expect(resolvePublicationShortUrl).not.toHaveBeenCalled();
    expect(prisma.publishSubmission.updateMany).not.toHaveBeenCalled();
    expect(prisma.publicationReadbackBudget.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("in-flight results after disabling automatic readback", () => {
  function resultFixture() {
    const { prisma, service, configuration } = fixture(noteUrl);
    configuration.enabled.mockResolvedValue(false);
    const job = {
      id: "paid-job",
      kind: "READBACK",
      status: "LEASED",
      attempts: 1,
      submissionId: "submission12345",
      leaseOwner: "selfhost-readback",
      leaseToken: "00000000-0000-4000-8000-000000000001",
      leaseExpiresAt: new Date(Date.now() + 60000),
      dueAt: new Date(Date.now() - 60000),
      submission: {
        status: "VERIFYING",
        normalizedUrl: noteUrl,
        tenantId: "tenant",
        task: {
          id: "task",
          campaignId: "campaign",
          enterpriseId: "enterprise",
          campaign: { selectionSnapshot: null },
          membership: { publisherContext: null },
          employeeContent: { title: "原始文案", body: "原始文案正文", hashtags: [], images: [] },
        },
      },
    };
    const findUnique = vi.fn().mockResolvedValue(job);
    const jobUpdate = vi.fn();
    const submissionUpdate = vi.fn();
    const snapshotCreate = vi.fn();
    const pause = vi.fn();
    Object.assign(prisma.publicationCollectionJob, { findUnique, update: jobUpdate });
    Object.assign(prisma.publishSubmission, { update: submissionUpdate });
    Object.assign(prisma.publicationCollectorState, { upsert: pause });
    Object.assign(prisma, {
      publishedContentRegistry: { findUnique: vi.fn().mockResolvedValue(null) },
      publishReadbackSnapshot: { create: snapshotCreate },
      auditLog: { create: vi.fn() },
    });
    const input: ReadbackResultDto = {
      leaseToken: job.leaseToken,
      status: "RETRYABLE",
      source: "TEST_PROVIDER",
      code: "HTTP_TIMEOUT",
    };
    return {
      service,
      prisma,
      configuration,
      job,
      input,
      jobUpdate,
      submissionUpdate,
      snapshotCreate,
      pause,
    };
  }

  it.each(["RETRYABLE", "AUTH_ERROR", "UNCONFIRMED"] as const)(
    "sends a delivered %s result to manual review without requeueing or pausing a disabled provider",
    async (status) => {
      const { service, job, input, jobUpdate, submissionUpdate, pause } = resultFixture();
      expect(await service.result(job.leaseOwner, job.id, { ...input, status })).toEqual({
        status: "NEEDS_REVIEW",
      });
      expect(jobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "NEEDS_REVIEW" }),
        }),
      );
      expect(jobUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "QUEUED" }),
        }),
      );
      expect(submissionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "MANUAL_REVIEW" }),
        }),
      );
      expect(pause).not.toHaveBeenCalled();
    },
  );

  it("preserves a successful paid response from an original active lease while retaining content review", async () => {
    const { service, job, input, snapshotCreate, submissionUpdate } = resultFixture();
    Object.assign(service, {
      capabilities: { current: vi.fn().mockResolvedValue({ metricsIntegrationEnabled: true }) },
    });
    expect(
      await service.result(job.leaseOwner, job.id, {
        ...input,
        status: "AVAILABLE",
        code: "OK",
        observedAt: new Date().toISOString(),
        note: {
          noteId: "000000000000000000000001",
          title: "另一篇内容",
          body: "与原任务完全不同的正文",
          imageCount: 0,
          likes: 8,
          comments: 1,
          favorites: 2,
        },
      }),
    ).toEqual({ status: "NEEDS_REVIEW" });
    expect(snapshotCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ likes: 8, comments: 1, favorites: 2 }),
      }),
    );
    expect(submissionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "MANUAL_REVIEW", extractedTitle: "另一篇内容" }),
      }),
    );
  });

  it("keeps bounded retry behavior when automatic readback remains enabled", async () => {
    const { service, configuration, job, input, jobUpdate } = resultFixture();
    configuration.enabled.mockResolvedValue(true);
    expect(await service.result(job.leaseOwner, job.id, input)).toEqual({ status: "RETRYABLE" });
    expect(jobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "QUEUED", leaseToken: null }),
      }),
    );
  });
});
