import { describe, expect, it, vi } from "vitest";
import { assertFrozenImageAssetsCurrent } from "./freeze-generation-input";

const scope = { tenantId: "tenant", enterpriseId: "enterprise" };
const image = {
  artifactId: "photo",
  materialId: "material",
  objectKey: "tenant/photo",
  checksum: "abc",
  mimeType: "image/png",
  description: "授权场景",
  usage: "REFERENCE" as const,
  privacyConfirmed: true,
  authorizationConfirmed: true,
};
const policy = {
  schemaVersion: "medical-material-v1",
  purpose: "REAL_SCENE",
  sceneType: "ENVIRONMENT",
  privacyConfirmed: true,
};
const row = {
  id: "photo",
  materialId: "material",
  objectKey: "tenant/photo",
  checksum: "abc",
  mimeType: "image/png",
  metadata: { usage: "REFERENCE", usabilityStatus: "USABLE", medicalMaterial: policy },
  material: { structuredFacts: { medicalMaterial: policy } },
};
describe("medical frozen image revalidation", () => {
  it("does not query or reserve image work for a question card", async () => {
    const findMany = vi.fn();
    await assertFrozenImageAssetsCurrent({ materialArtifact: { findMany } } as never, scope, []);
    expect(findMany).not.toHaveBeenCalled();
  });
  it("revalidates tenant, authorization and validity, then requires identical object identity", async () => {
    const findMany = vi.fn().mockResolvedValue([row]);
    await assertFrozenImageAssetsCurrent({ materialArtifact: { findMany } } as never, scope, [
      image,
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant",
          material: expect.objectContaining({
            authorizationStatus: "AUTHORIZED",
            status: "ACTIVE",
            type: "IMAGE_REFERENCE",
          }),
        }),
      }),
    );
    findMany.mockResolvedValue([{ ...row, checksum: "new-version" }]);
    await expect(
      assertFrozenImageAssetsCurrent({ materialArtifact: { findMany } } as never, scope, [image]),
    ).rejects.toThrow("版本或内容");
  });
  it("rejects a revoked, unavailable or expired source", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await expect(
      assertFrozenImageAssetsCurrent({ materialArtifact: { findMany } } as never, scope, [image]),
    ).rejects.toThrow("授权");
  });
  it.each([
    ["unclassified historical parent", { material: { structuredFacts: null } }],
    [
      "archived parent",
      { material: { structuredFacts: { medicalMaterial: { ...policy, purpose: "ARCHIVE" } } } },
    ],
    [
      "parent privacy withdrawal",
      {
        material: { structuredFacts: { medicalMaterial: { ...policy, privacyConfirmed: false } } },
      },
    ],
    [
      "unclassified historical attachment",
      { metadata: { usage: "REFERENCE", usabilityStatus: "USABLE" } },
    ],
    [
      "archived attachment",
      { metadata: { ...row.metadata, medicalMaterial: { ...policy, purpose: "ARCHIVE" } } },
    ],
    [
      "attachment privacy withdrawal",
      { metadata: { ...row.metadata, medicalMaterial: { ...policy, privacyConfirmed: false } } },
    ],
    ["attachment needs input", { metadata: { ...row.metadata, usabilityStatus: "NEEDS_INPUT" } }],
    ["attachment became a logo", { metadata: { ...row.metadata, usage: "LOGO" } }],
    ["attachment MIME changed", { mimeType: "image/jpeg" }],
  ])(
    "rejects %s even when the stored object and checksum are unchanged",
    async (_name, changed) => {
      const findMany = vi.fn().mockResolvedValue([{ ...row, ...changed }]);
      await expect(
        assertFrozenImageAssetsCurrent({ materialArtifact: { findMany } } as never, scope, [image]),
      ).rejects.toThrow("预检后发生变化");
    },
  );
  it.each([
    { ...image, privacyConfirmed: false },
    { ...image, authorizationConfirmed: false },
    { ...image, privacyConfirmed: undefined },
    { ...image, usage: "LOGO" as const },
  ])("requires frozen source confirmations and reference usage", async (asset) => {
    const findMany = vi.fn().mockResolvedValue([row]);
    await expect(
      assertFrozenImageAssetsCurrent({ materialArtifact: { findMany } } as never, scope, [asset]),
    ).rejects.toThrow("预检后发生变化");
  });
});
