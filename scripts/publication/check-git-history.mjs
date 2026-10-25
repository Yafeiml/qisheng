import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { inspectSourceText, privatePath } from "./check-source-publication.mjs";

const blobLimit = 16 * 1024 * 1024;
const placeholderEmail =
  /(?:@localhost$|@(?:[^@.]+\.)*(?:example\.(?:com|org|invalid)|invalid|test|local)$)/iu;

function readObjects(root, objects) {
  const data = new Map();
  let group = [];
  let groupBytes = 0;
  const flush = () => {
    if (!group.length) return;
    const bytes = execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-c",
        `safe.directory=${root.replaceAll("\\", "/")}`,
        "cat-file",
        "--batch",
      ],
      {
        cwd: root,
        input: `${group.map(({ hash }) => hash).join("\n")}\n`,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    for (let cursor = 0; cursor < bytes.length; ) {
      const end = bytes.indexOf(10, cursor);
      const [hash, , sizeText] = bytes.subarray(cursor, end).toString("utf8").split(" ");
      const size = Number(sizeText);
      if (end < cursor || !Number.isSafeInteger(size) || size < 0)
        throw new Error("Invalid Git object response");
      data.set(hash, bytes.subarray(end + 1, end + 1 + size));
      cursor = end + 1 + size + 1;
    }
    group = [];
    groupBytes = 0;
  };
  for (const object of objects.filter(({ size }) => size <= blobLimit)) {
    if (groupBytes + object.size > 32 * 1024 * 1024) flush();
    group.push(object);
    groupBytes += object.size;
  }
  flush();
  return data;
}

function mapObjectPaths(objects, data, refs) {
  const trees = new Map();
  const children = new Set();
  const hashBytes = objects[0]?.hash.length / 2;
  for (const { hash, type } of objects) {
    if (type !== "tree" || !data.has(hash)) continue;
    const bytes = data.get(hash);
    const entries = [];
    for (let cursor = 0; cursor < bytes.length; ) {
      const space = bytes.indexOf(32, cursor);
      const nul = bytes.indexOf(0, space + 1);
      if (space < cursor || nul < space || nul + 1 + hashBytes > bytes.length)
        throw new Error("Invalid Git tree response");
      const mode = bytes.subarray(cursor, space).toString("ascii");
      const entry = {
        name: bytes.subarray(space + 1, nul).toString("utf8"),
        hash: bytes.subarray(nul + 1, nul + 1 + hashBytes).toString("hex"),
        type: mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob",
      };
      entries.push(entry);
      if (entry.type === "tree") children.add(entry.hash);
      cursor = nul + 1 + hashBytes;
    }
    trees.set(hash, entries);
  }
  const roots = new Set([...trees.keys()].filter((hash) => !children.has(hash)));
  for (const { hash, type } of objects.filter(({ type }) => type === "commit")) {
    const tree = /^tree ([0-9a-f]+)$/mu.exec(data.get(hash)?.toString("utf8") || "")?.[1];
    if (type === "commit" && tree) roots.add(tree);
  }
  for (const ref of refs.filter(({ type }) => type === "tree")) roots.add(ref.hash);
  const paths = new Map();
  for (const root of roots) {
    const pending = [{ hash: root, path: "" }];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of trees.get(current.hash) || []) {
        const path = current.path ? `${current.path}/${entry.name}` : entry.name;
        if (entry.type === "tree") pending.push({ hash: entry.hash, path });
        else if (entry.type === "blob") {
          if (!paths.has(entry.hash)) paths.set(entry.hash, new Set());
          paths.get(entry.hash).add(path);
        }
      }
    }
  }
  return paths;
}

