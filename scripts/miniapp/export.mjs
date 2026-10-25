#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function exportMiniapp({ root, output, appId, apiBase, smsLogin = false }) {
  if (appId !== "touristappid" && !/^wx[0-9a-f]{16}$/u.test(appId ?? ""))
    throw new Error("填写自己的微信 AppID；touristappid 仅用于源码模板检查，不能发布。");
  const api = new URL(apiBase);
  if (
    api.protocol !== "https:" ||
    api.username ||
    api.password ||
    api.search ||
    api.hash ||
    isIP(api.hostname.replace(/^\[|\]$/gu, "")) ||
    !api.hostname.includes(".") ||
    api.hostname.endsWith(".localhost") ||
    api.hostname.endsWith(".local")
  )
    throw new Error("正式小程序需要不含凭据、查询参数和片段的 HTTPS 公网域名 API 前缀。");
  const source = realpathSync(resolve(root, "apps/employee-miniapp"));
  const target = resolve(realpathSync(dirname(resolve(output))), resolve(output).split(sep).at(-1));
  const inside = relative(source, target);
  if (
    existsSync(target) ||
    inside === "" ||
    (!isAbsolute(inside) && !inside.startsWith(`..${sep}`) && inside !== "..") ||
    target.split(sep).some((part) => part.toLowerCase() === ".git")
  )
    throw new Error("导出目标必须是小程序源码之外的新目录；不会覆盖已有项目。");
  const roots = [
    "app.ts",
    "app.json",
    "app.wxss",
    "sitemap.json",
    "types.ts",
    "README.md",
    "pages",
    "utils",
  ];
  const files = [];
  function collect(path) {
    const stat = lstatSync(resolve(source, path));
    if (stat.isSymbolicLink()) throw new Error("小程序源码不能包含符号链接。");
    if (stat.isDirectory()) {
      for (const name of readdirSync(resolve(source, path))) {
        if (["node_modules", ".git", ".artifacts"].includes(name) || name.startsWith(".")) continue;
        collect(`${path}/${name}`);
      }
    } else if (
      stat.isFile() &&
      !path.includes(".private.") &&
      (/\.(?:ts|js|json|wxml|wxss|png|jpe?g|webp|svg|md)$/u.test(path) ||
        /(?:^|\/)LICENSE(?:\.|$)/u.test(path))
    ) {
      files.push(path);
    }
  }
  for (const path of roots) collect(path);
  for (const required of ["utils/generated/captcha.js", "utils/generated/LICENSE.noble-hashes"])
    if (!files.includes(required))
      throw new Error("缺少验证码客户端或许可文件，请先运行 pnpm miniapp:captcha。");
  const project = JSON.parse(readFileSync(resolve(source, "project.config.json"), "utf8"));
  project.appid = appId;
  project.setting.urlCheck = true;
  mkdirSync(target, { mode: 0o700 });
  for (const path of files) {
    mkdirSync(dirname(resolve(target, path)), { recursive: true });
    writeFileSync(resolve(target, path), readFileSync(resolve(source, path)), { flag: "wx" });
  }
  const config = { apiBaseUrl: api.href.replace(/\/+$/u, ""), smsLoginEnabled: Boolean(smsLogin) };
  writeFileSync(
    resolve(target, "config.ts"),
    `export const miniappConfig = ${JSON.stringify(config, null, 2)};\n`,
    { flag: "wx" },
  );
  writeFileSync(resolve(target, "project.config.json"), `${JSON.stringify(project, null, 2)}\n`, {
    flag: "wx",
  });
  for (const name of ["LICENSE", "NOTICE"])
    writeFileSync(resolve(target, name), readFileSync(resolve(root, name)), { flag: "wx" });
  return {
    output: target,
    files: files.length + 4,
    appId,
    apiBaseUrl: config.apiBaseUrl,
    smsLoginEnabled: config.smsLoginEnabled,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        "app-id": { type: "string" },
        "api-base": { type: "string" },
        output: { type: "string" },
        "sms-login": { type: "boolean", default: false },
      },
    });
    if (!values["app-id"] || !values["api-base"] || !values.output)
      throw new Error(
        "Usage: node scripts/miniapp/export.mjs --app-id <AppID> --api-base https://your-domain/api --output <new-directory> [--sms-login]",
      );
    console.log(
      JSON.stringify(
        exportMiniapp({
          root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
          output: values.output,
          appId: values["app-id"],
          apiBase: values["api-base"],
          smsLogin: values["sms-login"],
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "小程序导出失败。");
    process.exitCode = 1;
  }
}
