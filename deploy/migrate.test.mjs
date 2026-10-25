import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { migrate, migrationPlan } from "./migrate.cjs";

const entry = (name, sql) => ({
  name,
  sql,
  checksum: createHash("sha256").update(sql).digest("hex"),
});
const baseline = entry("20260924000000_baseline", "SELECT 1;");
const row = {
  migration_name: baseline.name,
  checksum: baseline.checksum,
  finished_at: new Date(),
  rolled_back_at: null,
};
const pending = entry("20260926000000_new", "CREATE TABLE new_table(id integer);");
const bundle = (entries) => ({
  version: 1,
  migrations: [baseline, ...entries],
  backwardCompatible: Object.fromEntries(entries.map((e) => [e.name, e.checksum])),
});

test("历史、校验值和兼容声明必须匹配；不在发布包中的迁移也拒绝", () => {
  assert.deepEqual(
    migrationPlan(bundle([pending]), [row]).map((e) => e.name),
    [pending.name],
  );
  assert.throws(
    () => migrationPlan(bundle([pending]), [{ ...row, checksum: "changed" }]),
    /HISTORY_MISMATCH/u,
  );
  assert.throws(() => migrationPlan(bundle([pending]), [row, row]), /HISTORY_MISMATCH/u);
  assert.throws(
    () => migrationPlan(bundle([]), [{ ...row, migration_name: "unknown" }]),
    /HISTORY_MISMATCH/u,
  );
  assert.throws(
    () => migrationPlan(bundle([pending]), [{ ...row, finished_at: null }]),
    /INCOMPLETE/u,
  );
  assert.throws(
    () => migrationPlan({ ...bundle([pending]), backwardCompatible: {} }, [row]),
    /NOT_REVIEWED/u,
  );
  assert.throws(
    () => migrationPlan(bundle([entry("20260923000000_gap", "SELECT 1;")]), [row]),
    /HISTORY_GAP/u,
  );
  assert.throws(
    () =>
      migrationPlan(
        {
          ...bundle([pending]),
          migrations: [baseline, { ...pending, sql: "DROP TABLE actual_business;" }],
        },
        [row],
      ),
    /CHECKSUM/u,
  );
});

test("maintenance migrations cannot run through the rolling-compatible path", () => {
  assert.throws(
    () =>
      migrationPlan(
        { ...bundle([pending]), maintenanceRequired: { [pending.name]: pending.checksum } },
        [row],
      ),
    /MIGRATION_MAINTENANCE_REQUIRED/u,
  );
  assert.deepEqual(
    migrationPlan(
      { ...bundle([pending]), maintenanceRequired: { [pending.name]: pending.checksum } },
      [row, { ...row, migration_name: pending.name, checksum: pending.checksum }],
    ),
    [],
  );
});

// Opt in explicitly: the default node test suite never creates a database.
test("真实 PostgreSQL：仅在临时库验证事务回滚、并发锁和本次两项迁移", {
  skip: process.env.RUN_RELEASE_DB_TEST !== "1",
}, async (t) => {
  process.loadEnvFile(new URL("../.env", import.meta.url));
  const source = new URL(process.env.DATABASE_URL);
  assert.ok(
    ["127.0.0.1", "localhost"].includes(source.hostname) && source.pathname.startsWith("/dev_"),
  );
  const database = `dev_xhs_release_test_${process.pid}`;
  const owner = decodeURIComponent(source.username);
  assert.match(owner, /^[a-z_][a-z0-9_]*$/u);
  const container = process.env.XHS_DEV_POSTGRES_CONTAINER || "dev-postgresql";
  const docker = (args) => execFileSync("docker", ["exec", container, ...args], { stdio: "pipe" });
  const { Client } = createRequire(new URL("../apps/api/package.json", import.meta.url))("pg");
  source.pathname = `/${database}`;
  let created = false,
    client;
  try {
    docker(["createdb", "-U", "postgres", "-O", owner, database]);
    created = true;
    client = new Client({ connectionString: source.toString() });
    await client.connect();
    await client.query(
      'CREATE TABLE "_prisma_migrations" (id text PRIMARY KEY, checksum text NOT NULL, migration_name text NOT NULL, started_at timestamptz, finished_at timestamptz, rolled_back_at timestamptz, applied_steps_count integer)',
    );
    await client.query('INSERT INTO "_prisma_migrations" VALUES ($1,$2,$3,NOW(),NOW(),NULL,1)', [
      "baseline",
      baseline.checksum,
      baseline.name,
    ]);
    await t.test("中途 DDL 失败：表与迁移记录一起回滚，再次执行可恢复", async () => {
      const failure = entry(
        "20260926000000_broken",
        "CREATE TABLE rolled_back_table(id int); SELECT missing_column FROM rolled_back_table;",
      );
      await assert.rejects(migrate(client, bundle([failure]), "apply"));
      assert.equal(
        (await client.query("SELECT to_regclass('rolled_back_table') AS name")).rows[0].name,
        null,
      );
      assert.equal(
        (await client.query('SELECT COUNT(*)::int AS count FROM "_prisma_migrations"')).rows[0]
          .count,
        1,
      );
      assert.equal((await migrate(client, bundle([]), "verify")).status, "VERIFIED");
    });
    await t.test("并发迁移被拒绝，释放锁后检查正常", async () => {
      const other = new Client({ connectionString: source.toString() });
      try {
        await other.connect();
        await other.query("SELECT pg_advisory_lock(72707369)");
        await assert.rejects(migrate(client, bundle([pending]), "apply"), /ANOTHER_MIGRATION/u);
      } finally {
        await other.end();
      }
      assert.deepEqual((await migrate(client, bundle([pending]), "check")).pending, [pending.name]);
    });
    await t.test("整段 SQL 保留函数内分号；真实新增表和索引迁移可幂等执行", async () => {
      await client.query(
        "CREATE TABLE model_routes(id text PRIMARY KEY); CREATE TYPE generation_delivery_mode AS ENUM ('DEVELOPMENT','PRODUCTION')",
      );
      const names = [
        "20260926010000_dynamic_model_incidents",
        "20260926011000_dynamic_model_incident_indexes",
      ];
      const entries = names.map((name) =>
        entry(
          name,
          readFileSync(
            new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
            "utf8",
          ),
        ),
      );
      const policy = JSON.parse(
        readFileSync(new URL("./migration-policy.json", import.meta.url), "utf8"),
      );
      const data = { ...bundle(entries), backwardCompatible: policy.backwardCompatible };
      assert.deepEqual((await migrate(client, data, "apply")).pending, names);
      assert.deepEqual((await migrate(client, data, "apply")).pending, []);
      assert.equal((await migrate(client, data, "verify")).total, 3);
      const func = entry(
        "20260926020000_function",
        "CREATE FUNCTION release_test_function() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$;",
      );
      await migrate(client, bundle([...entries, func]), "apply");
      assert.equal(
        (await client.query("SELECT release_test_function() AS value")).rows[0].value,
        1,
      );
    });
  } finally {
    if (client) await client.end().catch(() => {});
    if (created) docker(["dropdb", "-U", "postgres", "--force", database]);
  }
});
