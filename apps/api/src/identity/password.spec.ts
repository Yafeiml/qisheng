import { describe, expect, it } from "vitest";
import { assertPassword, hashPassword, normalizeUsername, verifyPassword } from "./password";

describe("password credentials", () => {
  it("normalizes usernames and rejects weak passwords", () => {
    expect(normalizeUsername(" Owner.Name ")).toBe("owner.name");
    expect(() => normalizeUsername("ab")).toThrow();
    expect(() => normalizeUsername("a b")).toThrow();
    for (const password of ["short1", "onlyletterslong", "123456789012", "a1".repeat(65)])
      expect(() => assertPassword(password)).toThrow();
  });

  it("uses independent salts, verifies exact passwords, and fails closed for missing or corrupt hashes", async () => {
    const password = "Local-password-2026";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword(`${password} `, first)).resolves.toBe(false);
    await expect(verifyPassword(password, null)).resolves.toBe(false);
    await expect(verifyPassword(password, "broken")).resolves.toBe(false);
  });
});
