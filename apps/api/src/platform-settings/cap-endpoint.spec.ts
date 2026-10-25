import { ConflictException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { normalizeCapEndpoint } from "./cap-endpoint";
import { platformSettingDefinition } from "./platform-setting-catalog";
import { validatePlatformSettingValue } from "./platform-setting-values";

describe("Cap endpoint configuration", () => {
  it("normalizes the external service and keeps existing loopback sites compatible", () => {
    expect(normalizeCapEndpoint(" https://cap.example.com/site-key ")).toBe(
      "https://cap.example.com/site-key/",
    );
    for (const endpoint of [
      "https://cap.example.com/site_key/",
      "http://127.0.0.1:3022/test-site/",
      "http://[::1]:3022/test-site/",
    ]) {
      expect(normalizeCapEndpoint(endpoint)).toBe(endpoint);
    }
  });

  it("rejects malformed URLs, remote HTTP, credentials and extra URL components", () => {
    for (const endpoint of [
      "not-a-url",
      "https:cap.example.com/site/",
      "http://cap.example.com/site/",
      "http://localhost:3022/site/",
      "ftp://cap.example.com/site/",
      "https://user:password@cap.example.com/site/",
      "https://@cap.example.com/site/",
      "https://cap.example.com/",
      "https://cap.example.com/site/extra/",
      "https://cap.example.com/site/../other/",
      "https://cap.example.com/site%2fother/",
      "https://cap.example.com/site/?secret=value",
      "https://cap.example.com/site/?",
      "https://cap.example.com/site/#fragment",
      "https://cap.example.com/site/#",
      "https://cap.example.com\\site/",
    ]) {
      expect(() => normalizeCapEndpoint(endpoint)).toThrow(ConflictException);
    }
  });

  it("validates catalog writes and retains a missing configuration until explicitly configured", () => {
    const definition = platformSettingDefinition("security.cap_endpoint");
    if (!definition) throw new Error("Missing Cap endpoint setting");
    expect(definition.defaultValue).toBeNull();
    expect(validatePlatformSettingValue(definition, null)).toBeNull();
    expect(validatePlatformSettingValue(definition, "")).toBe("");
    expect(validatePlatformSettingValue(definition, "https://cap.example.com/site")).toBe(
      "https://cap.example.com/site/",
    );
    expect(() => validatePlatformSettingValue(definition, "https://cap.example.com/")).toThrow(
      ConflictException,
    );
  });
});