function inspectTar(bytes, path, object, findings) {
  let contents;
  try {
    contents = /\.(?:tgz|gz)$/iu.test(path)
      ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
      : bytes;
  } catch {
    findings.push({ path, object, rule: "ARCHIVE_CONTENT_NOT_SCANNED", level: "review" });
    return { entries: 0, textEntries: 0, binaryEntries: 0 };
  }
  const summary = { entries: 0, textEntries: 0, binaryEntries: 0 };
  for (let offset = 0; offset + 512 <= contents.length; ) {
    const header = contents.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/su, "");
    const size = Number.parseInt(
      header.subarray(124, 136).toString("ascii").replace(/\0.*$/su, "").trim() || "0",
      8,
    );
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > contents.length) {
      findings.push({ path, object, rule: "ARCHIVE_CONTENT_NOT_SCANNED", level: "review" });
      break;
    }
    const member = `${path}!/${prefix ? `${prefix}/` : ""}${name}`;
    const type = header[156];
    summary.entries++;
    if (type === 0 || type === 48) {
      if (
        privatePath.test(prefix ? `${prefix}/${name}` : name) &&
        !/(?:^|\/)\.env\.example$/u.test(name)
      )
        findings.push({ path: member, object, rule: "PRIVATE_ARCHIVE_MEMBER", level: "blocker" });
      const file = contents.subarray(offset + 512, offset + 512 + size);
      if (size > blobLimit || file.includes(0)) summary.binaryEntries++;
      else {
        summary.textEntries++;
        findings.push(
          ...inspectSourceText(member, file.toString("utf8")).map((finding) => ({
            ...finding,
            object,
          })),
        );
      }
    } else if (![53, 120, 103].includes(type)) {
      findings.push({
        path: member,
        object,
        rule: "ARCHIVE_SPECIAL_MEMBER_REVIEW",
        level: "review",
      });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return summary;
}

