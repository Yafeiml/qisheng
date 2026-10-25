import { afterEach, describe, expect, it } from "vitest";
import { allowedOrigins } from "./configure-application";

const originalNodeEnv = process.env.NODE_ENV;
const originalAdminWebOrigin = process.env.ADMIN_WEB_ORIGIN;

afterEach(() => {
  restoreEnvironment("NODE_ENV", originalNodeEnv);
  restoreEnvironment("ADMIN_WEB_ORIGIN", originalAdminWebOrigin);
});

describe("allowedOrigins", () => {
  it("accepts both localhost spellings for the development admin web", () => {
    process.env.NODE_ENV = "development";
    process.env.ADMIN_WEB_ORIGIN = "http://127.0.0.1:3101";

    expect(allowedOrigins()).toEqual(["http://127.0.0.1:3101", "http://localhost:3101"]);
  });

  it("does not expand configured production origins", () => {
    process.env.NODE_ENV = "production";
    process.env.ADMIN_WEB_ORIGIN = "https://admin.example.com";

    expect(allowedOrigins()).toEqual(["https://admin.example.com"]);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
