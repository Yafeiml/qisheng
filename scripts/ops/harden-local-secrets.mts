import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@xhs-agentic/database";
import { isProductionRandomSecret } from "../../apps/api/src/platform-settings/production-secret.js";
import {
  ModelCredentialCipher,
  modelCredentialAssociatedData,
} from "../../packages/ai-gateway/src/credential-cipher.js";
import { planLocalEnvironment, replaceEnvValues } from "./local-secret-helpers.js";

// Local-only maintenance: no provider calls, no automatic daemon stop/start, no secret output.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = resolve(root, ".env");
const source = readFileSync(envFile, "utf8");
const plan = planLocalEnvironment(source);
function parseDatabaseUrl() {
  try {
    return new URL(plan.environment.DATABASE_URL ?? "");
  } catch {
    throw new Error("Invalid local database URL; inspect .env without printing its credentials");
  }
}
const databaseUrl = parseDatabaseUrl();
if (
  !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
  databaseUrl.pathname !== "/dev_xhs_agentic" ||
  (databaseUrl.port && databaseUrl.port !== "5432")
)
  throw new Error("This maintenance command only supports the local dev_xhs_agentic database");
for (const name of [
  "DATABASE_URL",
  "MODEL_CREDENTIAL_ENCRYPTION_KEY",
  "MODEL_CREDENTIAL_ENCRYPTION_KEY_VERSION",
]) {
  if (process.env[name] && process.env[name] !== plan.environment[name])
    throw new Error(`Resolve shell/.env override before maintenance: ${name}`);
}
const prisma = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
const oldCipher = ModelCredentialCipher.fromEnvironment(plan.environment);
const newCipher = ModelCredentialCipher.fromEnvironment({ ...plan.environment, ...plan.changes });
const actor = "local-release-preparation";
type Database = Pick<
  PrismaClient,
  "modelProviderCredential" | "platformSetting" | "directoryConnection"
>;
type RecordToRotate = {
  kind: "model" | "setting" | "directory";
  id: string;
  aad: string;
  envelope: {
    ciphertext: Uint8Array;
    authenticationTag: Uint8Array;
    initializationVector: Uint8Array;
    keyVersion: string;
  };
};

async function records(db: Database): Promise<RecordToRotate[]> {
  const [models, settings, directories] = await Promise.all([
    db.modelProviderCredential.findMany(),
    db.platformSetting.findMany({ where: { ciphertext: { not: null } } }),
    db.directoryConnection.findMany(),
  ]);
  return [
    ...models.map(
      (r): RecordToRotate => ({
        kind: "model",
        id: r.id,
        aad: modelCredentialAssociatedData(r.providerId, r.id),
        envelope: r,
      }),
    ),
    ...settings.map((r): RecordToRotate => {
      if (!r.ciphertext || !r.authenticationTag || !r.initializationVector || !r.keyVersion)
        throw new Error(`Incomplete encrypted setting: ${r.key}`);
      return {
        kind: "setting",
        id: r.key,
        aad: `xhs-agentic:platform-setting:${r.key}`,
        envelope: {
          ciphertext: r.ciphertext,
          authenticationTag: r.authenticationTag,
          initializationVector: r.initializationVector,
          keyVersion: r.keyVersion,
        },
      };
    }),
    ...directories.map(
      (r): RecordToRotate => ({
        kind: "directory",
        id: r.id,
        aad: `xhs-agentic:directory:${r.tenantId}:connection:${r.id}`,
        envelope: {
          ciphertext: r.credentialCiphertext,
          authenticationTag: r.credentialAuthenticationTag,
          initializationVector: r.credentialInitializationVector,
          keyVersion: r.credentialKeyVersion,
        },
      }),
    ),
  ];
}

function assertApplicationsStopped() {
  for (const entry of readdirSync("/proc").filter((name) => /^\d+$/u.test(name))) {
    let cwd: string;
    let cmd: string;
    try {
      cwd = readlinkSync(`/proc/${entry}/cwd`);
      cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").replaceAll("\0", " ");
    } catch {
      continue;
    }
    if (
      (cwd === resolve(root, "apps/api") && /nest|dist\/main/u.test(cmd)) ||
      (cwd === resolve(root, "apps/worker") && /lifecycle/u.test(cmd))
    )
      throw new Error(`Stop API and Worker before --apply (active process ${entry})`);
  }
}

