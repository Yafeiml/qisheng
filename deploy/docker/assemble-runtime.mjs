import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function copyRuntimeTree(source, destination) {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

function copyPnpmPackage(name, root, bundle) {
  const modules = resolve(root, "node_modules");
  const visited = new Set();
  const visit = (source) => {
    let group = dirname(realpathSync(source));
    while (basename(group) !== "node_modules" && dirname(group) !== group) group = dirname(group);
    const nested = relative(modules, group);
    if (!nested || nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested))
      throw new Error("Prisma CLI dependency outside pnpm installation");
    if (visited.has(group)) return;
    visited.add(group);
    copyRuntimeTree(group, resolve(bundle, "node_modules", nested));
    const dependencies = readdirSync(group, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() && entry.name.startsWith("@")
        ? readdirSync(resolve(group, entry.name), { withFileTypes: true }).map((scoped) => ({
            entry: scoped,
            path: resolve(group, entry.name, scoped.name),
          }))
        : [{ entry, path: resolve(group, entry.name) }],
    );
    for (const dependency of dependencies)
      if (dependency.entry.isSymbolicLink()) visit(dependency.path);
  };
  visit(resolve(modules, name));
  copyRuntimeTree(resolve(modules, name), resolve(bundle, "node_modules", name));
}

export function assembleRuntime(service, { root = process.cwd(), bundleRoot = "/bundle" } = {}) {
  if (!["api", "web", "worker", "readback", "migrate"].includes(service))
    throw new Error("Unknown image service");
  const bundle = resolve(bundleRoot, service);
  if (service === "migrate") {
    copyPnpmPackage("prisma", root, bundle);
    copyRuntimeTree(resolve(root, "prisma"), `${bundle}/prisma`);
    cpSync(resolve(root, "prisma.config.ts"), `${bundle}/prisma.config.ts`);
  } else if (service === "web") {
    copyRuntimeTree(resolve(root, "apps/admin-web/.next/standalone"), bundle);
    mkdirSync(`${bundle}/apps/admin-web/.next/cache`, { recursive: true });
    copyRuntimeTree(
      resolve(root, "apps/admin-web/.next/static"),
      `${bundle}/apps/admin-web/.next/static`,
    );
    if (existsSync(resolve(root, "apps/admin-web/public")))
      copyRuntimeTree(resolve(root, "apps/admin-web/public"), `${bundle}/apps/admin-web/public`);
  } else if (service === "api" || service === "worker") {
    const workspace = createRequire(resolve(root, "package.json"));
    const client = dirname(
      workspace.resolve(".prisma/client/default", { paths: [workspace.resolve("@prisma/client")] }),
    );
    const app = createRequire(`${bundle}/package.json`),
      database = createRequire(app.resolve("@xhs-agentic/database"));
    const modules = resolve(dirname(database.resolve("@prisma/client/package.json")), "../..");
    const nested = relative(`${bundle}/node_modules`, modules);
    if (nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested))
      throw new Error("Prisma runtime outside deploy bundle");
    mkdirSync(`${modules}/.prisma`, { recursive: true });
    copyRuntimeTree(client, `${modules}/.prisma/client`);
    if (service === "worker") {
      mkdirSync(`${bundle}/ops`, { recursive: true });
      cpSync(
        resolve(root, "deploy/docker/worker-preflight.cjs"),
        `${bundle}/ops/worker-preflight.cjs`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  assembleRuntime(process.argv[2]);
