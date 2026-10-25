// Exercise the compiled controller over HTTP; TypeScript-only tests miss erased DTO imports.
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const runtimeRoot = process.env.API_RUNTIME_ROOT || resolve(__dirname, "../../apps/api");
const apiRequire = createRequire(resolve(runtimeRoot, "package.json"));
apiRequire("reflect-metadata");
const { Module, UnauthorizedException } = apiRequire("@nestjs/common");
const { NestFactory } = apiRequire("@nestjs/core");
const compiled = (path) => apiRequire(resolve(runtimeRoot, "dist", path));
const { configureApplication } = compiled("configure-application.js");
const { PlatformSettingsController } = compiled(
  "platform-settings/platform-settings.controller.js",
);
const { AdminTokenAuthenticator } = compiled("access/admin-token-authenticator.js");
const { RequestAccessContext } = compiled("access/request-access-context.js");
const { PrismaService } = compiled("database/prisma.service.js");
const { PlatformContentSafetyService } = compiled(
  "platform-settings/platform-content-safety.service.js",
);
const saves = [];
const serviceNames = [
  ["platform-settings.service.js", "PlatformSettingsService"],
  ["admin-sms-settings.service.js", "AdminSmsSettingsService"],
  ["platform-publication-verification.service.js", "PlatformPublicationVerificationService"],
  ["publication-policy-evidence.service.js", "PublicationPolicyEvidenceService"],
];
class SmokeModule {}
Module({
  controllers: [PlatformSettingsController],
  providers: [
    RequestAccessContext,
    ...serviceNames.map(([file, name]) => ({
      provide: compiled(`platform-settings/${file}`)[name],
      useValue: {},
    })),
    {
      provide: PlatformContentSafetyService,
      useValue: {
        save: (input) => {
          saves.push(input);
          return { ...input, verified: false };
        },
      },
    },
    {
      provide: AdminTokenAuthenticator,
      useValue: {
        authenticate: async (authorization) => {
          if (authorization !== "Bearer smoke-platform-admin") throw new UnauthorizedException();
          return { userId: "smoke-platform-admin" };
        },
      },
    },
    {
      provide: PrismaService,
      useValue: {
        roleBinding: {
          findMany: async () => [
            { role: { permissions: [{ permission: { code: "platform.settings.manage" } }] } },
          ],
        },
      },
    },
  ],
})(SmokeModule);

async function main() {
  process.env.ADMIN_WEB_ORIGIN = "http://127.0.0.1:3101";
  const app = await NestFactory.create(SmokeModule, {
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });
  try {
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    const url = `${await app.getUrl()}/platform/settings/content-safety`;
    const post = async (body, authenticated = true) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authenticated ? { Authorization: "Bearer smoke-platform-admin" } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const selection = {
      mode: "MODEL",
      modelProviderId: "smoke-provider",
      model: "codex-gpt-5.6-sol",
      timeoutMs: 90000,
    };
    const saved = await post(selection);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body, { ...selection, verified: false });
    const http = await post({
      mode: "HTTP",
      provider: "smoke-safety",
      endpoint: "https://example.com/audit",
      apiKey: "smoke-only-key",
      timeoutMs: 30000,
    });
    assert.equal(http.status, 200);
    for (const invalid of [
      { ...selection, mode: "UNKNOWN" },
      { ...selection, timeoutMs: 999 },
      { ...selection, timeoutMs: 120001 },
      { ...selection, model: 123 },
      { ...selection, unexpected: true },
    ]) {
      const response = await post(invalid);
      assert.equal(response.status, 400);
      assert.equal(response.body.code, "VALIDATION_FAILED");
    }
    assert.equal((await post(selection, false)).status, 401);
    assert.equal(saves.length, 2, "Rejected requests must never reach the save service");
    console.log(
      JSON.stringify({
        result: "PASS",
        checks: 8,
        model: selection.model,
        compiledHttpSave: true,
        invalidInputsRejected: true,
        unauthenticatedRejected: true,
      }),
    );
  } finally {
    await app.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
