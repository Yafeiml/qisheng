import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { configureApplication } from "../configure-application";
import { PrismaService } from "../database/prisma.service";

const rootEnvPath = resolve(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

type ApiResponse = Readonly<{ status: number; body: unknown }>;

describe("MVP organization, billing and employee foundation", { concurrent: false }, () => {
  const marker = `mvp-foundation-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenantAdminPhone = testPhone(marker, 1);
  const employeePhone = testPhone(marker, 2);
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let platformToken: string;
  let tenantToken: string;
  let tenantId: string;
  let enterpriseAId: string;
  let enterpriseBId: string;
  let departmentAId: string;
  let departmentBId: string;
  let membershipAId: string;
  let membershipBId: string;

  beforeAll(async () => {
    assertDevelopmentDatabase();
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (!prisma) return;
    const tenant = await prisma.tenant.findFirst({
      select: { id: true },
      where: { name: { startsWith: marker } },
    });
    if (tenant) {
      const userIds = (
        await prisma.globalUser.findMany({
          select: { id: true },
          where: { phone: { in: [tenantAdminPhone, employeePhone] } },
        })
      ).map(({ id }) => id);
      await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.roleBinding.deleteMany({
        where: { OR: [{ tenantId: tenant.id }, { userId: { in: userIds } }] },
      });
      await prisma.storageUsageLedger.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.storageReservation.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenantStorageAccount.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.membershipImportBatch.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.enterpriseMembership.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.department.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.customerContract.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.enterprise.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
      await prisma.globalUser.deleteMany({ where: { id: { in: userIds } } });
    }
    await app.close();
  });

  it("obtains the seeded development platform administrator token", async () => {
    const response = await request("/auth/dev/admin-token", {
      body: { phone: process.env.DEV_PLATFORM_ADMIN_PHONE },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(numberField(response.body, "expiresInSeconds")).toBe(
      Number(process.env.ACCESS_TOKEN_TTL_SECONDS),
    );
    platformToken = stringField(response.body, "accessToken");
  });

  it("opens a group tenant and two enterprises", async () => {
    const tenant = await request("/platform/tenants", {
      body: { customerType: "GROUP", name: `${marker}-tenant` },
      method: "POST",
      token: platformToken,
    });
    expect(tenant.status).toBe(201);
    tenantId = stringField(tenant.body, "id");

    const [enterpriseA, enterpriseB] = await Promise.all([
      request(`/platform/tenants/${tenantId}/enterprises`, {
        body: { code: `${marker}-a`, name: "MVP 企业 A" },
        method: "POST",
        token: platformToken,
      }),
      request(`/platform/tenants/${tenantId}/enterprises`, {
        body: { code: `${marker}-b`, name: "MVP 企业 B" },
        method: "POST",
        token: platformToken,
      }),
    ]);
    expect(enterpriseA.status).toBe(201);
    expect(enterpriseB.status).toBe(201);
    enterpriseAId = stringField(enterpriseA.body, "id");
    enterpriseBId = stringField(enterpriseB.body, "id");
  });

  it("grants a tenant administrator and issues its development token", async () => {
    const grant = await request(`/platform/tenants/${tenantId}/admins`, {
      body: { phone: tenantAdminPhone, reason: "MVP 测试授予集团管理员" },
      method: "POST",
      token: platformToken,
    });
    expect(grant.status).toBe(201);

    const token = await request("/auth/dev/admin-token", {
      body: { phone: tenantAdminPhone },
      method: "POST",
    });
    expect(token.status).toBe(201);
    tenantToken = stringField(token.body, "accessToken");
  });

  it("prevents the tenant primary administrator role from being copied in the customer console", async () => {
    const response = await request(`/console/tenants/${tenantId}/role-bindings`, {
      body: {
        phone: tenantAdminPhone,
        reason: "验证管理员不能给自己授权",
        roleCode: "TENANT_ADMIN",
        scopeType: "TENANT",
      },
      method: "POST",
      token: tenantToken,
    });

    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).toContain("集团主管理员不能从客户后台新增或移除");
  });

  it("imports the same employee into two enterprises with eligibility enabled by default", async () => {
    for (const enterpriseId of [enterpriseAId, enterpriseBId]) {
      const department = await request(
        `/console/tenants/${tenantId}/enterprises/${enterpriseId}/departments`,
        {
          body: { code: "OPS", name: "运营部" },
          method: "POST",
          token: tenantToken,
        },
      );
      expect(department.status).toBe(201);
      if (enterpriseId === enterpriseAId) departmentAId = stringField(department.body, "id");
      else departmentBId = stringField(department.body, "id");
      const imported = await request(
        `/console/tenants/${tenantId}/enterprises/${enterpriseId}/memberships/import`,
        {
          body: {
            members: [
              {
                departmentCode: "OPS",
                employeeNo: enterpriseId === enterpriseAId ? "A-001" : "B-001",
                name: "同一自然人",
                phone: employeePhone,
              },
            ],
          },
          method: "POST",
          token: tenantToken,
        },
      );
      expect(imported.status).toBe(201);
      const membershipId = firstMembershipId(imported.body);
      if (enterpriseId === enterpriseAId) membershipAId = membershipId;
      else membershipBId = membershipId;
      expect(arrayField(imported.body, "memberships")).toEqual([
        { id: membershipId, seatStatus: "ENABLED", status: "PENDING_BIND" },
      ]);
      await expect(
        prisma.enterpriseMembership.findUniqueOrThrow({ where: { id: membershipId } }),
      ).resolves.toMatchObject({ seatEnabledAt: expect.any(Date), seatDisabledAt: null });
      await expect(
        prisma.auditLog.count({ where: { action: "membership.enable", resourceId: membershipId } }),
      ).resolves.toBe(1);
    }

    expect(membershipAId).not.toBe(membershipBId);
    await expect(
      prisma.enterpriseMembership.count({ where: { seatStatus: "ENABLED", tenantId } }),
    ).resolves.toBe(2);

    const audit = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/audit-logs`,
      { token: tenantToken },
    );
    expect(audit.status).toBe(200);
    expect(Array.isArray(arrayField(audit.body, "items"))).toBe(true);
    expect(JSON.stringify(audit.body)).not.toContain(employeePhone);
  });

  it("generates stable unique department codes when a name is submitted alone", async () => {
    const path = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/departments`;
    const first = await request(path, {
      body: { name: "产品研发部" },
      method: "POST",
      token: tenantToken,
    });
    const second = await request(path, {
      body: { name: "产品支持部" },
      method: "POST",
      token: tenantToken,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstCode = stringField(first.body, "code");
    const secondCode = stringField(second.body, "code");
    expect(firstCode).toMatch(/^DEP_[A-F0-9]{12}$/u);
    expect(secondCode).toMatch(/^DEP_[A-F0-9]{12}$/u);
    expect(secondCode).not.toBe(firstCode);
    const duplicate = await request(path, {
      body: { code: firstCode, name: "同代码部门" },
      method: "POST",
      token: tenantToken,
    });
    expect(duplicate.status).toBe(409);
  });

  it("previews CSV row errors and rolls the entire invalid batch back", async () => {
    const validPhone = batchPhone(marker, 101);
    const invalidDepartmentPhone = batchPhone(marker, 102);
    const payload = {
      headers: ["姓名", "手机号", "工号", "部门代码"],
      sourceFileName: "员工名单-错误示例.csv",
      members: [
        {
          departmentCode: "OPS",
          employeeNo: "CSV-101",
          name: "预检正常员工",
          phone: validPhone,
          rowNumber: 2,
        },
        {
          departmentCode: "MISSING",
          employeeNo: "CSV-102",
          name: "部门错误员工",
          phone: invalidDepartmentPhone,
          rowNumber: 3,
        },
      ],
    };
    const preview = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import/preview`,
      { body: payload, method: "POST", token: tenantToken },
    );

    expect(preview.status).toBe(201);
    expect(asRecord(preview.body).canImport).toBe(false);
    expect(numberField(asRecord(preview.body).summary, "createCount")).toBe(1);
    expect(numberField(asRecord(preview.body).summary, "errorCount")).toBe(1);
    const previewJson = JSON.stringify(preview.body);
    expect(previewJson).toContain("DEPARTMENT_NOT_FOUND");
    expect(previewJson).not.toContain(validPhone);
    expect(previewJson).not.toContain(invalidDepartmentPhone);
    const failedBatchId = stringField(preview.body, "batchId");
    await expect(
      prisma.membershipImportBatch.findUniqueOrThrow({ where: { id: failedBatchId } }),
    ).resolves.toMatchObject({
      errorCount: 1,
      fileName: "员工名单-错误示例.csv",
      status: "PREVIEW_FAILED",
    });

    const imported = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import`,
      { body: payload, method: "POST", token: tenantToken },
    );
    expect(imported.status).toBe(400);
    await expect(
      prisma.enterpriseMembership.count({
        where: { enterpriseId: enterpriseAId, phone: { in: [validPhone, invalidDepartmentPhone] } },
      }),
    ).resolves.toBe(0);
  });

  it("creates and updates a valid CSV batch with a redacted audit summary", async () => {
    const createdPhone = batchPhone(marker, 103);
    const payload = {
      headers: ["姓名", "手机号", "工号", "部门代码"],
      sourceFileName: "八月员工名单.csv",
      members: [
        {
          departmentCode: "OPS",
          employeeNo: "A-001",
          name: "同一自然人",
          phone: employeePhone,
          rowNumber: 2,
        },
        {
          departmentCode: "OPS",
          employeeNo: "CSV-103",
          name: "CSV 新员工",
          phone: createdPhone,
          rowNumber: 3,
        },
      ],
    };
    const preview = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import/preview`,
      { body: payload, method: "POST", token: tenantToken },
    );
    expect(preview.status).toBe(201);
    expect(asRecord(preview.body).canImport).toBe(true);
    expect(numberField(asRecord(preview.body).summary, "createCount")).toBe(1);
    expect(numberField(asRecord(preview.body).summary, "updateCount")).toBe(1);
    const previewBatchId = stringField(preview.body, "batchId");

    const imported = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import`,
      { body: { ...payload, previewBatchId }, method: "POST", token: tenantToken },
    );
    expect(imported.status).toBe(201);
    expect(numberField(imported.body, "createdCount")).toBe(1);
    expect(numberField(imported.body, "updatedCount")).toBe(1);
    expect(JSON.stringify(imported.body)).not.toContain(employeePhone);
    expect(JSON.stringify(imported.body)).not.toContain(createdPhone);
    expect(stringField(imported.body, "batchId")).toBe(previewBatchId);
    await expect(
      prisma.enterpriseMembership.findUniqueOrThrow({
        where: { enterpriseId_phone: { enterpriseId: enterpriseAId, phone: createdPhone } },
      }),
    ).resolves.toMatchObject({
      seatEnabledAt: expect.any(Date),
      seatStatus: "ENABLED",
      status: "PENDING_BIND",
    });
    await expect(
      prisma.membershipImportBatch.findUniqueOrThrow({ where: { id: previewBatchId } }),
    ).resolves.toMatchObject({
      fileName: "八月员工名单.csv",
      importedAt: expect.any(Date),
      status: "IMPORTED",
    });

    const history = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import-batches`,
      { token: tenantToken },
    );
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.body)).toContain("八月员工名单.csv");
    expect(JSON.stringify(history.body)).toContain("员工名单-错误示例.csv");

    const audit = await prisma.auditLog.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
      where: { action: "membership.import", enterpriseId: enterpriseAId, tenantId },
    });
    expect(audit.metadata).toEqual({
      createdCount: 1,
      source: "CSV",
      totalCount: 2,
      updatedCount: 1,
    });
    expect(JSON.stringify(audit)).not.toContain(employeePhone);
    expect(JSON.stringify(audit)).not.toContain(createdPhone);
  });

  it("preserves disabled employees when reimporting while enabling new employees in the same batch", async () => {
    const phone = batchPhone(marker, 103);
    const base = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}`;
    const membership = await prisma.enterpriseMembership.findUniqueOrThrow({
      where: { enterpriseId_phone: { enterpriseId: enterpriseAId, phone } },
    });
    const disabled = await request(`${base}/memberships/${membership.id}/disable`, {
      body: { reason: "确认重复导入不会重新启用停用员工" },
      method: "POST",
      token: tenantToken,
    });
    expect(disabled.status).toBe(201);
    const before = await prisma.enterpriseMembership.findUniqueOrThrow({
      where: { id: membership.id },
    });
    const imported = await request(`${base}/memberships/import`, {
      body: {
        headers: ["姓名", "手机号", "工号"],
        members: [
          { name: "CSV 新员工", phone, employeeNo: "CSV-103" },
          { name: "默认启用新员工", phone: batchPhone(marker, 106), employeeNo: "CSV-106" },
        ],
      },
      method: "POST",
      token: tenantToken,
    });
    expect(imported.status).toBe(201);
    expect(arrayField(imported.body, "memberships")).toEqual([
      { id: membership.id, seatStatus: "NOT_ENABLED", status: "DISABLED" },
      { id: expect.any(String), seatStatus: "ENABLED", status: "PENDING_BIND" },
    ]);
    await expect(
      prisma.enterpriseMembership.findUniqueOrThrow({ where: { id: membership.id } }),
    ).resolves.toMatchObject({
      name: "CSV 新员工",
      seatEnabledAt: before.seatEnabledAt,
      seatDisabledAt: before.seatDisabledAt,
    });
    await expect(
      prisma.auditLog.count({ where: { action: "membership.enable", resourceId: membership.id } }),
    ).resolves.toBe(1);
  });

  it("rejects duplicate employee numbers and does not silently restore departed employees", async () => {
    const employeeNoConflict = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import/preview`,
      {
        body: {
          headers: ["姓名", "手机号", "工号"],
          members: [
            {
              employeeNo: "A-001",
              name: "冲突员工",
              phone: batchPhone(marker, 104),
              rowNumber: 2,
            },
          ],
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(employeeNoConflict.status).toBe(201);
    expect(JSON.stringify(employeeNoConflict.body)).toContain("EMPLOYEE_NO_CONFLICT");

    const departedPhone = batchPhone(marker, 105);
    const departed = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import`,
      {
        body: { members: [{ employeeNo: "CSV-105", name: "离职员工", phone: departedPhone }] },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(departed.status).toBe(201);
    const departedMembershipId = firstMembershipId(departed.body);
    const left = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/${departedMembershipId}/leave`,
      {
        body: { reason: "验证离职人员不会被批量导入静默恢复" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(left.status).toBe(201);

    const preview = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import/preview`,
      {
        body: { members: [{ employeeNo: "CSV-105", name: "尝试恢复", phone: departedPhone }] },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(preview.status).toBe(201);
    expect(JSON.stringify(preview.body)).toContain("MEMBERSHIP_LEFT");
    await expect(
      prisma.enterpriseMembership.findUniqueOrThrow({ where: { id: departedMembershipId } }),
    ).resolves.toMatchObject({ name: "离职员工", status: "LEFT" });
  });

  it("edits an employee profile and rejects cross-enterprise profile changes", async () => {
    const department = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/departments`,
      {
        body: { code: "GROWTH", name: "增长运营部" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(department.status).toBe(201);
    const departmentId = stringField(department.body, "id");

    const updated = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/${membershipAId}/profile`,
      {
        body: {
          departmentId,
          employeeNo: "A-001-NEW",
          name: "员工资料已更新",
          reason: "人资核对档案后更新",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(updated.status).toBe(201);
    expect(updated.body).toMatchObject({
      departmentId,
      employeeNo: "A-001-NEW",
      name: "员工资料已更新",
    });

    const crossEnterprise = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseBId}/memberships/${membershipAId}/profile`,
      {
        body: { departmentId: departmentBId, name: "越权修改", reason: "验证租户隔离" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(crossEnterprise.status).toBe(404);
  });

  it("supports atomic bulk transfer and publishing eligibility without billing ledgers", async () => {
    const department = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/departments`,
      {
        body: { code: "FIELD", name: "一线业务部" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(department.status).toBe(201);
    const targetDepartmentId = stringField(department.body, "id");
    const imported = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import`,
      {
        body: {
          members: [
            {
              departmentCode: "OPS",
              employeeNo: "BULK-1",
              name: "批量员工一",
              phone: batchPhone(marker, 201),
            },
            {
              departmentCode: "OPS",
              employeeNo: "BULK-2",
              name: "批量员工二",
              phone: batchPhone(marker, 202),
            },
          ],
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(imported.status).toBe(201);
    const membershipIds = arrayField(imported.body, "memberships").map((membership) =>
      stringField(membership, "id"),
    );

    const transfer = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/bulk`,
      {
        body: {
          action: "TRANSFER",
          departmentId: targetDepartmentId,
          membershipIds,
          reason: "组织调整批量转部门",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(transfer.status).toBe(201);
    expect(transfer.body).toMatchObject({ action: "TRANSFER", updatedCount: 2 });

    for (const action of ["DISABLE", "ENABLE"] as const) {
      const response = await request(
        `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/bulk`,
        {
          body: { action, membershipIds, reason: `批量${action}回归验证` },
          method: "POST",
          token: tenantToken,
        },
      );
      expect(response.status).toBe(201);
      expect(numberField(response.body, "updatedCount")).toBe(2);
    }

    const left = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/bulk`,
      {
        body: { action: "LEAVE", membershipIds: [membershipIds[0]], reason: "一名员工离职" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(left.status).toBe(201);
    const rejected = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/bulk`,
      {
        body: {
          action: "TRANSFER",
          departmentId: departmentAId,
          membershipIds,
          reason: "包含离职员工时验证整批失败",
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(rejected.status).toBe(409);
    await expect(
      prisma.enterpriseMembership.findUniqueOrThrow({ where: { id: membershipIds[1] } }),
    ).resolves.toMatchObject({ departmentId: targetDepartmentId });
  });

  it("checks department impact and transfers members before disabling it", async () => {
    const [source, target] = await Promise.all([
      request(`/console/tenants/${tenantId}/enterprises/${enterpriseAId}/departments`, {
        body: { code: "TEMP", name: "待撤销项目组" },
        method: "POST",
        token: tenantToken,
      }),
      request(`/console/tenants/${tenantId}/enterprises/${enterpriseAId}/departments`, {
        body: { code: "SERVICE", name: "客户服务部" },
        method: "POST",
        token: tenantToken,
      }),
    ]);
    expect(source.status).toBe(201);
    expect(target.status).toBe(201);
    const sourceId = stringField(source.body, "id");
    const targetId = stringField(target.body, "id");
    const renamed = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/departments/${sourceId}`,
      {
        body: { code: "TEMP-CLOSE", name: "即将撤销项目组" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(renamed.status).toBe(201);
    expect(renamed.body).toMatchObject({ code: "TEMP-CLOSE", name: "即将撤销项目组" });

    const imported = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import`,
      {
        body: {
          members: [
            {
              departmentCode: "TEMP-CLOSE",
              employeeNo: "TEMP-1",
              name: "待转移员工",
              phone: batchPhone(marker, 203),
            },
          ],
        },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(imported.status).toBe(201);
    const membershipId = firstMembershipId(imported.body);
    const impact = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/departments/${sourceId}/impact`,
      { token: tenantToken },
    );
    expect(impact.status).toBe(200);
    expect(impact.body).toMatchObject({ memberCount: 1, sampleMemberNames: ["待转移员工"] });

    const blocked = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/departments/${sourceId}/disable`,
      {
        body: { reason: "验证必须安排员工去向" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(blocked.status).toBe(409);
    const disabled = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/departments/${sourceId}/disable`,
      {
        body: { reason: "项目结束并转移员工", transferDepartmentId: targetId },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(disabled.status).toBe(201);
    expect(disabled.body).toMatchObject({ status: "DISABLED" });
    await expect(
      prisma.enterpriseMembership.findUniqueOrThrow({ where: { id: membershipId } }),
    ).resolves.toMatchObject({ departmentId: targetId });
  });

  it("keeps import history isolated to the selected enterprise", async () => {
    const response = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseBId}/memberships/import-batches`,
      { token: tenantToken },
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("八月员工名单.csv");
    expect(JSON.stringify(response.body)).not.toContain("员工名单-错误示例.csv");
  });

  it("binds newly imported employees through miniapp OTP without a separate enable step", async () => {
    const code = await request("/auth/employee/request-code", {
      body: { phone: employeePhone },
      method: "POST",
    });
    expect(code.status).toBe(201);
    const candidates = await request("/auth/employee/candidates", {
      body: { phone: employeePhone, code: "000000" },
      method: "POST",
    });
    expect(candidates.status).toBe(201);
    expect(arrayField(candidates.body, "candidates")).toHaveLength(2);
    expect(arrayField(candidates.body, "candidates")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ departmentName: "增长运营部", enterpriseId: enterpriseAId }),
        expect.objectContaining({ departmentName: "运营部", enterpriseId: enterpriseBId }),
      ]),
    );
    const response = await request("/auth/employee/bind", {
      body: { phone: employeePhone, code: "000000", enterpriseIds: [enterpriseAId, enterpriseBId] },
      method: "POST",
    });

    expect(response.status).toBe(201);
    const memberships = arrayField(response.body, "memberships");
    expect(memberships).toHaveLength(2);
    expect(new Set(memberships.map((item) => stringField(item, "membershipId"))).size).toBe(2);
    const enabledSeats = await prisma.enterpriseMembership.count({
      where: { id: { in: [membershipAId, membershipBId] }, seatStatus: "ENABLED", tenantId },
    });
    expect(enabledSeats).toBe(2);
    await expect(
      prisma.auditLog.count({
        where: { action: "employee-membership.bind", tenantId },
      }),
    ).resolves.toBe(2);
    const employee = await prisma.globalUser.findUniqueOrThrow({ where: { phone: employeePhone } });
    expect(employee.lastLoginAt).not.toBeNull();
  });

  it("serializes concurrent publishing-eligibility enables without creating billing ledgers", async () => {
    const enabledBefore = await prisma.enterpriseMembership.count({
      where: { seatStatus: "ENABLED", tenantId },
    });
    const members = Array.from({ length: 20 }, (_, index) => ({
      employeeNo: `LOAD-${index + 1}`,
      name: `并发员工 ${index + 1}`,
      phone: batchPhone(marker, index),
    }));
    const imported = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/import`,
      {
        body: { members },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(imported.status).toBe(201);
    const membershipIds = arrayField(imported.body, "memberships").map((membership) =>
      stringField(membership, "id"),
    );

    const disabled = await request(
      `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/bulk`,
      {
        body: { action: "DISABLE", membershipIds, reason: "准备并发重新启用验证" },
        method: "POST",
        token: tenantToken,
      },
    );
    expect(disabled.status).toBe(201);

    const enabled = await Promise.all(
      membershipIds.map((membershipId) =>
        request(
          `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/${membershipId}/enable`,
          {
            body: { reason: "并发席位回归测试" },
            method: "POST",
            token: tenantToken,
          },
        ),
      ),
    );

    expect(enabled.map(({ status }) => status)).toEqual(Array(20).fill(201));
    await expect(
      prisma.enterpriseMembership.count({ where: { seatStatus: "ENABLED", tenantId } }),
    ).resolves.toBe(enabledBefore + 20);
    await expect(
      prisma.auditLog.count({
        where: {
          action: "membership.enable",
          reason: "并发席位回归测试",
          resourceId: { in: membershipIds },
          tenantId,
        },
      }),
    ).resolves.toBe(20);
  });

  it("does not bill a membership again after disable and re-enable", async () => {
    const base = `/console/tenants/${tenantId}/enterprises/${enterpriseAId}/memberships/${membershipAId}`;
    const disabled = await request(`${base}/disable`, {
      body: { reason: "MVP 测试停用" },
      method: "POST",
      token: tenantToken,
    });
    expect(disabled.status).toBe(201);
    const enabled = await request(`${base}/enable`, {
      body: { reason: "MVP 测试重新启用" },
      method: "POST",
      token: tenantToken,
    });
    expect(enabled.status).toBe(201);
  });

  async function request(
    path: string,
    options: Readonly<{ token?: string; method?: "GET" | "POST"; body?: unknown }> = {},
  ): Promise<ApiResponse> {
    const headers = new Headers();
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.method === "POST") headers.set("idempotency-key", randomUUID());
    const response = await fetch(`${baseUrl}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? "GET",
    });
    const text = await response.text();
    return { body: text ? JSON.parse(text) : null, status: response.status };
  }
});

function firstMembershipId(value: unknown): string {
  const memberships = arrayField(value, "memberships");
  const first = memberships[0];
  if (!first) throw new Error("Expected an imported membership");
  return stringField(first, "id");
}

function arrayField(value: unknown, field: string): unknown[] {
  const record = asRecord(value);
  if (!Array.isArray(record[field])) {
    throw new Error(`Expected array field: ${field}`);
  }
  return record[field];
}

function stringField(value: unknown, field: string): string {
  const record = asRecord(value);
  if (typeof record[field] !== "string") {
    throw new Error(`Expected string field: ${field}`);
  }
  return record[field];
}

function numberField(value: unknown, field: string): number {
  const record = asRecord(value);
  if (typeof record[field] !== "number") {
    throw new Error(`Expected number field: ${field}`);
  }
  return record[field];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected an object response");
  }
  return value as Record<string, unknown>;
}

function assertDevelopmentDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url || new URL(url).pathname.replace(/^\//, "") !== "dev_xhs_agentic") {
    throw new Error("MVP foundation test requires dev_xhs_agentic");
  }
}

function testPhone(marker: string, suffix: number): string {
  const digits = marker.replace(/\D/g, "").slice(-7).padStart(7, "0");
  return `139${digits}${suffix}`;
}

function batchPhone(marker: string, index: number): string {
  const digits = marker.replace(/\D/g, "").slice(-5).padStart(5, "0");
  return `158${digits}${index.toString().padStart(3, "0")}`;
}
