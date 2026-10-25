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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { exportMiniapp } from "./export.mjs";

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qisheng-miniapp-export-"));
  temporary.push(root);
  const source = join(root, "apps/employee-miniapp");
  const file = (path, text) => {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), text);
  };
  for (const name of [
    "app.ts",
    "app.json",
    "app.wxss",
    "sitemap.json",
    "types.ts",
    "README.md",
    "pages/login/login.ts",
    "utils/api.ts",
    "utils/generated/captcha.js",
    "utils/generated/LICENSE.noble-hashes",
  ])
    file(name, name);
  file(
    "project.config.json",
    JSON.stringify({ appid: "touristappid", setting: { urlCheck: false } }),
  );
  file("project.private.config.json", "private IDE settings");
  file("config.ts", "source template");
  file("utils/.env", "private settings");
  file("utils/node_modules/package/index.js", "dependency");
  for (const name of ["LICENSE", "NOTICE"]) writeFileSync(join(root, name), name);
  const options = {
    root,
    output: join(root, "export"),
    appId: `wx${"0".repeat(16)}`,
    apiBase: "https://demo.example.test/api/",
  };
  return { root, source, options };
}
test("exports an independent native project with public instance configuration and licenses", () => {
  const { source, options } = fixture();
  const result = exportMiniapp({ ...options, smsLogin: true });
  assert.equal(result.apiBaseUrl, "https://demo.example.test/api");
  assert.match(readFileSync(join(options.output, "config.ts"), "utf8"), /"smsLoginEnabled": true/u);
  const project = JSON.parse(readFileSync(join(options.output, "project.config.json"), "utf8"));
  assert.equal(project.appid, options.appId);
  assert.equal(project.setting.urlCheck, true);
  for (const path of [
    "LICENSE",
    "NOTICE",
    "utils/generated/captcha.js",
    "utils/generated/LICENSE.noble-hashes",
  ])
    assert.ok(existsSync(join(options.output, path)));
  for (const path of [
    "project.private.config.json",
    "utils/.env",
    "utils/node_modules",
    "package.json",
    "tsconfig.json",
  ])
    assert.equal(existsSync(join(options.output, path)), false);
  assert.equal(readFileSync(join(source, "config.ts"), "utf8"), "source template");
});
test("keeps SMS off and permits only an explicit tourist source template without a real AppID", () => {
  const { options } = fixture();
  exportMiniapp({ ...options, appId: "touristappid" });
  assert.match(
    readFileSync(join(options.output, "config.ts"), "utf8"),
    /"smsLoginEnabled": false/u,
  );
});
test("refuses to overwrite an existing configured project", () => {
  const { options } = fixture();
  mkdirSync(options.output);
  writeFileSync(join(options.output, "config.ts"), "keep existing configuration");
  assert.throws(() => exportMiniapp(options), /不会覆盖/u);
  assert.equal(
    readFileSync(join(options.output, "config.ts"), "utf8"),
    "keep existing configuration",
  );
});
test("refuses output inside miniapp sources", () => {
  const { options, source } = fixture();
  assert.throws(() => exportMiniapp({ ...options, output: join(source, "export") }), /源码之外/u);
});
test("rejects invalid AppIDs and unsafe production addresses before writing output", () => {
  const { options } = fixture();
  assert.throws(() => exportMiniapp({ ...options, appId: "another-app" }), /AppID/u);
  const withCredentials = new URL("https://demo.example.test/api");
  withCredentials.username = "fixture-user";
  withCredentials.password = "fixture-password";
  for (const apiBase of [
    "http://demo.example.test/api",
    "https://127.0.0.1/api",
    "https://localhost/api",
    "https://demo.example.test/api?token=fixture",
    withCredentials.href,
    "https://demo.example.test/api#fragment",
  ])
    assert.throws(() => exportMiniapp({ ...options, apiBase }));
  assert.equal(existsSync(options.output), false);
});
test("refuses source directory links instead of copying their contents", () => {
  const { root, source, options } = fixture();
  const other = join(root, "external");
  mkdirSync(other);
  symlinkSync(other, join(source, "utils/linked"), "junction");
  assert.throws(() => exportMiniapp(options), /符号链接/u);
  assert.equal(existsSync(options.output), false);
});
