import { Prisma } from "@xhs-agentic/database";
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../database/prisma.service";
import { generateEnterpriseCode, withGeneratedEnterpriseCode } from "./enterprise-code";

describe("enterprise code allocation", () => {
  it("generates opaque upper-case codes with enough random space", () => {
    const codes = Array.from({ length: 100 }, generateEnterpriseCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => /^ENT_[A-F0-9]{32}$/u.test(code))).toBe(true);
  });

  it("checks all customers and retries a concurrent unique constraint collision", async () => {
    const oldCode = `ENT_${"A".repeat(32)}`;
    const collidedCode = `ENT_${"B".repeat(32)}`;
    const finalCode = `ENT_${"C".repeat(32)}`;
    const candidates = [oldCode, collidedCode, finalCode];
    const database = {
      enterprise: {
        findFirst: async ({ where }: { where: { code: string } }) =>
          where.code === oldCode ? { id: "another-customer" } : null,
      },
    } as unknown as PrismaService;
    const attempted: string[] = [];
    const created = await withGeneratedEnterpriseCode(
      database,
      async (code) => {
        attempted.push(code);
        if (code === collidedCode) {
          throw new Prisma.PrismaClientKnownRequestError("Unique code", {
            clientVersion: "6.19.3",
            code: "P2002",
            meta: { target: ["code"] },
          });
        }
        return code;
      },
      () => candidates.shift() ?? "unexpected",
    );
    expect(created).toBe(finalCode);
    expect(attempted).toEqual([collidedCode, finalCode]);
  });
});
