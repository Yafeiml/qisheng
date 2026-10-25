#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "deploy");
export const services = ["api", "web", "worker", "migrate"];

export function initializeEnvironment(template) {
  const generated = template.replaceAll(/GENERATE_[A-Z_]+/gu, () =>
    randomBytes(32).toString("base64"),
  );
  const env = parseEnv(generated);
  if (!env.POSTGRES_PASSWORD || !env.REDIS_PASSWORD) return generated;
  return replaceEnvironment(generated, {
    DATABASE_URL: connectionUrl("postgresql", {
      host: "postgres",
      port: "5432",
      username: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
    }),
    REDIS_URL: connectionUrl("redis", {
      host: "redis",
      port: "6379",
      username: "default",
      password: env.REDIS_PASSWORD,
      database: "0",
    }),
  });
}

export function connectionUrl(protocol, { host, port, username, password, database, tls = false }) {
  if (!["postgresql", "redis"].includes(protocol) || !host?.trim() || !database?.trim())
    throw new Error("请填写服务地址和数据库名称。");
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("端口必须为 1–65535。");
  if (/[/@?#\s]/u.test(host)) throw new Error("服务地址只填写主机名或 IP，不包含协议和路径。");
  if (protocol === "redis" && !/^\d+$/u.test(database))
    throw new Error("Redis 数据库编号必须为非负整数。");
  const encode = (value) => encodeURIComponent(value ?? "").replaceAll("'", "%27");
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const scheme = protocol === "redis" && tls ? "rediss" : protocol;
  const url = new URL(`${scheme}://${hostname}:${port}/${encode(database)}`);
  if (username || password) {
    url.username = encode(username);
    url.password = encode(password);
  }
  if (protocol === "postgresql" && tls) url.searchParams.set("sslmode", "require");
  return url.href;
}

export function replaceEnvironment(template, values) {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z_]+$/u.test(key) || /['\r\n\0]/u.test(value))
      throw new Error("配置中不能包含换行、空字符或单引号。");
    if (!new RegExp(`^${key}=`, "mu").test(template)) throw new Error(`Unknown setting: ${key}`);
    // Single quotes also prevent Compose from expanding dollar signs in user credentials.
    template = template.replace(new RegExp(`^${key}=.*$`, "mu"), () => `${key}='${value}'`);
  }
  return template;
}

function writeEnvironment(value) {
  writeFileSync(resolve(directory, ".env"), value, { flag: "wx", mode: 0o600 });
  console.log("已创建私有 deploy/.env；原配置与密钥不会被覆盖。");
  console.log("镜像交付后按 deploy/README.md 用 Docker Compose 启动，再打开 /setup 完成网页安装。");
  if (process.stdout.isTTY)
    console.log(`网页安装凭证（仅用于首次安装）：${parseEnv(value).INSTALLATION_TOKEN}`);
  else console.log("首次安装凭证保存在 deploy/.env 的 INSTALLATION_TOKEN；不要上传或公开该文件。");
}

async function configure() {
  if (existsSync(resolve(directory, ".env"))) throw Object.assign(new Error(), { code: "EEXIST" });
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("请在交互终端运行配置引导。");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  const abort = new AbortController();
  terminal.on("SIGINT", () => abort.abort());
  const ask = async (label, fallback = "", secret = false) => {
    process.stdout.write(`${label}${fallback ? ` [${fallback}]` : ""}：`);
    muted = secret;
    try {
      return (await terminal.question("", { signal: abort.signal })) || fallback;
    } finally {
      if (secret) process.stdout.write("\n");
      muted = false;
    }
  };
  try {
    console.log(
      "默认自动配置 PostgreSQL 和 Redis；已有服务的用户选择外部模式。不会启动容器或修改已有数据库。",
    );
    const mode = await ask("数据库模式（1 自动配置 / 2 连接现有服务）", "1");
    if (!["1", "2"].includes(mode)) throw new Error("请选择 1 或 2。");
    let value = initializeEnvironment(readFileSync(resolve(directory, ".env.example"), "utf8"));
    const port = await ask("Web 访问端口", "3101");
    if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error("Web 端口必须为 1–65535。");
    const version = await ask(
      "本次镜像版本（升级时使用新版本）",
      `v${new Date().toISOString().replace(/\D/gu, "").slice(0, 14)}`,
    );
    imageBuildArguments("api", version);
    value = replaceEnvironment(value, {
      QISHENG_VERSION: version,
      WEB_BIND_PORT: port,
    });
    if (mode === "2") {
      const connection = async (protocol) => {
        const postgres = protocol === "postgresql";
        const label = postgres ? "PostgreSQL" : "Redis";
        const host = await ask(`${label} 地址（容器内可访问）`, "host.docker.internal");
        const port = await ask(`${label} 端口`, postgres ? "5432" : "6379");
        const username = await ask(`${label} 用户名`, postgres ? "qisheng" : "default");
        const password = await ask(`${label} 密码（不回显）`, "", true);
        const database = await ask(
          postgres ? "数据库名称" : "Redis 数据库编号",
          postgres ? "qisheng" : "0",
        );
        const tls = (await ask(`${label} 是否启用 TLS（y/N）`, "n")).toLowerCase() === "y";
        return connectionUrl(protocol, { host, port, username, password, database, tls });
      };
      value = replaceEnvironment(value, {
        COMPOSE_PROFILES: "",
        QISHENG_DATABASE_MODE: "external",
        DATABASE_URL: await connection("postgresql"),
        REDIS_URL: await connection("redis"),
      });
    }
    writeEnvironment(value);
    console.log(
      "内置数据库会等待健康后迁移；外部连接可单独运行 check 检查，迁移失败不会启动应用。",
    );
  } finally {
    terminal.close();
  }
}

export const connectionProbe = `
const { Pool } = require('pg'); const Redis = require('ioredis');
(async () => {
  const pg = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, query_timeout:10000 });
  const redis = new Redis(process.env.REDIS_URL, {lazyConnect:true, connectTimeout:10000, commandTimeout:10000, maxRetriesPerRequest:0, retryStrategy:()=>null});
  redis.on('error', () => {});
  try {
    const result = await pg.query("SELECT name FROM pg_available_extensions WHERE name IN ('vector','btree_gist','pgcrypto','pg_trgm')");
    if (result.rows.length !== 4) throw new Error('数据库缺少 vector、btree_gist、pgcrypto 或 pg_trgm 扩展。');
    await redis.connect(); await redis.ping(); console.log('PostgreSQL / Redis 连接与扩展检测通过。');
  } catch { console.error('数据库或 Redis 检测失败；请检查地址、账号、密码、TLS、网络与 PostgreSQL 扩展。未执行迁移。'); process.exitCode=1; }
  finally { redis.disconnect(); await pg.end(); }
})();`;

function compose(...args) {
  const environment = existsSync(resolve(directory, ".env"))
    ? parseEnv(readFileSync(resolve(directory, ".env"), "utf8"))
    : {};
  const external =
    environment.QISHENG_DATABASE_MODE === "external" ||
    (!environment.QISHENG_DATABASE_MODE && environment.COMPOSE_PROFILES === "");
  const result = spawnSync(
    "docker",
    [
      "compose",
      ...(existsSync(resolve(directory, ".env")) ? ["--env-file", "deploy/.env"] : []),
      "-f",
      "deploy/compose.yml",
      ...(external ? ["-f", "deploy/compose.external.yml"] : []),
      ...args,
    ],
    { cwd: root, stdio: "inherit", shell: false, env: { ...process.env, ...environment } },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Compose 操作失败，已停止后续步骤；请检查服务状态。");
}

export function imageBuildArguments(service, version) {
  if (
    ![...services, "readback"].includes(service) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(version)
  )
    throw new Error("Invalid image service or version");
  return [
    "build",
    "--file",
    "deploy/docker/Dockerfile",
    "--target",
    service,
    "--tag",
    `qisheng/${service}:${version}`,
    ".",
  ];
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (command === "configure") return configure();
  if (command === "init") {
    const template = readFileSync(resolve(directory, ".env.example"), "utf8");
    writeEnvironment(initializeEnvironment(template));
    return;
  }
  if (["start", "check"].includes(command)) {
    if (process.platform === "win32")
      throw new Error(
        "请在实际 Linux 运行引擎所在的部署目录执行 start/check；Windows 仅用于配置与本机构建。",
      );
    if (command === "start") {
      compose("up", "-d", "--no-build");
      console.log("通过 http://服务器IP:端口 打开 /setup；域名和 DNS 不是安装前提。");
      return;
    }
    compose(
      "run",
      "--rm",
      "--no-deps",
      "--pull",
      "never",
      "-T",
      "api",
      "node",
      "-e",
      connectionProbe,
    );
    return;
  }
  if (command !== "build" && command !== "build-readback")
    throw new Error(
      "Usage: node deploy/self-host.mjs configure | init | build [version] | build-readback [version] | start | check",
    );
  const env = existsSync(resolve(directory, ".env"))
    ? parseEnv(readFileSync(resolve(directory, ".env"), "utf8"))
    : {};
  const version = args[1] ?? env.QISHENG_VERSION ?? "local";
  for (const service of command === "build-readback" ? ["readback"] : services) {
    const result = spawnSync(
      process.platform === "win32" ? "wslc.exe" : "docker",
      imageBuildArguments(service, version),
      {
        cwd: root,
        stdio: "inherit",
        shell: false,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Local ${service} image build failed (exit ${result.status})`);
  }
  console.log(
    `Built qisheng/${command === "build-readback" ? "readback" : "{api,web,worker,migrate}"}:${version}. Use QISHENG_VERSION=${version} with Docker Compose. Images must be explicitly transferred if the target uses a different engine.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      error.code === "EEXIST"
        ? "deploy/.env already exists; refusing to overwrite application keys."
        : error.message,
    );
    process.exitCode = 1;
  }
}