async function run() {
  const existing = await records(prisma);
  // Validate *all* records, including revoked history, before changing any ciphertext.
  for (const record of existing) oldCipher.decrypt(record.envelope, record.aad);
  const settingChanges: Array<{ key: string; group: "PUBLICATION" | "STORAGE"; value: string }> =
    [];
  for (const [key, environmentName, group] of [
    ["publication.metrics_ingest_key", "HERMES_INGEST_KEY", "PUBLICATION"],
    ["storage.delivery_signing_key", "ASSET_DELIVERY_SIGNING_KEY", "STORAGE"],
  ] as const) {
    const record = existing.find((r) => r.kind === "setting" && r.id === key);
    const current = record
      ? oldCipher.decrypt(record.envelope, record.aad)
      : plan.environment[environmentName];
    const value = isProductionRandomSecret(current, 32)
      ? (current as string)
      : randomBytes(32).toString("hex");
    if (!record || value !== current) settingChanges.push({ key, group, value });
    if (plan.environment[environmentName] !== value) plan.changes[environmentName] = value;
  }
  const summary = {
    environmentKeys: Object.keys(plan.changes),
    rotateMasterKey: plan.rekey,
    credentialRecords: existing.length,
    settings: settingChanges.map(({ key }) => key),
  };
  console.log(JSON.stringify(summary));
  if (!process.argv.includes("--apply")) {
    console.log("Preview only. --apply requires stopped API/Worker and creates private backups.");
    return;
  }
  if (!summary.environmentKeys.length && !settingChanges.length) {
    console.log("Local secrets are already hardened; no changes needed.");
    return;
  }
  assertApplicationsStopped();
  const backup = resolve(
    root,
    `.artifacts/security/${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}`,
  );
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  chmodSync(dirname(backup), 0o700);
  copyFileSync(envFile, resolve(backup, "env.before"));
  chmodSync(resolve(backup, "env.before"), 0o600);
  const envAfter = replaceEnvValues(source, plan.changes);
  writeFileSync(resolve(backup, "env.after"), envAfter, { mode: 0o600, flag: "wx" });
  const dumpPath = resolve(backup, "database.before.dump");
  const dumpFd = openSync(dumpPath, "wx", 0o600);
  const container = process.env.XHS_DEV_POSTGRES_CONTAINER ?? "dev-postgresql";
  try {
    const dump = spawnSync(
      "docker",
      [
        "exec",
        container,
        "pg_dump",
        "-U",
        "postgres",
        "-d",
        "dev_xhs_agentic",
        "--format=custom",
        "--no-acl",
        "--no-owner",
      ],
      { stdio: ["ignore", dumpFd, "pipe"], timeout: 120_000 },
    );
    if (dump.status !== 0) throw new Error("Database backup failed; no secrets were changed");
  } finally {
    closeSync(dumpFd);
  }
  const dumpInput = openSync(dumpPath, "r");
  try {
    const verify = spawnSync("docker", ["exec", "-i", container, "pg_restore", "--list"], {
      stdio: [dumpInput, "ignore", "pipe"],
      timeout: 120_000,
    });
    if (verify.status !== 0)
      throw new Error("Database backup validation failed; no secrets were changed");
  } finally {
    closeSync(dumpInput);
  }
  console.log(`Private recovery backup: ${backup}`);
  if (readFileSync(envFile, "utf8") !== source)
    throw new Error(".env changed during preparation; retry after resolving concurrent changes");
  const migrate = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`LOCK TABLE model_provider_credentials, platform_settings, directory_connections IN EXCLUSIVE MODE`;
    const lockedRecords = await records(tx);
    if (
      lockedRecords.length !== existing.length ||
      lockedRecords.some((r) => {
        const original = existing.find((item) => item.kind === r.kind && item.id === r.id);
        return (
          !original ||
          oldCipher.decrypt(original.envelope, original.aad) !==
            oldCipher.decrypt(r.envelope, r.aad)
        );
      })
    )
      throw new Error("Credential records changed during preparation; no secrets were changed");
    for (const record of lockedRecords) {
      const plaintext = oldCipher.decrypt(record.envelope, record.aad);
      if (!plan.rekey) continue;
      const encrypted = newCipher.encrypt(plaintext, record.aad);
      if (newCipher.decrypt(encrypted, record.aad) !== plaintext)
        throw new Error("Credential round-trip validation failed");
      const data = {
        ciphertext: Buffer.from(encrypted.ciphertext),
        authenticationTag: Buffer.from(encrypted.authenticationTag),
        initializationVector: Buffer.from(encrypted.initializationVector),
        keyVersion: encrypted.keyVersion,
      };
      if (record.kind === "model")
        await tx.modelProviderCredential.update({ where: { id: record.id }, data });
      else if (record.kind === "setting")
        await tx.platformSetting.update({ where: { key: record.id }, data });
      else
        await tx.directoryConnection.update({
          where: { id: record.id },
          data: {
            credentialCiphertext: data.ciphertext,
            credentialAuthenticationTag: data.authenticationTag,
            credentialInitializationVector: data.initializationVector,
            credentialKeyVersion: data.keyVersion,
          },
        });
    }
    for (const change of settingChanges) {
      const encrypted = newCipher.encrypt(
        change.value,
        `xhs-agentic:platform-setting:${change.key}`,
      );
      const data = {
        ciphertext: Buffer.from(encrypted.ciphertext),
        authenticationTag: Buffer.from(encrypted.authenticationTag),
        initializationVector: Buffer.from(encrypted.initializationVector),
        keyVersion: encrypted.keyVersion,
        secretLastFour: change.value.slice(-4),
        value: Prisma.DbNull,
        updatedBy: actor,
      };
      await tx.platformSetting.upsert({
        where: { key: change.key },
        create: { ...data, key: change.key, group: change.group, valueType: "SECRET" },
        update: { ...data, version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "platform-setting.update",
          resourceType: "PlatformSetting",
          resourceId: change.key,
          reason: "本地发布准备：替换弱签名密钥",
          stateAfter: { configured: true, secret: true },
        },
      });
    }
    for (const record of await records(tx)) newCipher.decrypt(record.envelope, record.aad);
    await tx.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "security.local-secrets.harden",
        resourceType: "ApplicationSecurity",
        resourceId: "local",
        reason: "用户授权处理本地发布边界",
        metadata: summary,
      },
    });
  };
  const rehearsalRollback = new Error("Intentional secret migration rehearsal rollback");
  try {
    await prisma.$transaction(
      async (tx) => {
        await migrate(tx);
        throw rehearsalRollback;
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    if (error !== rehearsalRollback) throw error;
  }
  console.log("Transactional re-encryption rehearsal passed and was rolled back.");
  await prisma.$transaction(migrate, { timeout: 60_000 });
  // Both env.before+dump and env.after are retained: never restore only one side of a rekey.
  const pendingEnv = resolve(root, `.env.security-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(pendingEnv, envAfter, { mode: 0o600, flag: "wx" });
    renameSync(pendingEnv, envFile);
  } catch {
    throw new Error(
      `Database rekey committed. Keep API/Worker stopped and activate ${resolve(backup, "env.after")} as .env before restarting.`,
    );
  }
  writeFileSync(
    resolve(backup, "COMPLETE.json"),
    JSON.stringify(
      { ...summary, completedAt: new Date().toISOString(), keyVersion: newCipher.keyVersion },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Hardened local secrets, verified every encrypted record, and activated .env. Restart API/Worker; old login tokens are invalidated.",
  );
}

run()
  .catch(() => {
    // Never print arbitrary SDK/Prisma errors, which may embed credential values.
    console.error(
      "Local secret hardening failed. Keep API/Worker stopped if a backup was created; use its matched env/database recovery pair or env.after after a committed rekey.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
