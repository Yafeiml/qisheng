import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");
const connectionString = process.env.DATABASE_URL;
assert(connectionString, "Local development DATABASE_URL is required");
const url = new URL(connectionString);
const databaseName = decodeURIComponent(url.pathname.slice(1));
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
  "Only the local development database may be tested",
);
assert(
  /^dev[_-]|[_-]dev$/u.test(databaseName),
  "Database name must identify the development database",
);
const packageRequire = createRequire(resolve("packages/database/package.json"));
const adapterRequire = createRequire(packageRequire.resolve("@prisma/adapter-pg"));
const { Client } = adapterRequire("pg");
const client = new Client({ connectionString });
const migration = readFileSync(
  "prisma/migrations/20261013030000_medical_selection_plan/migration.sql",
  "utf8",
);
await client.connect();
let began = false;
try {
  await client.query("BEGIN");
  began = true;
  const before = await client.query('SELECT count(*)::text AS count FROM "generated_images"');
  await client.query(migration);
  const after = await client.query('SELECT count(*)::text AS count FROM "generated_images"');
  assert.equal(after.rows[0].count, before.rows[0].count, "Migration must preserve all images");
  const column = await client.query(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'selection_snapshot'",
  );
  assert.equal(column.rows[0]?.is_nullable, "YES", "Historical campaigns must remain readable");
  const indexes = await client.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'generated_images'",
  );
  assert(indexes.rows.some((row) => row.indexname === "generated_images_checksum_idx"));
  assert(!indexes.rows.some((row) => row.indexname === "generated_images_checksum_key"));
  const cloned = await client.query(`INSERT INTO generated_images
    (id, tenant_id, campaign_id, employee_content_id, sequence, image_url, storage_key, storage_etag, byte_size, mime_type, checksum, perceptual_hash, width, height, prompt, provider, model, synthetic, created_at)
    SELECT id || '-medical-migration-check', tenant_id, campaign_id, employee_content_id, 2147483647, image_url, storage_key, storage_etag, byte_size, mime_type, checksum, perceptual_hash, width, height, prompt, provider, model, synthetic, created_at
    FROM generated_images ORDER BY created_at LIMIT 1 RETURNING id`);
  await client.query("SAVEPOINT invalid_scope");
  let scopeRejected = false;
  try {
    await client.query(`INSERT INTO campaign_effect_observations (id, tenant_id, enterprise_id, campaign_id, kind, observed_at, payload, created_by)
      VALUES ('medical-migration-invalid-scope', 'not-a-tenant', 'not-an-enterprise', 'not-a-campaign', 'GEO', now(), '{}'::jsonb, 'migration-check')`);
  } catch (error) {
    scopeRejected = error.code === "23503";
  }
  await client.query("ROLLBACK TO SAVEPOINT invalid_scope");
  assert(scopeRejected, "Observation records must enforce campaign enterprise/tenant scope");
  await client.query("ROLLBACK");
  began = false;
  const reverted = await client.query(
    "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'campaigns' AND column_name = 'selection_snapshot'",
  );
  assert.equal(reverted.rows[0].count, 0, "DDL must roll back atomically");
  console.log(
    JSON.stringify({
      database: databaseName,
      migration: "20261013030000_medical_selection_plan",
      transactional: true,
      dataPreserved: true,
      sharedImageInsertChecked: cloned.rowCount > 0,
      scopeRejected: true,
      rolledBack: true,
    }),
  );
} finally {
  if (began) await client.query("ROLLBACK");
  await client.end();
}
