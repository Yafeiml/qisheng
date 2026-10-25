import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface SmsChallenge {
  required: boolean;
  challenge?: { c: number; s: number; d: number };
  token?: string;
  expires?: number;
}
export interface CaptchaProof {
  token: string;
  solutions: number[];
}

/** Cap 3 format-1 SHA-256 PoW. No DOM, eval, CDN, WebCrypto or Node APIs required. */
export async function solveSmsChallenge(
  input: SmsChallenge,
  onProgress: (percent: number) => void = () => {},
  cancelled: () => boolean = () => false,
): Promise<CaptchaProof | undefined> {
  if (!input.required) return undefined;
  const { challenge, token, expires } = input;
  if (
    !challenge ||
    !token ||
    token.length > 8192 ||
    !expires ||
    !Number.isInteger(challenge.c) ||
    challenge.c < 1 ||
    challenge.c > 100 ||
    !Number.isInteger(challenge.s) ||
    challenge.s < 1 ||
    challenge.s > 64 ||
    !Number.isInteger(challenge.d) ||
    challenge.d < 1 ||
    challenge.d > 4
  )
    throw new Error("安全验证配置不兼容，请联系管理员。");
  const deadline = Math.min(expires, Date.now() + 90_000);
  const solutions: number[] = [];
  let lastYield = Date.now();
  for (let i = 1; i <= challenge.c; i++) {
    const salt = prng(`${token}${i}`, challenge.s);
    const target = prng(`${token}${i}d`, challenge.d);
    let nonce = 0;
    for (; nonce < 4294967295; nonce++) {
      if (nonce % 256 === 0 && Date.now() - lastYield >= 12) {
        if (cancelled() || Date.now() >= deadline)
          throw new Error("安全验证已取消或超时，请重试。");
        // Yield during work so even native miniapp inputs and progress remain responsive.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = Date.now();
      }
      const text = salt + nonce;
      // Cap salts and decimal nonces are ASCII; avoid TextEncoder (unavailable in WeChat).
      const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
      if (bytesToHex(sha256(bytes)).startsWith(target)) break;
    }
    if (cancelled() || Date.now() >= deadline || nonce === 4294967295)
      throw new Error("安全验证已取消或超时，请重试。");
    solutions.push(nonce);
    onProgress(Math.round((i / challenge.c) * 100));
  }
  return { token, solutions };
}

// Cap's deterministic FNV-1a / xorshift expansion; not used for secrets or OTP randomness.
function prng(seed: string, length: number): string {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;
  let result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result += (state >>> 0).toString(16).padStart(8, "0");
  }
  return result.slice(0, length);
}

export function retrySeconds(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const body = (error as { body?: { details?: { retryAfterSeconds?: unknown } } }).body;
  const seconds = body?.details?.retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : 0;
}
