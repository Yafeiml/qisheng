import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const migrationName = "20261024010000_remove_content_points";
const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
const migrationSql = readFileSync(
  new URL(`${migrationName}/migration.sql`, migrationsRoot),
  "utf8",
);
const retiredTables = [
  "credit_wallets",
  "credit_lots",
  "credit_ledgers",
  "recharge_orders",
  "recharge_products",
  "tenant_recharge_policies",
];
const retiredEnums = [
  "credit_ledger_type",
  "credit_lot_status",
  "credit_lot_source",
  "credit_wallet_status",
  "recharge_order_channel",
  "recharge_order_status",
  "recharge_product_status",
];

test("points removal requires the exact reviewed maintenance migration", () => {
  const policy = JSON.parse(
    readFileSync(new URL("./migration-policy.json", import.meta.url), "utf8"),
  );
  assert.equal(
    policy.maintenanceRequired[migrationName],
    createHash("sha256").update(migrationSql).digest("hex"),
  );
  assert.equal(policy.backwardCompatible[migrationName], undefined);
});

// Explicit opt-in only. Reuses the existing local install-validation PostgreSQL;
// never reads application env files or changes its original database/services.
test("real PostgreSQL: full migration chain and atomic retirement preserve business data", {
  skip: process.env.RUN_REMOVE_POINTS_DB_TEST !== "1",
  timeout: 180_000,
}, async (t) => {
  assert.equal(process.platform, "win32");
  const container =
    process.env.QISHENG_REMOVE_POINTS_TEST_CONTAINER ?? "qisheng-install-check-validation-db-1";
  assert.match(container, /^qisheng-install-check-[a-z0-9-]+-db-1$/u);
  const prefix = `dev_qisheng_remove_points_${process.pid}_`;
  const owned = new Set();
  const wsl = (args, input) =>
    spawnSync("wsl.exe", ["-d", "Ubuntu-26.04-LTS", "-u", "root", "--", ...args], {
      encoding: "utf8",
      input,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  const inspected = wsl([
    "docker",
    "inspect",
    container,
    "--format",
    "{{.Config.Image}} {{.State.Running}}",
  ]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.match(inspected.stdout, /^pgvector\/pgvector[^\r\n]* true\s*$/u);
  const user = wsl(["docker", "exec", container, "printenv", "POSTGRES_USER"]);
  assert.equal(user.status, 0, user.stderr);
  const databaseUser = user.stdout.trim();
  assert.match(databaseUser, /^[a-z_][a-z0-9_]*$/u);
  const psql = (database, sql, allowFailure = false) => {
    const result = wsl(
      [
        "docker",
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        databaseUser,
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "--dbname",
        database,
        "--no-align",
        "--tuples-only",
      ],
      sql,
    );
    if (!allowFailure)
      assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr}`);
    return result;
  };
  const json = (database, sql) => JSON.parse(psql(database, sql).stdout.trim());
  const createDatabase = () => {
    const name = `${prefix}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    assert.match(name, /^dev_qisheng_remove_points_\d+_[a-f0-9]{8}$/u);
    assert.ok(name.startsWith(prefix) && name.length <= 63);
    psql("postgres", `CREATE DATABASE "${name}";`);
    owned.add(name);
    return name;
  };
  const assertRetired = (database) => {
    const state = json(
      database,
      `SELECT json_build_object(
      'tables', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY(ARRAY[${sqlStrings(retiredTables)}])),
      'enums', (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = ANY(ARRAY[${sqlStrings(retiredEnums)}])),
      'oldColumns', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'campaigns' AND column_name IN ('credit_wallet_id', 'cancellation_settlement')) OR (table_name = 'generation_work_items' AND column_name IN ('credit_lot_id', 'credit_reserved')))),
      'summaryColumn', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'cancellation_summary'));
    `,
    );
    assert.deepEqual(state, { tables: 0, enums: 0, oldColumns: 0, summaryColumn: 1 });
  };
  try {
    await t.test("applies all 84 historical migrations followed by the removal migration", () => {
      const database = createDatabase();
      const names = readdirSync(migrationsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name <= migrationName)
        .map((entry) => entry.name)
        .sort();
      assert.equal(names.length, 85);
      assert.equal(names.at(-1), migrationName);
      const chain = names
        .map(
          (name) =>
            `\n\\echo applying ${name}\n${readFileSync(new URL(`${name}/migration.sql`, migrationsRoot), "utf8")}\n`,
        )
        .join("");
      const result = psql(database, chain);
      assert.equal((result.stdout.match(/^applying /gmu) ?? []).length, 85);
      assertRetired(database);
      const businessTables = [
        "tenants",
        "enterprises",
        "campaigns",
        "generation_runs",
        "generation_work_items",
        "distribution_tasks",
        "employee_contents",
        "campaign_drafts",
        "campaign_preflight_snapshots",
        "roles",
        "permissions",
        "role_permissions",
        "tenant_storage_accounts",
        "storage_reservations",
        "storage_usage_ledgers",
      ];
      assert.deepEqual(
        json(
          database,
          `SELECT json_agg(relname ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY(ARRAY[${sqlStrings(businessTables)}]);`,
        ),
        businessTables.sort(),
      );
    });
    await t.test(
      "a dependency failure rolls back every DROP; success keeps business and non-credit evidence",
      () => {
        const database = createDatabase();
        psql(database, legacyFixture);
        const before = json(database, legacySnapshot);
        psql(database, "CREATE VIEW rollback_guard AS SELECT id FROM credit_wallets;");
        const rejected = psql(database, migrationSql, true);
        assert.notEqual(rejected.status, 0);
        assert.match(
          rejected.stderr,
          /cannot drop table credit_wallets because other objects depend on it/u,
        );
        assert.deepEqual(json(database, legacySnapshot), before);
        psql(database, "DROP VIEW rollback_guard;");
        psql(database, migrationSql);
        assertRetired(database);
        const after = json(
          database,
          `SELECT json_build_object(
        'campaigns', (SELECT jsonb_agg(jsonb_build_object('id', id, 'title', title, 'summary', cancellation_summary) ORDER BY id) FROM campaigns),
        'work', (SELECT jsonb_agg(jsonb_build_object('id', id, 'campaign', campaign_id, 'status', status) ORDER BY id) FROM generation_work_items),
        'storage', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM storage_reservations s),
        'drafts', (SELECT jsonb_agg(payload ORDER BY id) FROM campaign_drafts),
        'checks', (SELECT checks FROM campaign_preflight_snapshots WHERE id = 'array'),
        'nonArrayChecks', (SELECT checks FROM campaign_preflight_snapshots WHERE id = 'object'),
        'permissions', (SELECT jsonb_agg(code ORDER BY code) FROM permissions),
        'rolePermissions', (SELECT jsonb_agg(permission_id ORDER BY permission_id) FROM role_permissions));`,
        );
        assert.deepEqual(after, {
          campaigns: [
            {
              id: "c1",
              title: "business sentinel",
              summary: {
                cancelledDistributionTasks: 3,
                cancelledGenerationRuns: 2,
                cancelledWorkItems: 0,
              },
            },
            { id: "c2", title: "null summary", summary: null },
          ],
          work: [{ id: "w1", campaign: "c1", status: "GENERATED" }],
          storage: [{ id: "storage", bytes: 2048 }],
          drafts: [{ title: "retain draft", nested: { untouched: true } }],
          checks: [
            { code: "TRUTHFULNESS", status: "PASS" },
            { detail: "unnamed evidence" },
            { code: null, detail: "null code evidence" },
            { code: "STORAGE", status: "PASS" },
          ],
          nonArrayChecks: { detail: "legacy non-array evidence" },
          permissions: ["enterprise.campaign.read", "enterprise.storage.manage"],
          rolePermissions: ["business", "storage"],
        });
      },
    );
  } finally {
    for (const database of owned) {
      assert.ok(database.startsWith(prefix));
      assert.match(database, /^dev_qisheng_remove_points_\d+_[a-f0-9]{8}$/u);
      psql("postgres", `DROP DATABASE "${database}" WITH (FORCE);`);
    }
    assert.equal(
      json(
        "postgres",
        `SELECT count(*)::integer FROM pg_database WHERE datname LIKE '${prefix}%';`,
      ),
      0,
    );
  }
});

function sqlStrings(values) {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

// Deliberately small legacy schema: real PostgreSQL constraints and data make
// partial execution observable without copying any application/customer data.
const legacyFixture = `
CREATE TYPE credit_ledger_type AS ENUM ('CONSUME');
CREATE TYPE credit_lot_status AS ENUM ('ACTIVE');
CREATE TYPE credit_lot_source AS ENUM ('OPENING');
CREATE TYPE credit_wallet_status AS ENUM ('ACTIVE');
CREATE TYPE recharge_order_channel AS ENUM ('MANUAL');
CREATE TYPE recharge_order_status AS ENUM ('PAID');
CREATE TYPE recharge_product_status AS ENUM ('ACTIVE');
CREATE TABLE credit_wallets(id text PRIMARY KEY, status credit_wallet_status, balance integer);
CREATE TABLE credit_lots(id text PRIMARY KEY, wallet_id text REFERENCES credit_wallets, status credit_lot_status, source credit_lot_source);
CREATE TABLE recharge_products(id text PRIMARY KEY, status recharge_product_status);
CREATE TABLE recharge_orders(id text PRIMARY KEY, wallet_id text REFERENCES credit_wallets, product_id text REFERENCES recharge_products, status recharge_order_status, channel recharge_order_channel);
CREATE TABLE tenant_recharge_policies(id text PRIMARY KEY);
CREATE TABLE campaigns(id text PRIMARY KEY, title text, credit_wallet_id text REFERENCES credit_wallets, cancellation_settlement jsonb);
CREATE TABLE generation_work_items(id text PRIMARY KEY, campaign_id text REFERENCES campaigns, status text, credit_lot_id text REFERENCES credit_lots, credit_reserved boolean);
CREATE TABLE credit_ledgers(id text PRIMARY KEY, wallet_id text REFERENCES credit_wallets, lot_id text REFERENCES credit_lots, order_id text REFERENCES recharge_orders, work_id text REFERENCES generation_work_items, type credit_ledger_type);
CREATE TABLE storage_reservations(id text PRIMARY KEY, bytes integer);
CREATE TABLE campaign_drafts(id text PRIMARY KEY, payload jsonb);
CREATE TABLE campaign_preflight_snapshots(id text PRIMARY KEY, checks jsonb);
CREATE TABLE permissions(id text PRIMARY KEY, code text);
CREATE TABLE role_permissions(role_id text, permission_id text REFERENCES permissions);
INSERT INTO credit_wallets VALUES ('wallet', 'ACTIVE', 42);
INSERT INTO credit_lots VALUES ('lot', 'wallet', 'ACTIVE', 'OPENING');
INSERT INTO recharge_products VALUES ('product', 'ACTIVE');
INSERT INTO recharge_orders VALUES ('order', 'wallet', 'product', 'PAID', 'MANUAL');
INSERT INTO tenant_recharge_policies VALUES ('policy');
INSERT INTO campaigns VALUES ('c1', 'business sentinel', 'wallet', '{"cancelledDistributionTasks":3,"cancelledGenerationRuns":2,"cancelledWorkItems":0,"releasedCredits":9,"walletId":"wallet"}'), ('c2', 'null summary', NULL, NULL);
INSERT INTO generation_work_items VALUES ('w1', 'c1', 'GENERATED', 'lot', true);
INSERT INTO credit_ledgers VALUES ('ledger', 'wallet', 'lot', 'order', 'w1', 'CONSUME');
INSERT INTO storage_reservations VALUES ('storage', 2048);
INSERT INTO campaign_drafts VALUES ('draft', '{"fundingSource":"CREDITS","walletScope":"TENANT","title":"retain draft","nested":{"untouched":true}}');
INSERT INTO campaign_preflight_snapshots VALUES ('array', '[{"code":"TRUTHFULNESS","status":"PASS"},{"code":"CREDITS","status":"FAIL"},{"detail":"unnamed evidence"},{"code":null,"detail":"null code evidence"},{"code":"CONTENT_CREDITS","status":"PASS"},{"code":"CREDIT_WALLET_ACTIVE","status":"PASS"},{"code":"STORAGE","status":"PASS"}]'), ('object', '{"detail":"legacy non-array evidence"}');
INSERT INTO permissions VALUES ('credit', 'enterprise.credit.read'), ('recharge', 'platform.recharge.manage'), ('business', 'enterprise.campaign.read'), ('storage', 'enterprise.storage.manage');
INSERT INTO role_permissions SELECT 'administrator', id FROM permissions;
`;

const legacySnapshot = `SELECT json_build_object(
  'tables', (SELECT jsonb_agg(relname ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'),
  'enums', (SELECT jsonb_agg(typname ORDER BY typname) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'),
  'campaigns', (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM campaigns c),
  'work', (SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM generation_work_items w),
  'wallets', (SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM credit_wallets w),
  'drafts', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM campaign_drafts d),
  'checks', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM campaign_preflight_snapshots s),
  'permissions', (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM permissions p));`;
