import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { expect, it } from "vitest";

it("adds nullable email token fields transactionally while legacy Worker SQL remains compatible", async () => {
  if (!process.env.DATABASE_URL?.includes("dev_xhs_agentic"))
    throw new Error("Development database required");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  const schema = `email_migration_${randomUUID().replaceAll("-", "")}`;
  const sql = await readFile(
    "prisma/migrations/20261009010000_admin_email_verification/migration.sql",
    "utf8",
  );
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(
      "CREATE TABLE admin_users (id TEXT PRIMARY KEY, email TEXT, email_verified_at TIMESTAMP(3))",
    );
    await client.query("INSERT INTO admin_users (id, email) VALUES ('old', 'owner@example.test')");
    await expect(client.query(sql.replace("COMMIT;", "SELECT 1 / 0; COMMIT;"))).rejects.toThrow();
    await client.query("ROLLBACK");
    const rolledBack = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name LIKE 'email_verification_%'",
      [schema],
    );
    expect(rolledBack.rowCount).toBe(0);
    await client.query(sql);
    await client.query("INSERT INTO admin_users (id, email) VALUES ('legacy-worker', NULL)");
    const rows = await client.query("SELECT * FROM admin_users ORDER BY id");
    expect(rows.rows).toEqual([
      {
        id: "legacy-worker",
        email: null,
        email_verified_at: null,
        email_verification_token_hash: null,
        email_verification_expires_at: null,
      },
      {
        id: "old",
        email: "owner@example.test",
        email_verified_at: null,
        email_verification_token_hash: null,
        email_verification_expires_at: null,
      },
    ]);
  } finally {
    await client.query("ROLLBACK");
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
