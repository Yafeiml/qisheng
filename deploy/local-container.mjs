import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, openSync, readSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** All local image operations use the same Windows WSLC session, never a Docker context. */
export function runLocalContainer(args, options = {}) {
  const {
    cwd,
    env = process.env,
    capture = true,
    run = spawnSync,
    platform = process.platform,
  } = options;
  if (platform !== "win32") throw new Error("本机构建和镜像管理须从 Windows 通过 wslc.exe 执行。");
  const session = env.QISHENG_WSLC_SESSION;
  if (session && !/^[A-Za-z0-9._-]+$/u.test(session)) throw new Error("WSLC 会话名称无效。");
  const result = run("wslc.exe", [...(session ? ["--session", session] : []), ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `本机 WSLC ${args[0]} 失败：${result.stderr || result.error?.message || `exit=${result.status}`}`,
    );
  return result;
}

export function inspectLocalImage(image, options = {}) {
  const result = runLocalContainer(["image", "inspect", image], { ...options, capture: true });
  const value = JSON.parse(result.stdout);
  const actual = Array.isArray(value) ? value[0] : value;
  if (!actual?.Id || !/^sha256:[a-f0-9]{64}$/u.test(actual.Id))
    throw new Error("WSLC 镜像身份无效。");
  return actual;
}

export function fileSha256(path) {
  const hash = createHash("sha256"),
    file = openSync(path, "r"),
    buffer = Buffer.alloc(1024 * 1024);
  try {
    let length = readSync(file, buffer, 0, buffer.length, null);
    while (length > 0) {
      hash.update(buffer.subarray(0, length));
      length = readSync(file, buffer, 0, buffer.length, null);
    }
    return hash.digest("hex");
  } finally {
    closeSync(file);
  }
}

/** Stream large image archives through Node zlib; never pipe binary output through PowerShell. */
export function saveImageArchive(images, archive, options = {}) {
  if (
    !Array.isArray(images) ||
    !images.length ||
    images.some((image) => !/^qisheng\/(api|web|worker|readback):[A-Za-z0-9._-]+$/u.test(image))
  )
    throw new Error("镜像归档范围无效。");
  const output = resolve(archive);
  if (existsSync(output)) throw new Error("拒绝覆盖已有镜像归档。");
  const token = randomUUID(),
    raw = resolve(dirname(output), `.images-${token}.tar`),
    partial = `${output}.${token}.part`;
  try {
    runLocalContainer(["save", "--output", raw, ...images], { ...options, capture: false });
    const code =
      'import {createReadStream,createWriteStream} from "node:fs";import {createGzip} from "node:zlib";import {pipeline} from "node:stream/promises";await pipeline(createReadStream(process.argv[1]),createGzip({level:1}),createWriteStream(process.argv[2],{flags:"wx",mode:0o600}));';
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, raw, partial], {
      encoding: "utf8",
    });
    if (result.error || result.status !== 0)
      throw new Error(`镜像归档压缩失败：${result.stderr || result.error?.message}`);
    const sha256 = fileSha256(partial);
    // A same-directory hard link publishes atomically and fails if another
    // process created the output after our initial existence check.
    linkSync(partial, output);
    return { archive: output, sha256 };
  } finally {
    rmSync(raw, { force: true });
    rmSync(partial, { force: true });
  }
}
