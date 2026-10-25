import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { type Prisma, PrismaClient } from "@xhs-agentic/database";
import { afterAll, describe, expect, it } from "vitest";
import { enterpriseAccessScope } from "../access/access-scope";
import { AuthTokenService } from "../access/auth-token.service";
import { EmployeeAccessGuard } from "../access/employee-access.guard";
import { RequestAccessContext } from "../access/request-access-context";
import { EmployeeBindingService } from "../identity/employee-binding.service";
import { EnterpriseMembershipQueryDto } from "../organization/organization.dto";
import { OrganizationApplicationService } from "../organization/organization-application.service";
import { EmployeeAdminService } from "./employee-admin.service";

const prisma = new PrismaClient();
const rollback = new Error("EMPLOYEE_PHONE_TEST_ROLLBACK");
const previous = new Date("2026-01-01T00:00:00.000Z");
afterAll(() => prisma.$disconnect());

function phone() {
  return `199${(BigInt(`0x${randomBytes(6).toString("hex")}`) % 100_000_000n)
    .toString()
    .padStart(8, "0")}`;
}

function assertLocalDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.pathname.startsWith("/dev_")
  )
    throw new Error("Employee phone tests require a local dev_ database");
}

async function fixture(transaction: Prisma.TransactionClient) {
  const marker = randomUUID();
  const oldPhone = phone();
  const newPhone = phone();
  const tenant = await transaction.tenant.create({ data: { name: marker, customerType: "GROUP" } });
  const enterprise = await transaction.enterprise.create({
    data: { tenantId: tenant.id, code: `${marker}-a`, name: marker },
  });
  const otherEnterprise = await transaction.enterprise.create({
    data: { tenantId: tenant.id, code: `${marker}-b`, name: marker },
  });
  const user = await transaction.globalUser.create({
    data: { phone: oldPhone, phoneVerifiedAt: previous },
  });
  const data = {
    tenantId: tenant.id,
    globalUserId: user.id,
    name: marker,
    phone: oldPhone,
    status: "ACTIVE" as const,
    seatStatus: "ENABLED" as const,
    seatEnabledAt: previous,
    boundAt: previous,
    smsNotificationStatus: "NORMAL",
    smsNotificationStatusAt: previous,
  };
  const membership = await transaction.enterpriseMembership.create({
    data: { ...data, enterpriseId: enterprise.id },
  });
  const otherMembership = await transaction.enterpriseMembership.create({
    data: { ...data, enterpriseId: otherEnterprise.id },
  });
  const access = new RequestAccessContext();
  access.initialize({
    audience: "SAAS_ADMIN",
    userId: marker,
    permissions: ["enterprise.membership.manage"],
    scope: enterpriseAccessScope(tenant.id, enterprise.id),
  });
  const client = new Proxy(transaction, {
    get(target, property) {
      if (property === "$transaction")
        return (operation: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          operation(transaction);
      return Reflect.get(target, property);
    },
  });
  const service = new EmployeeAdminService(client as never, access, {
    assertEnterpriseSeatManagementAllowed: async () => undefined,
  } as never);
  const organizations = new OrganizationApplicationService(
    client as never,
    {} as never,
    access,
    {} as never,
    {} as never,
  );
  return {
    transaction,
    client,
    tenant,
    enterprise,
    otherEnterprise,
    user,
    membership,
    otherMembership,
    oldPhone,
    newPhone,
    access,
    service,
    organizations,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function isolated(run: (context: Fixture) => Promise<void>) {
  assertLocalDatabase();
  try {
    await prisma.$transaction(
      async (transaction) => {
        await run(await fixture(transaction));
        throw rollback;
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function committedImportFixture(
  run: (context: {
    tenantId: string;
    enterpriseId: string;
    access: RequestAccessContext;
    service: EmployeeAdminService;
  }) => Promise<void>,
) {
  assertLocalDatabase();
  const marker = randomUUID();
  const tenant = await prisma.tenant.create({ data: { name: marker, customerType: "GROUP" } });
  try {
    const enterprise = await prisma.enterprise.create({
      data: { tenantId: tenant.id, code: marker, name: marker },
    });
    const access = new RequestAccessContext();
    access.initialize({
      audience: "SAAS_ADMIN",
      userId: marker,
      permissions: ["enterprise.membership.manage"],
      scope: enterpriseAccessScope(tenant.id, enterprise.id),
    });
    const service = new EmployeeAdminService(prisma as never, access, {
      assertEnterpriseSeatManagementAllowed: async () => undefined,
    } as never);
    await run({ tenantId: tenant.id, enterpriseId: enterprise.id, access, service });
  } finally {
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.membershipImportBatch.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.enterpriseMembership.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.enterprise.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
  }
}

describe("enterprise employee phone correction and SMS status", { concurrent: false }, () => {
  it("reports a same-enterprise phone/name conflict and writes none of a mixed import batch", async () => {
    await isolated(async (f) => {
      const input = {
        members: [
          { name: "正常新增员工", phone: f.newPhone },
          {
            name: "不同姓名",
            phone: `+86 ${f.oldPhone}`,
            employeeNo: "SHOULD-NOT-WRITE",
          },
        ],
      };
      const preview = await f.service.previewMembershipImport(f.tenant.id, f.enterprise.id, input);
      expect(preview).toMatchObject({
        canImport: false,
        summary: { createCount: 1, errorCount: 1, updateCount: 0 },
        rows: [
          { action: "CREATE" },
          {
            action: "ERROR",
            errors: [
              {
                code: "PHONE_NAME_CONFLICT",
                message: expect.stringContaining("导入不会覆盖原员工资料"),
              },
            ],
          },
        ],
      });
      expect(JSON.stringify(preview)).not.toContain(f.oldPhone);
      await expect(
        f.service.importMemberships(f.tenant.id, f.enterprise.id, {
          ...input,
          previewBatchId: preview.batchId,
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: "MEMBERSHIP_IMPORT_VALIDATION_FAILED",
          message: "导入手机号已对应本企业其他姓名的员工，请核实；整批未写入",
          preview: { canImport: false },
        },
      });
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { id: f.membership.id },
        }),
      ).toEqual(f.membership);
      expect(
        await f.transaction.enterpriseMembership.count({
          where: { enterpriseId: f.enterprise.id, phone: f.newPhone },
        }),
      ).toBe(0);
      expect(
        await f.transaction.membershipImportBatch.findUniqueOrThrow({
          where: { id: preview.batchId },
        }),
      ).toMatchObject({ status: "PREVIEW_FAILED", importedAt: null });
      expect(
        await f.transaction.auditLog.count({
          where: { action: "membership.import", enterpriseId: f.enterprise.id },
        }),
      ).toBe(0);
    });
  });

  it("updates department and employee number for the same trimmed name and normalized phone", async () => {
    await isolated(async (f) => {
      const department = await f.transaction.department.create({
        data: { tenantId: f.tenant.id, enterpriseId: f.enterprise.id, code: "OPS", name: "运营部" },
      });
      const input = {
        members: [
          {
            name: ` ${f.membership.name} `,
            phone: `0086 ${f.oldPhone.slice(0, 3)}-${f.oldPhone.slice(3)}`,
            employeeNo: " NEW-001 ",
            departmentCode: " ops ",
          },
        ],
      };
      const preview = await f.service.previewMembershipImport(f.tenant.id, f.enterprise.id, input);
      expect(preview).toMatchObject({
        canImport: true,
        summary: { createCount: 0, errorCount: 0, updateCount: 1 },
      });
      await expect(
        f.service.importMemberships(f.tenant.id, f.enterprise.id, input),
      ).resolves.toMatchObject({ createdCount: 0, updatedCount: 1 });
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { id: f.membership.id },
        }),
      ).toMatchObject({
        name: f.membership.name,
        phone: f.oldPhone,
        employeeNo: "NEW-001",
        departmentId: department.id,
        globalUserId: f.user.id,
        smsNotificationStatus: "NORMAL",
      });
      expect(
        await f.transaction.enterpriseMembership.count({
          where: { enterpriseId: f.enterprise.id, phone: f.oldPhone },
        }),
      ).toBe(1);
    });
  });

  it("allows a different enterprise to import the same phone with its own employee name", async () => {
    await isolated(async (f) => {
      await f.transaction.enterpriseMembership.create({
        data: {
          tenantId: f.tenant.id,
          enterpriseId: f.otherEnterprise.id,
          phone: f.newPhone,
          name: "其他企业员工",
        },
      });
      await expect(
        f.service.importMemberships(f.tenant.id, f.enterprise.id, {
          members: [{ name: "本企业员工", phone: f.newPhone }],
        }),
      ).resolves.toMatchObject({ createdCount: 1, updatedCount: 0 });
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { enterpriseId_phone: { enterpriseId: f.enterprise.id, phone: f.newPhone } },
        }),
      ).toMatchObject({ name: "本企业员工" });
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { enterpriseId_phone: { enterpriseId: f.otherEnterprise.id, phone: f.newPhone } },
        }),
      ).toMatchObject({ name: "其他企业员工" });
    });
  });

  it("rechecks a previously valid preview when the existing name changes before import", async () => {
    await isolated(async (f) => {
      const input = { members: [{ name: f.membership.name, phone: f.oldPhone }] };
      const preview = await f.service.previewMembershipImport(f.tenant.id, f.enterprise.id, input);
      expect(preview.canImport).toBe(true);
      await f.transaction.enterpriseMembership.update({
        data: { name: "管理员已更正姓名" },
        where: { id: f.membership.id },
      });
      await expect(
        f.service.importMemberships(f.tenant.id, f.enterprise.id, {
          ...input,
          previewBatchId: preview.batchId,
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          preview: {
            rows: [{ action: "ERROR", errors: [{ code: "PHONE_NAME_CONFLICT" }] }],
          },
        },
      });
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { id: f.membership.id },
        }),
      ).toMatchObject({ name: "管理员已更正姓名", phone: f.oldPhone });
    });
  });

  it("keeps one employee identity when different names concurrently import the same enterprise phone", async () => {
    await committedImportFixture(async (f) => {
      const target = phone();
      const names = ["并发员工甲", "并发员工乙"];
      const results = await Promise.allSettled(
        names.map((name) =>
          f.service.importMemberships(f.tenantId, f.enterpriseId, {
            members: [{ name, phone: target }],
          }),
        ),
      );
      const winnerIndex = results.findIndex(({ status }) => status === "fulfilled");
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejection = results.find((result) => result.status === "rejected");
      expect(rejection && "reason" in rejection && rejection.reason.status).toBeOneOf([400, 409]);
      const memberships = await prisma.enterpriseMembership.findMany({
        where: { enterpriseId: f.enterpriseId, phone: target },
      });
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.name).toBe(names[winnerIndex]);
      expect(
        await prisma.membershipImportBatch.count({
          where: { enterpriseId: f.enterpriseId, status: "IMPORTED" },
        }),
      ).toBe(1);
    });
  });

  it("rolls back import if an existing name changes during its serializable transaction", async () => {
    await committedImportFixture(async (f) => {
      const originalPhone = phone();
      const newPhone = phone();
      const membership = await prisma.enterpriseMembership.create({
        data: {
          tenantId: f.tenantId,
          enterpriseId: f.enterpriseId,
          phone: originalPhone,
          name: "原姓名",
          employeeNo: "ORIGINAL",
        },
      });
      let notifyPrepared!: () => void;
      const prepared = new Promise<void>((resolve) => {
        notifyPrepared = resolve;
      });
      let continueImport!: () => void;
      const resume = new Promise<void>((resolve) => {
        continueImport = resolve;
      });
      const service = new EmployeeAdminService(prisma as never, f.access, {
        assertEnterpriseSeatManagementAllowed: async () => {
          notifyPrepared();
          await resume;
        },
      } as never);
      const imported = service.importMemberships(f.tenantId, f.enterpriseId, {
        members: [
          { name: "原姓名", phone: originalPhone, employeeNo: "SHOULD-NOT-WRITE" },
          { name: "正常新增员工", phone: newPhone },
        ],
      });
      const rejectedImport = expect(imported).rejects.toMatchObject({ status: 409 });
      try {
        await prepared;
        await prisma.enterpriseMembership.update({
          data: { name: "并发更正后的姓名" },
          where: { id: membership.id },
        });
      } finally {
        continueImport();
      }
      await rejectedImport;
      expect(
        await prisma.enterpriseMembership.findUniqueOrThrow({ where: { id: membership.id } }),
      ).toMatchObject({ name: "并发更正后的姓名", employeeNo: "ORIGINAL" });
      expect(
        await prisma.enterpriseMembership.count({
          where: { enterpriseId: f.enterpriseId, phone: newPhone },
        }),
      ).toBe(0);
      expect(
        await prisma.membershipImportBatch.count({ where: { enterpriseId: f.enterpriseId } }),
      ).toBe(0);
    });
  });

  it("resets only the changed enterprise, preserves history and removes old-token membership access", async () => {
    await isolated(async (f) => {
      const tokens = new AuthTokenService();
      const token = tokens.issueEmployeeAccessToken(f.user.id);
      const result = await f.service.changeMembershipPhone(
        f.tenant.id,
        f.enterprise.id,
        f.membership.id,
        {
          phone: f.newPhone,
          reason: "人资核实后更正号码",
        },
      );
      expect(result).toMatchObject({
        id: f.membership.id,
        phone: f.newPhone,
        globalUserId: null,
        boundAt: null,
        status: "PENDING_BIND",
        seatStatus: "ENABLED",
        smsNotificationStatus: "PENDING_VERIFICATION",
        smsNotificationStatusAt: null,
        smsNotificationPhoneVersion: 2,
      });
      expect(
        await f.transaction.globalUser.findUniqueOrThrow({ where: { id: f.user.id } }),
      ).toMatchObject({ phone: f.oldPhone, phoneVerifiedAt: previous });
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { id: f.otherMembership.id },
        }),
      ).toMatchObject({
        globalUserId: f.user.id,
        phone: f.oldPhone,
        status: "ACTIVE",
        smsNotificationStatus: "NORMAL",
        smsNotificationPhoneVersion: 1,
      });
      const employeeAccess = new RequestAccessContext();
      const guard = new EmployeeAccessGuard(tokens, f.client as never, employeeAccess);
      await guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }),
        }),
      } as ExecutionContext);
      expect(employeeAccess.requireEmployee().membershipIds).toEqual([f.otherMembership.id]);
      const audit = await f.transaction.auditLog.findFirstOrThrow({
        where: { resourceId: f.membership.id, action: "membership.phone.change" },
      });
      expect(audit.reason).toBe("人资核实后更正号码");
      expect(JSON.stringify(audit)).not.toContain(f.oldPhone);
      expect(JSON.stringify(audit)).not.toContain(f.newPhone);
      const binding = new EmployeeBindingService(f.client as never, tokens);
      const rebound = await binding.bindVerifiedPhone({
        phone: f.newPhone,
        enterpriseIds: [f.enterprise.id],
      });
      expect(rebound.userId).not.toBe(f.user.id);
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { id: f.membership.id },
        }),
      ).toMatchObject({
        id: f.membership.id,
        globalUserId: rebound.userId,
        status: "ACTIVE",
        smsNotificationStatus: "PENDING_VERIFICATION",
        smsNotificationPhoneVersion: 2,
      });
    });
  });

  it("keeps a normalized same-number edit as a no-op", async () => {
    await isolated(async (f) => {
      const result = await f.service.changeMembershipPhone(
        f.tenant.id,
        f.enterprise.id,
        f.membership.id,
        {
          phone: `+86 ${f.oldPhone}`,
          reason: "核对现有号码",
        },
      );
      expect(result).toMatchObject({
        globalUserId: f.user.id,
        boundAt: previous,
        smsNotificationStatus: "NORMAL",
        smsNotificationStatusAt: previous,
        smsNotificationPhoneVersion: 1,
      });
      expect(await f.transaction.auditLog.count({ where: { resourceId: f.membership.id } })).toBe(
        0,
      );
    });
  });

  it("binds the same verified global identity across enterprise memberships", async () => {
    await isolated(async (f) => {
      const binding = new EmployeeBindingService(f.client as never, new AuthTokenService());
      const result = await binding.bindVerifiedPhone({ phone: f.oldPhone });
      expect(result.userId).toBe(f.user.id);
      expect(result.memberships.map(({ membershipId }) => membershipId).sort()).toEqual(
        [f.membership.id, f.otherMembership.id].sort(),
      );
      expect(await f.transaction.globalUser.count({ where: { phone: f.oldPhone } })).toBe(1);
    });
  });

  it("rejects a stale verification candidate if its phone changes before binding", async () => {
    await isolated(async (f) => {
      const interruptedTransaction = new Proxy(f.transaction, {
        get(target, property) {
          if (property !== "enterpriseMembership") return Reflect.get(target, property);
          return new Proxy(target.enterpriseMembership, {
            get(model, operation) {
              if (operation !== "findMany") return Reflect.get(model, operation);
              return async (args: Prisma.EnterpriseMembershipFindManyArgs) => {
                const candidates = await model.findMany(args);
                await model.update({
                  data: {
                    phone: f.newPhone,
                    globalUserId: null,
                    boundAt: null,
                    status: "PENDING_BIND",
                    smsNotificationPhoneVersion: { increment: 1 },
                  },
                  where: { id: f.membership.id },
                });
                return candidates;
              };
            },
          });
        },
      });
      const binding = new EmployeeBindingService(
        {
          $transaction: (operation: (client: Prisma.TransactionClient) => Promise<unknown>) =>
            operation(interruptedTransaction),
        } as never,
        new AuthTokenService(),
      );
      await expect(
        binding.bindVerifiedPhone({ phone: f.oldPhone, enterpriseIds: [f.enterprise.id] }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { id: f.membership.id },
        }),
      ).toMatchObject({ phone: f.newPhone, globalUserId: null, status: "PENDING_BIND" });
      expect(await f.transaction.auditLog.count({ where: { resourceId: f.membership.id } })).toBe(
        0,
      );
    });
  });

  it("defers a correction while an SMS is already in flight", async () => {
    await isolated(async (f) => {
      const guardedTransaction = new Proxy(f.transaction, {
        get(target, property) {
          if (property !== "employeeTaskNotification") return Reflect.get(target, property);
          return {
            count: async (args: Prisma.EmployeeTaskNotificationCountArgs) => {
              expect(args.where).toMatchObject({
                channel: "ALIYUN_SMS",
                status: "SENDING",
                task: {
                  enterpriseId: f.enterprise.id,
                  membershipId: f.membership.id,
                  tenantId: f.tenant.id,
                },
              });
              return 1;
            },
          };
        },
      });
      const service = new EmployeeAdminService(
        {
          $transaction: (operation: (client: Prisma.TransactionClient) => Promise<unknown>) =>
            operation(guardedTransaction),
        } as never,
        f.access,
        {} as never,
      );
      await expect(
        service.changeMembershipPhone(f.tenant.id, f.enterprise.id, f.membership.id, {
          phone: f.newPhone,
          reason: "发送在途检查",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { id: f.membership.id },
        }),
      ).toMatchObject({
        phone: f.oldPhone,
        smsNotificationStatus: "NORMAL",
        smsNotificationPhoneVersion: 1,
      });
    });
  });

  it("rejects duplicate numbers inside an enterprise while permitting the same number in another", async () => {
    await isolated(async (f) => {
      const duplicate = await f.transaction.enterpriseMembership.create({
        data: {
          tenantId: f.tenant.id,
          enterpriseId: f.enterprise.id,
          phone: f.newPhone,
          name: "其他员工",
        },
      });
      await expect(
        f.service.changeMembershipPhone(f.tenant.id, f.enterprise.id, f.membership.id, {
          phone: duplicate.phone,
          reason: "重复号码检查",
        }),
      ).rejects.toMatchObject({ status: 409 });
      await f.transaction.enterpriseMembership.delete({ where: { id: duplicate.id } });
      await f.transaction.enterpriseMembership.create({
        data: {
          tenantId: f.tenant.id,
          enterpriseId: f.otherEnterprise.id,
          phone: f.newPhone,
          name: "另企业员工",
        },
      });
      await expect(
        f.service.changeMembershipPhone(f.tenant.id, f.enterprise.id, f.membership.id, {
          phone: f.newPhone,
          reason: "允许跨企业重号",
        }),
      ).resolves.toMatchObject({ phone: f.newPhone });
    });
  });

  it("filters and counts the whole enterprise rather than only the first page", async () => {
    await isolated(async (f) => {
      const rows = Array.from({ length: 105 }, (_, index) => ({
        tenantId: f.tenant.id,
        enterpriseId: f.enterprise.id,
        name: `需要核实-${index}`,
        phone: `188${String(index).padStart(8, "0")}`,
        smsNotificationStatus: "NEEDS_REVIEW",
      }));
      await f.transaction.enterpriseMembership.createMany({ data: rows });
      await f.transaction.enterpriseMembership.create({
        data: {
          tenantId: f.tenant.id,
          enterpriseId: f.enterprise.id,
          phone: f.newPhone,
          name: "通道异常",
          smsNotificationStatus: null,
        },
      });
      const query = new EnterpriseMembershipQueryDto();
      query.limit = 100;
      query.smsNotificationStatus = "NEEDS_REVIEW";
      const first = await f.organizations.listEnterpriseMemberships(
        f.tenant.id,
        f.enterprise.id,
        query,
      );
      expect(first.items).toHaveLength(100);
      expect(first.pageInfo).toMatchObject({ hasNextPage: true, totalCount: 105 });
      query.cursor = first.pageInfo.nextCursor ?? undefined;
      const next = await f.organizations.listEnterpriseMemberships(
        f.tenant.id,
        f.enterprise.id,
        query,
      );
      expect(next.items).toHaveLength(5);
      expect(next.pageInfo).toMatchObject({ hasNextPage: false, totalCount: 105 });
      expect(new Set([...first.items, ...next.items].map(({ id }) => id)).size).toBe(105);
      const all = await f.organizations.listEnterpriseMemberships(
        f.tenant.id,
        f.enterprise.id,
        new EnterpriseMembershipQueryDto(),
      );
      expect(all.pageInfo.totalCount).toBe(107);
      expect(all.items.find(({ phone }) => phone === f.newPhone)?.smsNotificationStatus).toBeNull();
    });
  });

  it("rejects invalid numbers, cross-enterprise edits and departed staff", async () => {
    await isolated(async (f) => {
      await expect(
        f.service.changeMembershipPhone(f.tenant.id, f.enterprise.id, f.membership.id, {
          phone: "123",
          reason: "无效号码检查",
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        f.service.changeMembershipPhone(f.tenant.id, f.enterprise.id, f.otherMembership.id, {
          phone: f.newPhone,
          reason: "跨企业检查",
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        f.service.changeMembershipPhone(f.tenant.id, f.otherEnterprise.id, f.otherMembership.id, {
          phone: f.newPhone,
          reason: "作用域检查",
        }),
      ).rejects.toMatchObject({ status: 403 });
      await f.transaction.enterpriseMembership.update({
        data: { status: "LEFT" },
        where: { id: f.membership.id },
      });
      await expect(
        f.service.changeMembershipPhone(f.tenant.id, f.enterprise.id, f.membership.id, {
          phone: f.newPhone,
          reason: "离职档案检查",
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  it("allows manual correction of historical directory records after synchronization is removed", async () => {
    await isolated(async (f) => {
      const connection = await f.transaction.directoryConnection.create({
        data: {
          tenantId: f.tenant.id,
          name: "测试通讯录",
          provider: "SIMULATED",
          scopeType: "TENANT",
          managementMode: "CENTRALIZED",
          externalOrganizationId: randomUUID(),
          credentialCiphertext: Buffer.alloc(1),
          credentialInitializationVector: Buffer.alloc(12),
          credentialAuthenticationTag: Buffer.alloc(16),
          credentialKeyVersion: "test",
          credentialLastFour: "test",
          createdBy: "test",
        },
      });
      await f.transaction.directoryMemberLink.create({
        data: {
          tenantId: f.tenant.id,
          enterpriseId: f.enterprise.id,
          connectionId: connection.id,
          membershipId: f.membership.id,
          externalUserId: "test",
          sourceSnapshotHash: "0".repeat(64),
          lastSeenAt: previous,
        },
      });
      await f.service.changeMembershipPhone(f.tenant.id, f.enterprise.id, f.membership.id, {
        phone: f.newPhone,
        reason: "核实后人工更正旧同步档案",
      });
      expect(
        await f.transaction.enterpriseMembership.findUniqueOrThrow({
          where: { id: f.membership.id },
        }),
      ).toMatchObject({
        phone: f.newPhone,
        smsNotificationStatus: "PENDING_VERIFICATION",
        smsNotificationPhoneVersion: 2,
      });
    });
  });

  it("lets the database resolve concurrent corrections to the same enterprise number", async () => {
    assertLocalDatabase();
    const marker = randomUUID();
    const tenant = await prisma.tenant.create({
      data: { name: marker, customerType: "SINGLE_ENTERPRISE" },
    });
    try {
      const enterprise = await prisma.enterprise.create({
        data: { tenantId: tenant.id, code: marker, name: marker },
      });
      const members = await Promise.all(
        [0, 1].map(() =>
          prisma.enterpriseMembership.create({
            data: {
              tenantId: tenant.id,
              enterpriseId: enterprise.id,
              phone: phone(),
              name: marker,
            },
          }),
        ),
      );
      const access = new RequestAccessContext();
      access.initialize({
        audience: "SAAS_ADMIN",
        userId: marker,
        permissions: [],
        scope: enterpriseAccessScope(tenant.id, enterprise.id),
      });
      const service = new EmployeeAdminService(prisma as never, access, {} as never);
      const target = phone();
      const results = await Promise.allSettled(
        members.map((member) =>
          service.changeMembershipPhone(tenant.id, enterprise.id, member.id, {
            phone: target,
            reason: "并发号码唯一性检查",
          }),
        ),
      );
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected && "reason" in rejected && rejected.reason).toMatchObject({ status: 409 });
      expect(
        await prisma.enterpriseMembership.count({
          where: { enterpriseId: enterprise.id, phone: target },
        }),
      ).toBe(1);
    } finally {
      await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.enterpriseMembership.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.enterprise.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
    }
  });
});