// Reports locations and rules only. It neither changes Git state nor reads ignored working files.
export function inspectGitHistory(root) {
  root = realpathSync(root);
  const git = (...args) =>
    execFileSync(
      "git",
      ["--no-replace-objects", "-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  const top = realpathSync(git("rev-parse", "--show-toplevel").trim());
  if (relative(top, root) !== "")
    throw new Error("Git history checks require their own Git repository root");
  const objects = git(
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, type, size] = line.trim().split(" ");
      return { hash, type, size: Number(size) };
    });
  const refs = git("for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, hash, type] = line.trim().split("\0");
      return { name, hash, type };
    });
  const data = readObjects(root, objects);
  const paths = mapObjectPaths(objects, data, refs);
  const reachable = new Set(
    git("rev-list", "--all", "--reflog", "--objects")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")[0]),
  );
  const findings = [];
  const binary = [];
  const counts = { textBlobs: 0, binaryBlobs: 0, largeObjectsNotScanned: 0, unmappedBlobs: 0 };
  for (const { hash, type, size } of objects) {
    const candidatePaths = [...(paths.get(hash) || [])].sort();
    const path = candidatePaths[0] || `git:${type}`;
    if (type === "blob") {
      if (!candidatePaths.length) counts.unmappedBlobs++;
      for (const path of candidatePaths)
        if (privatePath.test(path) && !/(?:^|\/)\.env\.example$/u.test(path))
          findings.push({ path, object: hash, rule: "PRIVATE_PATH_IN_HISTORY", level: "blocker" });
    }
    if (size > blobLimit) {
      counts.largeObjectsNotScanned++;
      findings.push({
        path,
        object: hash,
        rule: "LARGE_HISTORY_OBJECT_NOT_SCANNED",
        level: "review",
      });
      continue;
    }
    const bytes = data.get(hash);
    if (type === "tree") continue;
    if (type === "blob" && bytes.includes(0)) {
      counts.binaryBlobs++;
      const entry = { object: hash, paths: candidatePaths, size };
      if (/\.(?:tar(?:\.gz)?|tgz)$/iu.test(path))
        entry.archive = inspectTar(bytes, path, hash, findings);
      binary.push(entry);
      continue;
    }
    if (type === "blob") counts.textBlobs++;
    const text = bytes.toString("utf8");
    findings.push(
      ...inspectSourceText(path, text).map((finding) => ({ ...finding, object: hash })),
    );
    if (type === "commit" || type === "tag")
      for (const [index, line] of text.split("\n").entries()) {
        const email = /^(?:author|committer|tagger) .* <([^>]+)>/u.exec(line)?.[1];
        if (email && !placeholderEmail.test(email))
          findings.push({
            path,
            object: hash,
            line: index + 1,
            rule: "GIT_IDENTITY_EMAIL_REVIEW",
            level: "review",
          });
      }
  }
  const reflogs = git("reflog", "show", "--all", "--format=%H%x00%gE%x00%gs")
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const [index, entry] of reflogs.entries()) {
    const [object, email, message] = entry.split("\0");
    findings.push(
      ...inspectSourceText("git:reflog", message || "").map(({ rule, level }) => ({
        path: "git:reflog",
        line: index + 1,
        object,
        rule,
        level,
      })),
    );
    if (email && !placeholderEmail.test(email))
      findings.push({
        path: "git:reflog",
        line: index + 1,
        object,
        rule: "GIT_IDENTITY_EMAIL_REVIEW",
        level: "review",
      });
  }
  const config = git("config", "--no-includes", "--local", "--null", "--list")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const newline = entry.indexOf("\n");
      return { key: entry.slice(0, newline), value: entry.slice(newline + 1) };
    });
  for (const [index, entry] of config.entries()) {
    const credential = /(?:credential|authorization|extraheader)/iu.test(entry.key);
    if (credential)
      findings.push({
        path: "git:config",
        line: index + 1,
        rule: "GIT_CREDENTIAL_CONFIG_REVIEW",
        level: "review",
      });
    findings.push(
      ...inspectSourceText("git:config", entry.value).map(({ rule, level }) => ({
        path: "git:config",
        line: index + 1,
        rule,
        level,
      })),
    );
  }
  return {
    status: findings.some(({ level }) => level === "blocker")
      ? "BLOCKED"
      : "REQUIRES_MANUAL_REVIEW",
    refs,
    objects: {
      total: objects.length,
      types: objects.reduce((result, { type }) => {
        result[type] = (result[type] || 0) + 1;
        return result;
      }, {}),
      unreachable: objects.filter(({ hash }) => !reachable.has(hash)).length,
      ...counts,
    },
    reflogEntries: reflogs.length,
    config: {
      remoteUrlPresent: config.some(({ key }) => /^remote\..+\.(?:url|pushurl)$/iu.test(key)),
      credentialConfigurationPresent: config.some(({ key }) =>
        /(?:credential|authorization|extraheader)/iu.test(key),
      ),
      hooksPathPresent: config.some(({ key }) => key.toLowerCase() === "core.hookspath"),
      externalIncludesPresent: config.some(({ key }) =>
        /^(?:include|includeif\..+)\.path$/iu.test(key),
      ),
    },
    findings: findings.map((finding) => ({
      ...finding,
      ...(finding.object ? { reachable: reachable.has(finding.object) } : {}),
    })),
    binary,
    limitations: [
      "Scans all local Git objects, including unreachable objects, without fixture suppressions; findings may describe test data or private operations documents rather than live credentials.",
      "Reads Git metadata only; ignored working-tree secrets, external credential stores, configuration include files and remote repositories are not read.",
      "Binary blobs are inventoried, not OCR/privacy reviewed. Tar/tgz regular text members are inspected in memory up to 64 MiB expanded; other binary formats, large objects and external LFS contents remain unverified.",
      "Output contains locations, hashes and rules only. Refs, reflogs, configuration, source files and history are not changed. Never publish the workspace .git or push it with --mirror.",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = inspectGitHistory(resolve(process.cwd()));
    if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `${result.status}: ${result.objects.total} Git objects; ${result.objects.unreachable} unreachable; ${result.findings.length} findings.`,
      );
      for (const { path, line, object, rule, level } of result.findings)
        console.log(
          `${level}: ${path}${line ? `:${line}` : ""}${object ? ` (${object})` : ""} [${rule}]`,
        );
      for (const limitation of result.limitations) console.log(limitation);
    }
    process.exitCode = result.status === "BLOCKED" ? 1 : 0;
  } catch {
    console.error(
      "Git history inspection failed; no source or configuration content was printed. Verify local repository access.",
    );
    process.exitCode = 1;
  }
}
