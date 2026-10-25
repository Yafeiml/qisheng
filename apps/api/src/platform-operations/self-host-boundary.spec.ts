import { describe, expect, it, vi } from "vitest";
import type { ProvisionCustomerDto } from "./platform-operations.dto";
import { PlatformOperationsService } from "./platform-operations.service";

describe("single installation organization boundary", () => {
  it("refuses provisioning another independent workspace without writing to the database", async () => {
    const transaction = vi.fn();
    const service = Object.assign(Object.create(PlatformOperationsService.prototype), {
      accessContext: { requireSaasAdmin: () => ({ scope: { type: "PLATFORM" } }) },
      prisma: { $transaction: transaction },
    }) as PlatformOperationsService;
    await expect(service.provisionCustomer({} as ProvisionCustomerDto)).rejects.toThrow(
      "一套安装只管理一个企业或集团",
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});
