// Verify deployed code and schema without committing test users, presets or audit records.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const runtimeRoot = process.env.API_RUNTIME_ROOT || resolve(__dirname, "../../apps/api");
const apiRequire = createRequire(resolve(runtimeRoot, "package.json"));
apiRequire("reflect-metadata");
const compiled = (name) => apiRequire(resolve(runtimeRoot, "dist", name));
const { Module, UnauthorizedException } = apiRequire("@nestjs/common");
const { NestFactory } = apiRequire("@nestjs/core");
const { PrismaClient, Prisma } = apiRequire("@xhs-agentic/database");
const { configureApplication } = compiled("configure-application.js");
const { GenerationStyleController } = compiled("platform-settings/generation-style.controller.js");
const { GenerationStyleService } = compiled("platform-settings/generation-style.service.js");
const { RequestAccessContext } = compiled("access/request-access-context.js");
const { AdminTokenAuthenticator } = compiled("access/admin-token-authenticator.js");
const { PrismaService } = compiled("database/prisma.service.js");
const prisma = new PrismaClient();
const rollback = new Error("ROLLBACK_GENERATION_STYLE_VERIFICATION");
let report;
async function main() {
  const columns = await prisma.$queryRawUnsafe(
    "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'",
  );
  const known = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
  const missing = Prisma.dmmf.datamodel.models.flatMap((model) =>
    model.fields
      .filter(
        (field) =>
          field.kind !== "object" &&
          !known.has(`${model.dbName || model.name}.${field.dbName || field.name}`),
      )
      .map((field) => `${model.dbName || model.name}.${field.dbName || field.name}`),
  );
  assert.deepEqual(missing, [], "Deployed API schema must match the database");
  try {
    await prisma.$transaction(
      async (tx) => {
        const admin = await tx.adminUser.create({
          data: { phone: `style-probe-${randomUUID().slice(0, 12)}` },
        });
        const access = new RequestAccessContext();
        access.initialize({
          audience: "SAAS_ADMIN",
          userId: admin.id,
          scope: { type: "PLATFORM" },
          permissions: ["platform.settings.manage"],
        });
        const database = new Proxy(tx, {
          get(target, key) {
            return key === "$transaction" ? (run) => run(tx) : Reflect.get(target, key);
          },
        });
        const service = new GenerationStyleService(database, access);
        class ProbeModule {}
        Module({
          controllers: [GenerationStyleController],
          providers: [
            RequestAccessContext,
            { provide: GenerationStyleService, useValue: service },
            {
              provide: AdminTokenAuthenticator,
              useValue: {
                authenticate: async (authorization) => {
                  if (authorization !== "Bearer style-verification")
                    throw new UnauthorizedException();
                  return { userId: admin.id };
                },
              },
            },
            {
              provide: PrismaService,
              useValue: {
                roleBinding: {
                  findMany: async () => [
                    {
                      role: { permissions: [{ permission: { code: "platform.settings.manage" } }] },
                    },
                  ],
                },
              },
            },
          ],
        })(ProbeModule);
        process.env.ADMIN_WEB_ORIGIN = "http://127.0.0.1:3101";
        const app = await NestFactory.create(ProbeModule, {
          logger: false,
          abortOnError: false,
          bodyParser: false,
        });
        try {
          configureApplication(app);
          await app.listen(0, "127.0.0.1");
          const url = `${await app.getUrl()}/platform/generation-styles`;
          const request = async (body, authenticated = true) => {
            const response = await fetch(url, {
              method: body ? "POST" : "GET",
              headers: {
                "Content-Type": "application/json",
                ...(authenticated ? { Authorization: "Bearer style-verification" } : {}),
              },
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
            return { status: response.status, body: await response.json() };
          };
          const initial = await request();
          assert.equal(initial.status, 200);
          assert.ok(initial.body.contentDirections.length && initial.body.imageStyles.length);
          const frozen = await service.snapshot({});
          const snapshotBefore = JSON.stringify(frozen);
          const input = structuredClone(initial.body);
          input.copyBasePrompt += "\n验证文案要求，事务回滚后不保留。";
          input.imageStyles.forEach((preset) => {
            preset.isDefault = false;
          });
          const id = `probe-${randomUUID()}`;
          input.imageStyles.unshift({
            id,
            name: `验证摄影-${id.slice(-8)}`,
            description: "仅事务内验证",
            prompt: "采用自然柔和的摄影光线，突出主题。",
            enabled: true,
            isDefault: true,
          });
          const saved = await request(input);
          assert.equal(saved.status, 200, JSON.stringify(saved.body));
          assert.equal(saved.body.version, input.version + 1);
          assert.equal((await service.snapshot({})).imageStyle.id, id);
          assert.equal(
            (await service.snapshot({ imageStylePresetId: id })).copyBasePrompt,
            input.copyBasePrompt,
          );
          assert.equal(JSON.stringify(frozen), snapshotBefore);
          assert.equal((await request(input)).status, 409);
          const invalid = structuredClone(saved.body);
          invalid.imageStyles[0].prompt = "";
          assert.equal((await request(invalid)).status, 400);
          assert.equal((await request({ ...saved.body, unexpected: true })).status, 400);
          const disabled = structuredClone(saved.body);
          disabled.imageStyles.find((preset) => preset.id === frozen.imageStyle.id).enabled = false;
          assert.equal((await request(disabled)).status, 200);
          const options = await service.options();
          assert.ok(!options.imageStyles.some((preset) => preset.id === frozen.imageStyle.id));
          assert.ok(options.imageStyles.every((preset) => !("prompt" in preset)));
          assert.ok(options.contentDirections.every((preset) => !("prompt" in preset)));
          assert.equal((await request(undefined, false)).status, 401);
          report = {
            result: "PASS",
            schemaCompatible: true,
            compiledHttpReadAndSave: true,
            nestedValidation: true,
            staleWritesRejected: true,
            defaultSelection: true,
            explicitSelection: true,
            disabledOptionsFiltered: true,
            enterprisePromptsHidden: true,
            existingSnapshotUnchanged: true,
            unauthorizedRejected: true,
            existingContentDirections: initial.body.contentDirections.length,
            existingImageStyles: initial.body.imageStyles.length,
          };
        } finally {
          await app.close();
        }
        throw rollback;
      },
      { timeout: 25000 },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
  assert.ok(report);
  console.log(JSON.stringify({ ...report, allTestWritesRolledBack: true }));
}
main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        result: "FAIL",
        name: error.name,
        code: error.code,
        message: "Style release verification failed; sensitive details suppressed",
      }),
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
