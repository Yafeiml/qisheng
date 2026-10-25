import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Prisma loads an absent or blank optional shadow database without changing a configured one", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "qisheng-prisma-config-"));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("qisheng-prisma-config-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const configFile = fileURLToPath(new URL("../prisma.config.ts", import.meta.url));
  for (const shadow of [undefined, "", "postgresql://db.example.test/shadow"]) {
    const environment = { ...process.env, DATABASE_URL: "postgresql://db.example.test/main" };
    delete environment.SHADOW_DATABASE_URL;
    if (shadow !== undefined) environment.SHADOW_DATABASE_URL = shadow;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(${JSON.stringify(import.meta.url)});
      const { loadConfigFromFile } = createRequire(require.resolve('prisma/package.json'))('@prisma/config');
      const result = await loadConfigFromFile({ configFile: ${JSON.stringify(configFile)} });
      assert.equal(result.error, undefined);
      assert.equal(result.config.datasource.url, process.env.DATABASE_URL);
      assert.equal(result.config.datasource.shadowDatabaseUrl, ${JSON.stringify(shadow || null)} ?? undefined);
      console.log('CONFIG_OK');
    `,
      ],
      { cwd: directory, env: environment, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "CONFIG_OK");
  }
});
