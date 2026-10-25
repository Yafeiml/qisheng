import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeNoteDetailAuthorization, normalizeNoteDetailEndpoint } from "./note-detail";

type SealedToken = { iv: string; tag: string; data: string };
type Persisted = {
  password: { salt: string; hash: string } | null;
  endpoint: string | null;
  token: SealedToken | null;
  enabled: boolean;
  probe: { day: string; used: number; lastStatus: string | null; verifiedAt: string | null };
};

const emptyState = (): Persisted => ({
  password: null,
  endpoint: null,
  token: null,
  enabled: false,
  probe: { day: "", used: 0, lastStatus: null, verifiedAt: null },
});

function privateFile(path: string): Buffer | null {
  if (!existsSync(path)) return null;
  if ((statSync(path).mode & 0o077) !== 0) throw new Error("READBACK_STATE_PERMISSIONS_INVALID");
  return readFileSync(path);
}

export class PanelState {
  private readonly directory: string;
  private readonly encryptionKey: Buffer;
  private readonly sessions = new Map<string, { csrf: string; expires: number }>();
  private current: Persisted;
  private providerVersion = 0;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if ((statSync(directory).mode & 0o077) !== 0)
      throw new Error("READBACK_STATE_PERMISSIONS_INVALID");
    const keyPath = join(directory, "encryption.key");
    if (!existsSync(keyPath)) {
      try {
        const fd = openSync(keyPath, "wx", 0o600);
        try {
          writeFileSync(fd, randomBytes(32));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if (!existsSync(keyPath)) throw error;
      }
    }
    const key = privateFile(keyPath);
    if (key?.length !== 32) throw new Error("READBACK_ENCRYPTION_KEY_INVALID");
    this.encryptionKey = key;
    const saved = privateFile(join(directory, "panel.json"));
    this.current = saved ? (JSON.parse(saved.toString("utf8")) as Persisted) : emptyState();
    if (!this.current.probe || typeof this.current.enabled !== "boolean")
      throw new Error("READBACK_STATE_INVALID");
    if (this.current.endpoint == null) {
      this.current.endpoint = null;
      this.current.enabled = false;
      this.current.probe.verifiedAt = null;
    } else {
      this.current.endpoint = normalizeNoteDetailEndpoint(this.current.endpoint);
    }
  }

  get setupRequired(): boolean {
    return this.current.password === null;
  }

  get tokenConfigured(): boolean {
    return this.current.token !== null;
  }

  get endpoint(): string | null {
    return this.current.endpoint;
  }

  get configurationVersion(): number {
    return this.providerVersion;
  }

  get workerEnabled(): boolean {
    return this.current.enabled;
  }

  get probe() {
    return { ...this.current.probe };
  }

  setup(password: string): void {
    if (!this.setupRequired) throw new Error("ALREADY_INITIALIZED");
    this.current.password = hashPassword(password);
    this.persist();
  }

  verifyPassword(value: string): boolean {
    const password = this.current.password;
    if (!password || typeof value !== "string" || value.length > 128) return false;
    const expected = Buffer.from(password.hash, "hex");
    const actual = scryptSync(value, Buffer.from(password.salt, "hex"), expected.length);
    return timingSafeEqual(expected, actual);
  }

  changePassword(oldValue: string, nextValue: string): void {
    if (!this.verifyPassword(oldValue)) throw new Error("PASSWORD_INCORRECT");
    this.current.password = hashPassword(nextValue);
    this.sessions.clear();
    this.persist();
  }

  createSession(): { cookie: string; csrf: string } {
    const cookie = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    this.sessions.set(cookie, { csrf, expires: Date.now() + 8 * 60 * 60_000 });
    return { cookie, csrf };
  }

  session(cookie: string): { csrf: string } | null {
    const session = this.sessions.get(cookie);
    if (!session) return null;
    if (session.expires <= Date.now()) {
      this.sessions.delete(cookie);
      return null;
    }
    return { csrf: session.csrf };
  }

  logout(cookie: string): void {
    this.sessions.delete(cookie);
  }

  configureToken(token: string): void {
    this.current.token = this.sealToken(token);
    this.providerVersion++;
    this.current.enabled = false;
    this.current.probe.verifiedAt = null;
    this.current.probe.lastStatus = null;
    this.persist();
  }

  configureProvider(endpoint: string, token?: string): void {
    const normalized = normalizeNoteDetailEndpoint(endpoint);
    const sealed = token ? this.sealToken(token) : this.current.token;
    if (!sealed) throw new Error("TOKEN_MISSING");
    if (normalized === this.current.endpoint && !token) return;
    this.current.endpoint = normalized;
    this.current.token = sealed;
    this.providerVersion++;
    this.current.enabled = false;
    this.current.probe.verifiedAt = null;
    this.current.probe.lastStatus = null;
    this.persist();
  }

  private sealToken(token: string): SealedToken {
    try {
      normalizeNoteDetailAuthorization(token);
    } catch {
      throw new Error("TOKEN_FORMAT_INVALID");
    }
    const normalized = token.trim();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from("qisheng:collector-token:v1"));
    const data = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }

  token(): string | null {
    const token = this.current.token;
    if (!token) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(token.iv, "base64"),
    );
    decipher.setAAD(Buffer.from("qisheng:collector-token:v1"));
    decipher.setAuthTag(Buffer.from(token.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(token.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  enable(value: boolean): void {
    if (value && (!this.endpoint || !this.tokenConfigured || !this.current.probe.verifiedAt))
      throw new Error("SUCCESSFUL_SAMPLE_REQUIRED");
    this.current.enabled = value;
    this.persist();
  }

  reserveProbe(now: Date): void {
    if (!this.endpoint) throw new Error("PROVIDER_ENDPOINT_MISSING");
    if (!this.tokenConfigured) throw new Error("TOKEN_MISSING");
    const day = now.toISOString().slice(0, 10);
    if (this.current.probe.day !== day) {
      this.current.probe.day = day;
      this.current.probe.used = 0;
    }
    if (this.current.probe.used >= 3) throw new Error("PROBE_DAILY_LIMIT");
    this.current.probe.used++;
    this.persist();
  }

  recordProbe(status: string, at: Date): void {
    this.current.probe.lastStatus = status;
    if (status === "AVAILABLE") this.current.probe.verifiedAt = at.toISOString();
    this.persist();
  }

  private persist(): void {
    const temporary = join(this.directory, `.panel-${randomBytes(12).toString("hex")}`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.current));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(this.directory, "panel.json"));
    const directoryFd = openSync(this.directory, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
}

function hashPassword(value: string) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 128 ||
    /[\r\n\0]/u.test(value)
  )
    throw new Error("PASSWORD_LENGTH_INVALID");
  const salt = randomBytes(32);
  return {
    salt: salt.toString("hex"),
    hash: scryptSync(value, salt, 64).toString("hex"),
  };
}
