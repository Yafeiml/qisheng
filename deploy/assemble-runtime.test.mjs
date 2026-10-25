import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { assembleRuntime, copyRuntimeTree } from "./docker/assemble-runtime.mjs";
import { runLocalContainer } from "./local-container.mjs";

test("web standalone assembly copies the server, static and public files into runtime layout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "qisheng-web-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of [
    ["apps/admin-web/.next/standalone/apps/admin-web/server.js", "module.exports=7"],
    ["apps/admin-web/.next/static/test.css", "css"],
    ["apps/admin-web/public/icon.txt", "icon"],
  ]) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }
  const bundleRoot = join(root, "bundle");
  assembleRuntime("web", { root, bundleRoot });
  const require = createRequire(join(bundleRoot, "web/apps/admin-web/package.json"));
  assert.equal(require("./server.js"), 7);
  assert.equal(
    readFileSync(join(bundleRoot, "web/apps/admin-web/.next/static/test.css"), "utf8"),
    "css",
  );
  assert.equal(
    readFileSync(join(bundleRoot, "web/apps/admin-web/public/icon.txt"), "utf8"),
    "icon",
  );
  assert.throws(() => assembleRuntime("invalid", { root, bundleRoot }), /Unknown image service/);
});

test("migration assembly keeps only the locked CLI dependency closure and migration sources", {
  skip: process.platform === "win32",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "qisheng-migrate-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const link = (path, target) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(relative(dirname(join(root, path)), join(root, target)), join(root, path), "dir");
  };
  write(
    "node_modules/.pnpm/prisma/node_modules/prisma/index.js",
    'module.exports=require("@fixture/config")',
  );
  write(
    "node_modules/.pnpm/config/node_modules/@fixture/config/index.js",
    'module.exports=require("dep")',
  );
  write("node_modules/.pnpm/dep/node_modules/dep/index.js", "module.exports=42");
  write("node_modules/.pnpm/unused/node_modules/unused/index.js", "unrelated build dependency");
  link("node_modules/prisma", "node_modules/.pnpm/prisma/node_modules/prisma");
  link(
    "node_modules/.pnpm/prisma/node_modules/@fixture/config",
    "node_modules/.pnpm/config/node_modules/@fixture/config",
  );
  link("node_modules/.pnpm/config/node_modules/dep", "node_modules/.pnpm/dep/node_modules/dep");
  link(
    "node_modules/.pnpm/dep/node_modules/prisma",
    "node_modules/.pnpm/prisma/node_modules/prisma",
  );
  write("prisma/schema.prisma", "fixture schema");
  write("prisma/migrations/fixture/migration.sql", "SELECT 1;");
  write("prisma.config.ts", 'export default { schema: "prisma/schema.prisma" }');
  const bundleRoot = join(root, "bundle");
  assembleRuntime("migrate", { root, bundleRoot });
  rmSync(join(root, "node_modules"), { recursive: true });
  const bundle = join(bundleRoot, "migrate");
  assert.equal(createRequire(join(bundle, "package.json"))("prisma"), 42);
  assert.equal(existsSync(join(bundle, "node_modules/.pnpm/unused")), false);
  assert.equal(readFileSync(join(bundle, "prisma/schema.prisma"), "utf8"), "fixture schema");
  assert.equal(
    readFileSync(join(bundle, "prisma/migrations/fixture/migration.sql"), "utf8"),
    "SELECT 1;",
  );
  assert.ok(existsSync(join(bundle, "prisma.config.ts")));
});

test("Linux runtime preserves pnpm relative symlinks and resolves the copied module", {
  skip: !process.env.QISHENG_SYMLINK_TEST_IMAGE,
}, () => {
  const code = `const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{createRequire}=require("node:module"),{cpSync}=fs;const copyRuntimeTree=${copyRuntimeTree.toString()};const root=fs.mkdtempSync("/tmp/qisheng-link-");try{const source=path.join(root,"source"),destination=path.join(root,"runtime");fs.mkdirSync(path.join(source,"node_modules/.pnpm/fixture/node_modules/fixture"),{recursive:true});fs.writeFileSync(path.join(source,"node_modules/.pnpm/fixture/node_modules/fixture/index.js"),"module.exports=42");fs.symlinkSync(".pnpm/fixture/node_modules/fixture",path.join(source,"node_modules/fixture"));copyRuntimeTree(source,destination);assert.equal(fs.readlinkSync(path.join(destination,"node_modules/fixture")),".pnpm/fixture/node_modules/fixture");fs.rmSync(source,{recursive:true});assert.equal(createRequire(path.join(destination,"package.json"))("fixture"),42);console.log("RUNTIME_SYMLINK_OK");}finally{fs.rmSync(root,{recursive:true,force:true});}`;
  const result = runLocalContainer([
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    "none",
    "--entrypoint",
    "node",
    process.env.QISHENG_SYMLINK_TEST_IMAGE,
    "-e",
    code,
  ]);
  assert.match(result.stdout, /RUNTIME_SYMLINK_OK/);
});
