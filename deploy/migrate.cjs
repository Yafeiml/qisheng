// Runs inside the existing API image with only non-secret release files mounted.
// pg uses the existing Compose DATABASE_URL; never print connection/error details.
const { createHash, randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");

function validateBundle(bundle) {
  if (bundle.version !== 1 || !Array.isArray(bundle.migrations) || !bundle.migrations.length)
    throw new Error("INVALID_MIGRATION_BUNDLE");
  const names = new Set();
  for (const row of bundle.migrations) {
    if (
      !/^20\d{12}_[A-Za-z0-9_]+$/u.test(row.name) ||
      names.has(row.name) ||
      typeof row.sql !== "string" ||
      createHash("sha256").update(row.sql).digest("hex") !== row.checksum
    )
      throw new Error("INVALID_MIGRATION_CHECKSUM_OR_NAME");
    names.add(row.name);
  }
}

function migrationPlan(bundle, rows) {
  validateBundle(bundle);
  const expected = new Map(bundle.migrations.map((row) => [row.name, row]));
  if (rows.some((row) => !row.finished_at && !row.rolled_back_at))
    throw new Error("INCOMPLETE_MIGRATION_HISTORY");
  const applied = rows.filter((row) => row.finished_at && !row.rolled_back_at);
  if (
    !applied.length ||
    new Set(applied.map((row) => row.migration_name)).size !== applied.length ||
    applied.some((row) => expected.get(row.migration_name)?.checksum !== row.checksum)
  )
    throw new Error("MIGRATION_HISTORY_MISMATCH");
  const known = new Set(applied.map((row) => row.migration_name));
  const pending = bundle.migrations
    .filter((row) => !known.has(row.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const latest = [...known].sort().at(-1);
  for (const row of pending) {
    if (row.name <= latest) throw new Error("MIGRATION_HISTORY_GAP");
    if (bundle.maintenanceRequired?.[row.name])
      throw new Error(`MIGRATION_MAINTENANCE_REQUIRED:${row.name}`);
    if (bundle.backwardCompatible?.[row.name] !== row.checksum)
      throw new Error(`MIGRATION_COMPATIBILITY_NOT_REVIEWED:${row.name}`);
  }
  return pending;
}

async function migrate(client, bundle, mode) {
  if (!["check", "apply", "verify"].includes(mode)) throw new Error("INVALID_MIGRATION_MODE");
  validateBundle(bundle);
  await client.query(mode === "apply" ? "BEGIN" : "BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const lock = await client.query("SELECT pg_try_advisory_xact_lock(72707369) AS acquired");
    if (!lock.rows[0]?.acquired) throw new Error("ANOTHER_MIGRATION_IS_RUNNING");
    const history = () =>
      client.query(
        'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"',
      );
    const pending = migrationPlan(bundle, (await history()).rows);
    if (mode === "verify" && pending.length) throw new Error("MIGRATIONS_NOT_APPLIED");
    if (mode === "apply") {
      for (const row of pending) {
        // Reviewed SQL is executed as a whole: functions and quoted semicolons
        // must never be split by a naive string splitter.
        await client.query(row.sql);
        await client.query(
          'INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ($1, $2, $3, NOW(), NOW(), 1)',
          [randomUUID(), row.checksum, row.name],
        );
      }
      if (migrationPlan(bundle, (await history()).rows).length)
        throw new Error("MIGRATION_VERIFY_FAILED");
    }
    await client.query("COMMIT");
    return {
      status: mode === "apply" ? "APPLIED" : mode === "verify" ? "VERIFIED" : "READY",
      pending: pending.map((row) => row.name),
      total: bundle.migrations.length,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

module.exports = { validateBundle, migrationPlan, migrate };
if (require.main === module) {
  const { Client } = createRequire("/app/package.json")("pg");
  const client = new Client({
    connectionString: process.env.DATABASE_URL?.trim().replace(/^"|"$/gu, ""),
    connectionTimeoutMillis: 10000,
  });
  (async () => {
    try {
      await client.connect();
      const bundle = JSON.parse(readFileSync("/release/migrations.json", "utf8"));
      console.log(JSON.stringify(await migrate(client, bundle, process.argv[2])));
    } catch (error) {
      const code = /^[A-Z_]+(?::20\d{12}_[A-Za-z0-9_]+)?$/u.test(error.message)
        ? error.message
        : "MIGRATION_TRANSACTION_FAILED";
      console.error(JSON.stringify({ status: "FAILED", code }));
      process.exitCode = 1;
    } finally {
      await client.end().catch(() => {});
    }
  })();
}
