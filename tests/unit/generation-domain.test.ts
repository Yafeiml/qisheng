import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Prisma } from "@xhs-agentic/database";
import { describe, expect, it } from "vitest";

describe("self-hosted generation domain", () => {
  it("keeps task and storage protections without internal payment models", () => {
    const models = Prisma.dmmf.datamodel.models;
    const names = models.map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining(["Campaign", "GenerationWorkItem", "StorageReservation"]),
    );
    expect(names.some((name) => /^(Credit|Recharge|TenantRecharge)/u.test(name))).toBe(false);
    const campaign = models.find(({ name }) => name === "Campaign");
    const workItem = models.find(({ name }) => name === "GenerationWorkItem");
    expect(campaign?.fields.map(({ name }) => name)).toContain("cancellationSummary");
    expect(workItem?.fields.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["reservationVersion", "leaseToken", "queueVersion"]),
    );
    expect(
      [...(campaign?.fields ?? []), ...(workItem?.fields ?? [])].some(({ name }) =>
        /credit|wallet/iu.test(name),
      ),
    ).toBe(false);
  });

  it("does not reintroduce balance gates or obsolete payment selectors in runtime clients", () => {
    const root = resolve(import.meta.dirname, "../..");
    const sourceFiles = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = join(directory, entry.name);
        return entry.isDirectory()
          ? sourceFiles(file)
          : /\.(?:ts|tsx|css|wxml)$/u.test(file) && !/\.(?:test|spec)\.ts$/u.test(file)
            ? [file]
            : [];
      });
    const forbidden =
      /CreditWallet|creditWallet|CreditLot|creditLot|CreditLedger|creditLedger|creditReserved|fundingSource|walletScope|点数|钱包/u;
    const files = [
      "apps/api/src",
      "apps/worker/src",
      "apps/admin-web/app",
      "apps/employee-miniapp",
    ].flatMap((path) => sourceFiles(join(root, path)));
    const leftovers = files.filter((file) => forbidden.test(readFileSync(file, "utf8")));
    expect(leftovers).toEqual([]);
  });
});
