const { spawn } = require("node:child_process");
const { createHmac, randomBytes } = require("node:crypto");
const {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { dirname, resolve } = require("node:path");
const { parseEnv } = require("node:util");

const appSecrets = [
  "MODEL_CREDENTIAL_ENCRYPTION_KEY",
  "ADMIN_JWT_SECRET",
  "EMPLOYEE_JWT_SECRET",
  "ADMIN_OTP_HMAC_SECRET",
  "EMPLOYEE_OTP_HMAC_SECRET",
];
const privateKeys = [...appSecrets, "POSTGRES_PASSWORD", "REDIS_PASSWORD", "INSTALLATION_TOKEN"];
const supplied = (value) =>
  typeof value === "string" && value !== "" && !value.startsWith("GENERATE_");
const configPath = () => process.env.QISHENG_RUNTIME_CONFIG || "/run/qisheng/runtime.json";

function loadConfig(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Private configuration must be a regular file");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (
    config.version !== 1 ||
    !config.environment ||
    privateKeys.some((key) => !supplied(config.environment[key]))
  )
    throw new Error("Private configuration is incomplete; refusing to replace existing keys");
  if (Buffer.from(config.environment.MODEL_CREDENTIAL_ENCRYPTION_KEY, "base64").length !== 32)
    throw new Error("Invalid encryption key in private configuration");
  return config.environment;
}

function saveOnce(file, content) {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    try {
      linkSync(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
}

function checkOverrides(environment, saved) {
  for (const key of privateKeys)
    if (supplied(environment[key]) && environment[key] !== saved[key])
      throw new Error(`Existing ${key} differs; refusing to rotate persisted installation keys`);
}

function initializeConfig(file, environment = process.env) {
  if (!existsSync(file)) {
    const existing = appSecrets.filter((key) => supplied(environment[key]));
    if (existing.length && existing.length !== appSecrets.length)
      throw new Error(
        "Provide all existing application keys together; partial key migration is unsafe",
      );
    if (supplied(environment.DATABASE_URL) && !existing.length)
      throw new Error(
        "Existing database connections require explicit application keys; do not replace an existing encryption key",
      );
    const template = existsSync(resolve(__dirname, "runtime.env.example"))
      ? resolve(__dirname, "runtime.env.example")
      : resolve(__dirname, "../.env.example");
    const values = parseEnv(readFileSync(template, "utf8"));
    for (const key of Object.keys(values)) {
      if (supplied(environment[key])) values[key] = environment[key];
      else if (values[key].startsWith("GENERATE_"))
        values[key] = randomBytes(32).toString("base64");
    }
    if (!supplied(environment.DATABASE_URL))
      values.DATABASE_URL = `postgresql://${encodeURIComponent(values.POSTGRES_USER)}:${encodeURIComponent(values.POSTGRES_PASSWORD)}@postgres:5432/${encodeURIComponent(values.POSTGRES_DB)}`;
    if (!supplied(environment.REDIS_URL))
      values.REDIS_URL = `redis://default:${encodeURIComponent(values.REDIS_PASSWORD)}@redis:6379/0`;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    saveOnce(file, `${JSON.stringify({ version: 1, environment: values }, null, 2)}\n`);
  }
  const saved = loadConfig(file);
  checkOverrides(environment, saved);
  for (const [name, key] of [
    ["postgres-user", "POSTGRES_USER"],
    ["postgres-database", "POSTGRES_DB"],
    ["postgres-password", "POSTGRES_PASSWORD"],
    ["redis-password", "REDIS_PASSWORD"],
  ]) {
    const passwordFile = resolve(dirname(file), name);
    saveOnce(passwordFile, saved[key]);
    if (readFileSync(passwordFile, "utf8") !== saved[key])
      throw new Error(
        "Persisted database configuration files differ; refusing to overwrite data credentials",
      );
    chmodSync(passwordFile, 0o600);
  }
  const readbackKeyFile = resolve(dirname(file), "readback-node-key");
  const readbackKey = createHmac("sha256", saved.ADMIN_JWT_SECRET)
    .update("qisheng:managed-readback-node:v1")
    .digest("base64");
  saveOnce(readbackKeyFile, readbackKey);
  const readbackStat = lstatSync(readbackKeyFile);
  if (
    !readbackStat.isFile() ||
    readbackStat.isSymbolicLink() ||
    readFileSync(readbackKeyFile, "utf8") !== readbackKey
  )
    throw new Error("Managed readback key differs; refusing to overwrite its identity");
  chmodSync(readbackKeyFile, 0o600);
  chmodSync(file, 0o600);
  chmodSync(dirname(file), 0o700);
  return saved;
}

function runtimeEnvironment(file, environment = process.env) {
  const saved = loadConfig(file);
  checkOverrides(environment, saved);
  return {
    ...environment,
    ...saved,
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key, value]) => !privateKeys.includes(key) && supplied(value),
      ),
    ),
  };
}

function initializeStorageDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Local object storage must be a private directory");
  if (process.getuid?.() === 0) chownSync(directory, 1000, 1000);
  chmodSync(directory, 0o700);
}

function main(args = process.argv.slice(2)) {
  const file = configPath();
  if (args[0] === "initialize") {
    initializeStorageDirectory(process.env.OBJECT_STORAGE_LOCAL_ROOT || "/var/lib/qisheng/storage");
    // Docker creates fresh bind directories as root. Drop privileges before writing keys.
    if (process.getuid?.() === 0) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      chownSync(dirname(file), 1000, 1000);
      process.setgid(1000);
      process.setuid(1000);
    }
    initializeConfig(file);
    console.log(
      "Private installation configuration is ready. Use the Docker token command for the one-time web setup credential.",
    );
    return;
  }
  if (args[0] === "token") {
    if (!process.stdout.isTTY || !process.stdin.isTTY)
      throw new Error("Show the one-time setup credential only in a trusted interactive terminal");
    console.log(loadConfig(file).INSTALLATION_TOKEN);
    return;
  }
  if (args[0] !== "run" || args.length < 2)
    throw new Error("Usage: runtime-config initialize | token | run <command>");
  const child = spawn(args[1], args.slice(2), {
    stdio: "inherit",
    shell: false,
    env: runtimeEnvironment(file),
  });
  const handlers = new Map(
    ["SIGTERM", "SIGINT", "SIGHUP"].map((signal) => [signal, () => child.kill(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  child.on("error", () => {
    console.error("Application process could not start");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

module.exports = { initializeConfig, initializeStorageDirectory, loadConfig, runtimeEnvironment };
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
