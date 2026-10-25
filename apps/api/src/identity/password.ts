import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { BadRequestException } from "@nestjs/common";

const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, parameters, (error, key) => (error ? reject(error) : resolve(key)));
  });

export function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/u.test(username))
    throw new BadRequestException(
      "账号须为 3–64 位字母、数字、点、下划线或短横线，以字母或数字开头",
    );
  return username;
}

export function assertPassword(password: string): void {
  if (
    password.length < 12 ||
    password.length > 128 ||
    !/[a-z]/iu.test(password) ||
    !/\d/u.test(password)
  )
    throw new BadRequestException("密码须为 12–128 位，且包含字母和数字");
}

export async function hashPassword(password: string): Promise<string> {
  assertPassword(password);
  const salt = randomBytes(16).toString("hex");
  const digest = await derive(password, salt);
  return `scrypt$${salt}$${digest.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/u.exec(encoded ?? "");
  const [, salt = "0".repeat(32), digest = "0".repeat(128)] = match ?? [];
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(digest, "hex")) && match !== null;
}
