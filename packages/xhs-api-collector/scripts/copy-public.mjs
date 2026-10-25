import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(resolve(root, "dist/public"), { recursive: true });
cpSync(resolve(root, "src/public"), resolve(root, "dist/public"), { recursive: true });
