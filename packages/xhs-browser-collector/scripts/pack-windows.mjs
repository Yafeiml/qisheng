import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const outputRoot = join(repoRoot, "output", "releases", "xhs-browser-collector-edge-windows");
const runtimeModules = [
  "api",
  "browser",
  "browser-channel",
  "collector",
  "image-hash",
  "main",
  "mcp",
  "mock-check",
  "note-selectors",
  "once",
  "parser",
  "profile-preflight",
  "security",
  "store",
  "types",
  "verify-bundle",
];
const windowsDependencies = [
  "@img/colour",
  "@img/sharp-win32-x64",
  "detect-libc",
  "playwright-core",
  "semver",
  "sharp",
];
const stage = await mkdtemp(join(tmpdir(), "xhs-collector-win-bundle-"));
const installRoot = await mkdtemp(join(tmpdir(), "xhs-collector-win-deps-"));

try {
  const projectManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const collectorManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  await mkdir(join(stage, "dist"));
  await mkdir(join(stage, "workbuddy-skill"));
  const manifest = {
    name: "xhs-browser-collector-windows",
    version: "0.1.0",
    private: true,
    packageManager: projectManifest.packageManager,
    engines: collectorManifest.engines,
    scripts: {
      start: "node dist/main.js",
      once: "node dist/main.js --once",
      "mock:check": "node dist/mock-check.js",
    },
    dependencies: collectorManifest.dependencies,
  };
  await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const filename of ["README.md", "workbuddy-skill/SKILL.md"]) {
    await copyFile(join(packageRoot, filename), join(stage, filename));
  }
  for (const module of runtimeModules) {
    const relative = `dist/${module}.js`;
    await copyFile(join(packageRoot, relative), join(stage, relative));
  }
  // Generate a standalone, pinned lockfile without transferring Linux node_modules or the repo.
  const install = spawnSync(
    join(repoRoot, "scripts", "dev", "pnpm.sh"),
    ["install", "--lockfile-only", "--offline", "--ignore-scripts"],
    { cwd: stage, encoding: "utf8", timeout: 45_000 },
  );
  if (install.status !== 0) throw new Error("STANDALONE_LOCKFILE_GENERATION_FAILED");
  // Resolve the pinned packages on the build machine. The target Windows host
  // runs Node directly; WorkBuddy never invokes pnpm, wmic or an install script.
  await copyFile(join(stage, "package.json"), join(installRoot, "package.json"));
  await copyFile(join(stage, "pnpm-lock.yaml"), join(installRoot, "pnpm-lock.yaml"));
  await writeFile(
    join(installRoot, "pnpm-workspace.yaml"),
    "supportedArchitectures:\n  os:\n    - linux\n    - win32\n  cpu:\n    - x64\n  libc:\n    - glibc\n",
  );
  const dependencyInstall = spawnSync(
    join(repoRoot, "scripts", "dev", "pnpm.sh"),
    ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted"],
    { cwd: installRoot, encoding: "utf8", timeout: 120_000 },
  );
  if (dependencyInstall.status !== 0) throw new Error("WINDOWS_DEPENDENCIES_NOT_RESOLVED");
  for (const name of windowsDependencies) {
    const source = join(installRoot, "node_modules", name);
    const destination = join(stage, "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: false });
  }
  const native = join(stage, "node_modules", "@img", "sharp-win32-x64", "lib");
  if (!(await readdir(native)).some((name) => name.endsWith(".node"))) {
    throw new Error("WINDOWS_NATIVE_SHARP_MISSING");
  }
  const listing = await readdir(stage);
  const allowed = new Set([
    "README.md",
    "dist",
    "node_modules",
    "package.json",
    "pnpm-lock.yaml",
    "workbuddy-skill",
  ]);
  if (listing.some((name) => !allowed.has(name))) {
    throw new Error("UNEXPECTED_BUNDLE_CONTENT");
  }
  const included = await listRegularFiles(stage);
  const entries = [];
  for (const relative of included) {
    const checksum = createHash("sha256")
      .update(await readFile(join(stage, relative)))
      .digest("hex");
    entries.push(`${checksum}  ${relative}`);
  }
  await writeFile(join(stage, "SHA256SUMS.txt"), `${entries.join("\n")}\n`);
  await mkdir(outputRoot, { recursive: true });
  const digest = createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 12);
  const archive = join(outputRoot, `xhs-browser-collector-windows-${digest}.tar.gz`);
  if (existsSync(archive) || existsSync(`${archive}.sha256`)) {
    throw new Error("BUNDLE_ALREADY_EXISTS");
  }
  const tar = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { timeout: 45_000 });
  if (tar.status !== 0) throw new Error("COLLECTOR_BUNDLE_ARCHIVE_FAILED");
  const archiveHash = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(`${archive}.sha256`, `${archiveHash}  ${basename(archive)}\n`, { flag: "wx" });
  process.stdout.write(`${archive}\nsha256 ${archiveHash}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
  await rm(installRoot, { recursive: true, force: true });
}

async function listRegularFiles(root, directory = root) {
  const included = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("BUNDLE_SYMLINK_FORBIDDEN");
    if (entry.isDirectory()) included.push(...(await listRegularFiles(root, path)));
    else if (entry.isFile()) {
      if (!(await lstat(path)).isFile()) throw new Error("BUNDLE_FILE_UNSAFE");
      included.push(path.slice(root.length + 1).replaceAll("\\", "/"));
    } else throw new Error("BUNDLE_FILE_UNSAFE");
  }
  return included.sort();
}
