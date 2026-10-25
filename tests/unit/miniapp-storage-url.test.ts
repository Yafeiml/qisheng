import { describe, expect, it } from "vitest";
import { getApiBaseUrl, storageObjectUrl } from "../../apps/employee-miniapp/utils/api";

describe("employee miniapp private storage URLs", () => {
  it("uses the configured API origin for local preview and download URLs", () => {
    expect(storageObjectUrl("/api/storage/objects/payload.signature")).toBe(
      `${getApiBaseUrl()}/storage/objects/payload.signature`,
    );
  });

  it.each([
    "https://storage.example.test/image.png?signed=fixture",
    "https://cdn.example.test/assets/signed-token",
    "data:image/png;base64,fixture",
    "/another/path",
  ])("keeps other image URLs unchanged: %s", (value) => {
    expect(storageObjectUrl(value)).toBe(value);
  });
});
