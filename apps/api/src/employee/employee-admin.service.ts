import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";
import type {
  BulkMembershipActionDto,
  ChangeMembershipPhoneDto,
  CreateDepartmentDto,
  DepartmentStatusActionDto,
  ImportMembershipsDto,
  MembershipActionDto,
  UpdateDepartmentDto,
  UpdateMembershipDto,
} from "./employee-admin.dto";
import { PersonnelGovernanceService } from "./personnel-governance.service";
import { normalizeChineseMobilePhone } from "./phone";

@Injectable()
export class EmployeeAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
    @Inject(PersonnelGovernanceService)
    private readonly personnelGovernance: PersonnelGovernanceService,
  ) {}

  async listDepartments(tenantId: string, enterpriseId: string) {
    this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.prisma.department.findMany({
      orderBy: { createdAt: "asc" },
      where: { enterpriseId, tenantId },
    });
  }

  async createDepartment(tenantId: string, enterpriseId: string, input: CreateDepartmentDto) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = input.code?.toUpperCase() ?? generateDepartmentCode();
      try {
        return await this.prisma.$transaction(async (transaction) => {
          await requireEnterprise(transaction, tenantId, enterpriseId);
          const department = await transaction.department.create({
            data: { code, enterpriseId, name: input.name, tenantId },
          });
          await transaction.auditLog.create({
            data: {
              action: "department.create",
              actorType: "USER",
              actorUserId: principal.userId,
              enterpriseId,
              resourceId: department.id,
              resourceType: "Department",
              stateAfter: { code: department.code, name: department.name },
              tenantId,
            },
          });
          return department;
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }
        if (input.code) throw new ConflictException("当前企业已存在相同部门代码");
      }
    }
    throw new ConflictException("部门代码暂时无法生成，请重试");
  }

  async updateDepartment(
    tenantId: string,
    enterpriseId: string,
    departmentId: string,
    input: UpdateDepartmentDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    if (!input.name && !input.code) {
      throw new BadRequestException("请至少修改部门名称或部门代码");
    }
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const department = await requireDepartment(
          transaction,
          tenantId,
          enterpriseId,
          departmentId,
        );
        const updated = await transaction.department.update({
          data: {
            code: input.code?.toUpperCase(),
            name: input.name,
          },
          where: { id: department.id },
        });
        await transaction.auditLog.create({
          data: {
            action: "department.update",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId,
            resourceId: department.id,
            resourceType: "Department",
            stateAfter: { code: updated.code, name: updated.name, status: updated.status },
            stateBefore: {
              code: department.code,
              name: department.name,
              status: department.status,
            },
            tenantId,
          },
        });
        return updated;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("当前企业已存在相同部门代码");
      }
      throw error;
    }
  }

  async departmentImpact(tenantId: string, enterpriseId: string, departmentId: string) {
    this.requireEnterpriseScope(tenantId, enterpriseId);
    await requireDepartment(this.prisma, tenantId, enterpriseId, departmentId);
    const [memberCount, enabledSeatCount, sampleMembers] = await Promise.all([
      this.prisma.enterpriseMembership.count({
        where: { departmentId, enterpriseId, status: { not: "LEFT" }, tenantId },
      }),
      this.prisma.enterpriseMembership.count({
        where: { departmentId, enterpriseId, seatStatus: "ENABLED", tenantId },
      }),
      this.prisma.enterpriseMembership.findMany({
        orderBy: { createdAt: "asc" },
        select: { name: true },
        take: 8,
        where: { departmentId, enterpriseId, status: { not: "LEFT" }, tenantId },
      }),
    ]);
    return {
      enabledSeatCount,
      memberCount,
      sampleMemberNames: sampleMembers.map(({ name }) => name),
    };
  }

  async disableDepartment(
    tenantId: string,
    enterpriseId: string,
    departmentId: string,
    input: DepartmentStatusActionDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.prisma.$transaction(
      async (transaction) => {
        const department = await requireDepartment(
          transaction,
          tenantId,
          enterpriseId,
          departmentId,
        );
        if (department.status === "DISABLED") return department;
        const memberCount = await transaction.enterpriseMembership.count({
          where: { departmentId, enterpriseId, status: { not: "LEFT" }, tenantId },
        });
        if (memberCount > 0 && !input.transferDepartmentId) {
          throw new ConflictException(
            `该部门仍有 ${memberCount} 名在职员工，请先选择接收部门后再停用`,
          );
        }
        if (input.transferDepartmentId === departmentId) {
          throw new BadRequestException("接收部门不能与待停用部门相同");
        }
        if (input.transferDepartmentId) {
          const target = await requireDepartment(
            transaction,
            tenantId,
            enterpriseId,
            input.transferDepartmentId,
          );
          if (target.status !== "ACTIVE") {
            throw new ConflictException("接收部门已停用，不能接收员工");
          }
          await transaction.enterpriseMembership.updateMany({
            data: { departmentId: target.id },
            where: { departmentId, enterpriseId, tenantId },
          });
        }
        const updated = await transaction.department.update({
          data: { status: "DISABLED" },
          where: { id: department.id },
        });
        await transaction.auditLog.create({
          data: {
            action: "department.disable",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId,
            metadata: {
              memberCount,
              transferDepartmentId: input.transferDepartmentId ?? null,
            },
            reason: input.reason,
            resourceId: department.id,
            resourceType: "Department",
            stateAfter: { status: updated.status },
            stateBefore: { status: department.status },
            tenantId,
          },
        });
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async importMemberships(tenantId: string, enterpriseId: string, input: ImportMembershipsDto) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await requireEnterprise(transaction, tenantId, enterpriseId);
          const prepared = await prepareMembershipImport(
            transaction,
            tenantId,
            enterpriseId,
            input,
          );
          if (!prepared.canImport) {
            throw importValidationException(prepared);
          }
          if (prepared.summary.createCount > 0) {
            await this.personnelGovernance.assertEnterpriseSeatManagementAllowed(
              tenantId,
              enterpriseId,
              transaction,
            );
          }

          const enabledAt = new Date();
          const memberships: Array<{
            id: string;
            seatStatus: "ENABLED" | "NOT_ENABLED";
            status: "ACTIVE" | "PENDING_BIND" | "DISABLED" | "LEFT";
          }> = [];
          for (const row of prepared.rows) {
            if (!row.phone || row.action === "ERROR") {
              throw importValidationException(prepared);
            }
            const membership = await transaction.enterpriseMembership.upsert({
              create: {
                departmentId: row.departmentId,
                employeeNo: row.employeeNo,
                enterpriseId,
                name: row.name,
                phone: row.phone,
                seatEnabledAt: enabledAt,
                seatStatus: "ENABLED",
                tenantId,
              },
              select: { id: true, seatStatus: true, status: true },
              update: {
                departmentId: row.departmentCode ? row.departmentId : undefined,
                employeeNo: row.employeeNo,
              },
              where: { enterpriseId_phone: { enterpriseId, phone: row.phone } },
            });
            memberships.push(membership);
            if (row.action === "CREATE") {
              await auditMembershipChange(transaction, {
                action: "membership.enable",
                actorUserId: principal.userId,
                enterpriseId,
                membershipId: membership.id,
                reason: "新增员工时默认启用任务资格",
                tenantId,
              });
            }
          }

          await transaction.auditLog.create({
            data: {
              action: "membership.import",
              actorType: "USER",
              actorUserId: principal.userId,
              enterpriseId,
              metadata: {
                createdCount: prepared.summary.createCount,
                source: input.headers ? "CSV" : "FORM_OR_API",
                totalCount: prepared.summary.totalCount,
                updatedCount: prepared.summary.updateCount,
              },
              resourceType: "EnterpriseMembership",
              tenantId,
            },
          });
          const report = publicImportPreview(prepared);
          const existingBatch = input.previewBatchId
            ? await transaction.membershipImportBatch.findFirst({
                where: {
                  enterpriseId,
                  id: input.previewBatchId,
                  status: { in: ["PREVIEW_READY", "PREVIEW_FAILED"] },
                  tenantId,
                },
              })
            : null;
          if (input.previewBatchId && !existingBatch) {
            throw new ConflictException("导入预检记录已失效，请重新选择文件预检");
          }
          const batch = existingBatch
            ? await transaction.membershipImportBatch.update({
                data: {
                  createCount: prepared.summary.createCount,
                  errorCount: prepared.summary.errorCount,
                  importedAt: new Date(),
                  report: report as unknown as Prisma.InputJsonValue,
                  rowCount: prepared.summary.totalCount,
                  status: "IMPORTED",
                  updateCount: prepared.summary.updateCount,
                },
                where: { id: existingBatch.id },
              })
            : await transaction.membershipImportBatch.create({
                data: {
                  createCount: prepared.summary.createCount,
                  createdBy: principal.userId,
                  enterpriseId,
                  errorCount: prepared.summary.errorCount,
                  fileName: input.sourceFileName,
                  importedAt: new Date(),
                  report: report as unknown as Prisma.InputJsonValue,
                  rowCount: prepared.summary.totalCount,
                  source: input.headers ? "CSV" : "FORM_OR_API",
                  status: "IMPORTED",
                  tenantId,
                  updateCount: prepared.summary.updateCount,
                },
              });
          return {
            batchId: batch.id,
            count: memberships.length,
            createdCount: prepared.summary.createCount,
            memberships,
            updatedCount: prepared.summary.updateCount,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("员工手机号或工号在预检后发生并发冲突，请重新预检后再导入");
      }
      if (isSerializableConflict(error)) {
        throw new ConflictException("员工数据在导入期间发生变化，请重新预检后再导入");
      }
      throw error;
    }
  }

  async previewMembershipImport(
    tenantId: string,
    enterpriseId: string,
    input: ImportMembershipsDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.prisma.$transaction(async (transaction) => {
      await requireEnterprise(transaction, tenantId, enterpriseId);
      const prepared = await prepareMembershipImport(transaction, tenantId, enterpriseId, input);
      const preview = publicImportPreview(prepared);
      const batch = await transaction.membershipImportBatch.create({
        data: {
          createCount: prepared.summary.createCount,
          createdBy: principal.userId,
          enterpriseId,
          errorCount: prepared.summary.errorCount,
          fileName: input.sourceFileName,
          report: preview as unknown as Prisma.InputJsonValue,
          rowCount: prepared.summary.totalCount,
          source: input.headers ? "CSV" : "FORM_OR_API",
          status: prepared.canImport ? "PREVIEW_READY" : "PREVIEW_FAILED",
          tenantId,
          updateCount: prepared.summary.updateCount,
        },
      });
      return { ...preview, batchId: batch.id };
    });
  }

  async listMembershipImportBatches(tenantId: string, enterpriseId: string) {
    this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.prisma.membershipImportBatch.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      where: { enterpriseId, tenantId },
    });
  }

  async updateMembership(
    tenantId: string,
    enterpriseId: string,
    membershipId: string,
    input: UpdateMembershipDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const membership = await requireMembership(
          transaction,
          tenantId,
          enterpriseId,
          membershipId,
        );
        if (membership.status === "LEFT") {
          throw new ConflictException("离职员工档案不可直接修改，请先通过独立恢复流程处理");
        }
        if (input.departmentId) {
          const department = await requireDepartment(
            transaction,
            tenantId,
            enterpriseId,
            input.departmentId,
          );
          if (department.status !== "ACTIVE") {
            throw new ConflictException("不能把员工转入已停用部门");
          }
        }
        const updated = await transaction.enterpriseMembership.update({
          data: {
            departmentId:
              input.departmentId === null
                ? null
                : input.departmentId
                  ? input.departmentId
                  : undefined,
            employeeNo:
              input.employeeNo === undefined ? undefined : (optionalTrim(input.employeeNo) ?? null),
            name: input.name,
          },
          where: { id: membership.id },
        });
        await transaction.auditLog.create({
          data: {
            action: "membership.profile.update",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId,
            reason: input.reason,
            resourceId: membership.id,
            resourceType: "EnterpriseMembership",
            stateAfter: {
              departmentId: updated.departmentId,
              employeeNo: updated.employeeNo,
              name: updated.name,
            },
            stateBefore: {
              departmentId: membership.departmentId,
              employeeNo: membership.employeeNo,
              name: membership.name,
            },
            tenantId,
          },
        });
        return updated;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("该工号已属于当前企业的其他员工");
      }
      throw error;
    }
  }

  async changeMembershipPhone(
    tenantId: string,
    enterpriseId: string,
    membershipId: string,
    input: ChangeMembershipPhoneDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    let phone: string;
    try {
      phone = normalizeChineseMobilePhone(input.phone);
    } catch {
      throw new BadRequestException("手机号不是有效的中国大陆手机号码");
    }
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT id FROM enterprise_memberships
          WHERE id = ${membershipId} AND enterprise_id = ${enterpriseId} AND tenant_id = ${tenantId}
          FOR UPDATE
        `);
        const membership = await requireMembership(
          transaction,
          tenantId,
          enterpriseId,
          membershipId,
        );
        if (membership.status === "LEFT") {
          throw new ConflictException("离职员工档案不可直接修改，请先通过独立恢复流程处理");
        }
        if (membership.phone === phone) return membership;
        const sending = await transaction.employeeTaskNotification.count({
          where: {
            channel: "ALIYUN_SMS",
            status: "SENDING",
            task: { enterpriseId, membershipId, tenantId },
          },
        });
        if (sending > 0) {
          throw new ConflictException("该员工的短信正在发送，请稍后再更正手机号");
        }
        const duplicate = await transaction.enterpriseMembership.findUnique({
          select: { id: true },
          where: { enterpriseId_phone: { enterpriseId, phone } },
        });
        if (duplicate) throw new ConflictException("该手机号已属于当前企业的其他员工");
        const updated = await transaction.enterpriseMembership.update({
          data: {
            boundAt: null,
            globalUserId: null,
            phone,
            smsNotificationPhoneVersion: { increment: 1 },
            smsNotificationStatus: "PENDING_VERIFICATION",
            smsNotificationStatusAt: null,
            status: membership.status === "ACTIVE" ? "PENDING_BIND" : membership.status,
          },
          where: { id: membership.id },
        });
        await transaction.auditLog.create({
          data: {
            action: "membership.phone.change",
            actorType: "USER",
            actorUserId: principal.userId,
            enterpriseId,
            reason: input.reason,
            resourceId: membership.id,
            resourceType: "EnterpriseMembership",
            stateBefore: {
              boundAt: membership.boundAt?.toISOString() ?? null,
              globalUserId: membership.globalUserId,
              maskedPhone: maskPhone(membership.phone),
              smsNotificationPhoneVersion: membership.smsNotificationPhoneVersion,
              smsNotificationStatus: membership.smsNotificationStatus,
              status: membership.status,
            },
            stateAfter: {
              boundAt: null,
              globalUserId: null,
              maskedPhone: maskPhone(updated.phone),
              smsNotificationPhoneVersion: updated.smsNotificationPhoneVersion,
              smsNotificationStatus: updated.smsNotificationStatus,
              status: updated.status,
            },
            tenantId,
          },
        });
        return updated;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("该手机号已属于当前企业的其他员工");
      }
      throw error;
    }
  }

  async bulkMembershipAction(
    tenantId: string,
    enterpriseId: string,
    input: BulkMembershipActionDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    const membershipIds = [...new Set(input.membershipIds)];
    if (input.action === "ENABLE" || input.action === "DISABLE") {
      await this.personnelGovernance.assertEnterpriseSeatManagementAllowed(tenantId, enterpriseId);
    }
    if (input.action === "TRANSFER" || input.action === "LEAVE") {
    }
    return this.inSeatChangeTransaction(tenantId, async (transaction) => {
      const memberships = await transaction.enterpriseMembership.findMany({
        where: { enterpriseId, id: { in: membershipIds }, tenantId },
      });
      if (memberships.length !== membershipIds.length) {
        throw new NotFoundException("部分员工不在当前企业范围内，请刷新后重试");
      }
      const departed = memberships.filter(({ status }) => status === "LEFT");
      if (departed.length > 0 && input.action !== "LEAVE") {
        throw new ConflictException("所选员工中包含已离职人员，不能执行当前批量操作");
      }
      const now = new Date();
      let updatedCount = 0;

      if (input.action === "TRANSFER") {
        if (!input.departmentId) throw new BadRequestException("请选择接收部门");
        const department = await requireDepartment(
          transaction,
          tenantId,
          enterpriseId,
          input.departmentId,
        );
        if (department.status !== "ACTIVE") {
          throw new ConflictException("接收部门已停用，不能接收员工");
        }
        const result = await transaction.enterpriseMembership.updateMany({
          data: { departmentId: department.id },
          where: { id: { in: membershipIds } },
        });
        updatedCount = result.count;
      } else if (input.action === "ENABLE") {
        const targets = memberships.filter(({ seatStatus }) => seatStatus !== "ENABLED");
        if (targets.length > 0) {
          const boundIds = targets.filter(({ globalUserId }) => globalUserId).map(({ id }) => id);
          const pendingIds = targets
            .filter(({ globalUserId }) => !globalUserId)
            .map(({ id }) => id);
          if (boundIds.length > 0) {
            await transaction.enterpriseMembership.updateMany({
              data: {
                seatDisabledAt: null,
                seatEnabledAt: now,
                seatStatus: "ENABLED",
                status: "ACTIVE",
              },
              where: { id: { in: boundIds } },
            });
          }
          if (pendingIds.length > 0) {
            await transaction.enterpriseMembership.updateMany({
              data: {
                seatDisabledAt: null,
                seatEnabledAt: now,
                seatStatus: "ENABLED",
                status: "PENDING_BIND",
              },
              where: { id: { in: pendingIds } },
            });
          }
          updatedCount = targets.length;
        }
      } else {
        const targets =
          input.action === "DISABLE"
            ? memberships.filter(({ seatStatus }) => seatStatus === "ENABLED")
            : memberships;
        await transaction.enterpriseMembership.updateMany({
          data:
            input.action === "LEAVE"
              ? { seatDisabledAt: now, seatStatus: "NOT_ENABLED", status: "LEFT" }
              : { seatDisabledAt: now, seatStatus: "NOT_ENABLED", status: "DISABLED" },
          where: { id: { in: targets.map(({ id }) => id) } },
        });
        updatedCount = targets.length;
      }

      await transaction.auditLog.create({
        data: {
          action: `membership.bulk.${input.action.toLowerCase()}`,
          actorType: "USER",
          actorUserId: principal.userId,
          enterpriseId,
          metadata: {
            departmentId: input.departmentId ?? null,
            membershipIds,
            updatedCount,
          },
          reason: input.reason,
          resourceType: "EnterpriseMembership",
          tenantId,
        },
      });
      return { action: input.action, updatedCount };
    });
  }

  async enableMembership(
    tenantId: string,
    enterpriseId: string,
    membershipId: string,
    input: MembershipActionDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    await this.personnelGovernance.assertEnterpriseSeatManagementAllowed(tenantId, enterpriseId);
    return this.inSeatChangeTransaction(tenantId, async (transaction) => {
      const membership = await requireMembership(transaction, tenantId, enterpriseId, membershipId);
      if (membership.status === "LEFT") {
        throw new ConflictException("A departed membership cannot be enabled");
      }
      if (membership.seatStatus === "ENABLED") {
        return membership;
      }
      const updated = await transaction.enterpriseMembership.update({
        data: {
          seatDisabledAt: null,
          seatEnabledAt: new Date(),
          seatStatus: "ENABLED",
          status: membership.globalUserId ? "ACTIVE" : "PENDING_BIND",
        },
        where: { id: membership.id },
      });
      await auditMembershipChange(transaction, {
        action: "membership.enable",
        actorUserId: principal.userId,
        enterpriseId,
        membershipId,
        reason: input.reason,
        tenantId,
      });
      return updated;
    });
  }

  async disableMembership(
    tenantId: string,
    enterpriseId: string,
    membershipId: string,
    input: MembershipActionDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    await this.personnelGovernance.assertEnterpriseSeatManagementAllowed(tenantId, enterpriseId);
    return this.inSeatChangeTransaction(tenantId, async (transaction) => {
      const membership = await requireMembership(transaction, tenantId, enterpriseId, membershipId);
      if (membership.seatStatus === "NOT_ENABLED") {
        return membership;
      }
      const updated = await transaction.enterpriseMembership.update({
        data: {
          seatDisabledAt: new Date(),
          seatStatus: "NOT_ENABLED",
          status: "DISABLED",
        },
        where: { id: membership.id },
      });
      await auditMembershipChange(transaction, {
        action: "membership.disable",
        actorUserId: principal.userId,
        enterpriseId,
        membershipId,
        reason: input.reason,
        tenantId,
      });
      return updated;
    });
  }

  async markMembershipLeft(
    tenantId: string,
    enterpriseId: string,
    membershipId: string,
    input: MembershipActionDto,
  ) {
    const principal = this.requireEnterpriseScope(tenantId, enterpriseId);
    return this.inSeatChangeTransaction(tenantId, async (transaction) => {
      const membership = await requireMembership(transaction, tenantId, enterpriseId, membershipId);
      const updated = await transaction.enterpriseMembership.update({
        data: {
          seatDisabledAt:
            membership.seatStatus === "ENABLED" ? new Date() : membership.seatDisabledAt,
          seatStatus: "NOT_ENABLED",
          status: "LEFT",
        },
        where: { id: membership.id },
      });
      await auditMembershipChange(transaction, {
        action: "membership.leave",
        actorUserId: principal.userId,
        enterpriseId,
        membershipId,
        reason: input.reason,
        tenantId,
      });
      return updated;
    });
  }

  private async inSeatChangeTransaction<T>(
    tenantId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const maximumAttempts = 5;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await transaction.$queryRaw(
              Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`xhs-agentic:membership-state:${tenantId}`}, 0))::text AS lock_result`,
            );
            return operation(transaction);
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 10_000,
            timeout: 30_000,
          },
        );
      } catch (error) {
        if (!isSerializableConflict(error)) throw error;
        if (attempt === maximumAttempts) {
          throw new ConflictException(
            "Employee status update could not be completed because of concurrent changes; retry the request",
          );
        }
        await delay(attempt * 25 + Math.floor(Math.random() * 25));
      }
    }
    throw new ConflictException("Employee status update retry limit was reached");
  }

  private requireEnterpriseScope(tenantId: string, enterpriseId: string) {
    const principal = this.accessContext.requireSaasAdmin();
    if (
      principal.scope.type !== "ENTERPRISE" ||
      principal.scope.tenantId !== tenantId ||
      principal.scope.enterpriseId !== enterpriseId
    ) {
      throw new ForbiddenException("Active request scope does not match the requested enterprise");
    }
    return principal;
  }
}

function isSerializableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type ImportRowError = Readonly<{ code: string; message: string }>;

type PreparedImportRow = {
  action: "CREATE" | "ERROR" | "UPDATE";
  departmentCode?: string;
  departmentId?: string;
  employeeNo?: string;
  errors: ImportRowError[];
  name: string;
  phone?: string;
  rowNumber: number;
};

type PreparedMembershipImport = Readonly<{
  canImport: boolean;
  fileErrors: ImportRowError[];
  rows: PreparedImportRow[];
  summary: Readonly<{
    createCount: number;
    errorCount: number;
    totalCount: number;
    updateCount: number;
  }>;
}>;

const CSV_HEADERS = ["姓名", "手机号", "工号", "部门代码"] as const;
const REQUIRED_CSV_HEADERS = ["姓名", "手机号"] as const;

async function prepareMembershipImport(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  enterpriseId: string,
  input: ImportMembershipsDto,
): Promise<PreparedMembershipImport> {
  const fileErrors = validateCsvHeaders(input.headers);
  const rows: PreparedImportRow[] = input.members.map((member, index) => {
    const errors: ImportRowError[] = [];
    const name = member.name.trim();
    const employeeNo = optionalTrim(member.employeeNo);
    const departmentCode = optionalTrim(member.departmentCode)?.toUpperCase();
    let phone: string | undefined;

    if (!name) {
      errors.push({ code: "NAME_REQUIRED", message: "姓名不能为空" });
    } else if (name.length > 100) {
      errors.push({ code: "NAME_TOO_LONG", message: "姓名不能超过 100 个字符" });
    }
    if (employeeNo && employeeNo.length > 64) {
      errors.push({ code: "EMPLOYEE_NO_TOO_LONG", message: "工号不能超过 64 个字符" });
    }
    if (departmentCode && departmentCode.length > 64) {
      errors.push({ code: "DEPARTMENT_CODE_TOO_LONG", message: "部门代码不能超过 64 个字符" });
    }
    try {
      phone = normalizeChineseMobilePhone(member.phone);
    } catch {
      errors.push({ code: "PHONE_INVALID", message: "手机号不是有效的中国大陆手机号码" });
    }

    return {
      action: "ERROR",
      departmentCode,
      employeeNo,
      errors,
      name,
      phone,
      rowNumber: member.rowNumber ?? index + 2,
    };
  });

  const phoneCounts = countValues(rows.flatMap(({ phone }) => (phone ? [phone] : [])));
  const employeeNoCounts = countValues(
    rows.flatMap(({ employeeNo }) => (employeeNo ? [employeeNo] : [])),
  );
  const departmentCodes = [
    ...new Set(rows.flatMap(({ departmentCode }) => (departmentCode ? [departmentCode] : []))),
  ];
  const departments = departmentCodes.length
    ? await transaction.department.findMany({
        select: { code: true, id: true },
        where: { code: { in: departmentCodes }, enterpriseId, status: "ACTIVE", tenantId },
      })
    : [];
  const departmentIds = new Map(departments.map(({ code, id }) => [code, id]));

  const phones = [...phoneCounts.keys()];
  const employeeNumbers = [...employeeNoCounts.keys()];
  const identityFilters: Prisma.EnterpriseMembershipWhereInput[] = [];
  if (phones.length > 0) identityFilters.push({ phone: { in: phones } });
  if (employeeNumbers.length > 0) identityFilters.push({ employeeNo: { in: employeeNumbers } });
  const existingMemberships =
    identityFilters.length > 0
      ? await transaction.enterpriseMembership.findMany({
          select: { employeeNo: true, id: true, name: true, phone: true, status: true },
          where: { enterpriseId, OR: identityFilters, tenantId },
        })
      : [];
  const existingByPhone = new Map(
    existingMemberships.map((membership) => [membership.phone, membership]),
  );
  const existingByEmployeeNo = new Map(
    existingMemberships.flatMap((membership) =>
      membership.employeeNo ? [[membership.employeeNo, membership] as const] : [],
    ),
  );

  for (const row of rows) {
    if (row.phone && (phoneCounts.get(row.phone) ?? 0) > 1) {
      addRowError(row, "PHONE_DUPLICATE_IN_FILE", "同一批次中手机号重复");
    }
    if (row.employeeNo && (employeeNoCounts.get(row.employeeNo) ?? 0) > 1) {
      addRowError(row, "EMPLOYEE_NO_DUPLICATE_IN_FILE", "同一批次中工号重复");
    }
    if (row.departmentCode) {
      row.departmentId = departmentIds.get(row.departmentCode);
      if (!row.departmentId) {
        addRowError(row, "DEPARTMENT_NOT_FOUND", `部门代码 ${row.departmentCode} 不存在或已停用`);
      }
    }

    const currentMembership = row.phone ? existingByPhone.get(row.phone) : undefined;
    if (currentMembership && currentMembership.name.trim() !== row.name) {
      addRowError(
        row,
        "PHONE_NAME_CONFLICT",
        "该手机号已属于本企业其他姓名的员工，请核实手机号和姓名；导入不会覆盖原员工资料",
      );
    }
    if (currentMembership?.status === "LEFT") {
      addRowError(
        row,
        "MEMBERSHIP_LEFT",
        "该手机号对应员工已离职，批量导入不会自动恢复，请通过独立的人事流程处理",
      );
    }
    if (row.employeeNo) {
      const employeeNoOwner = existingByEmployeeNo.get(row.employeeNo);
      if (employeeNoOwner && employeeNoOwner.id !== currentMembership?.id) {
        addRowError(row, "EMPLOYEE_NO_CONFLICT", "该工号已属于本企业其他员工");
      }
    }
    row.action = row.errors.length > 0 ? "ERROR" : currentMembership ? "UPDATE" : "CREATE";
  }

  const summary = {
    createCount: rows.filter(({ action }) => action === "CREATE").length,
    errorCount: rows.filter(({ action }) => action === "ERROR").length,
    totalCount: rows.length,
    updateCount: rows.filter(({ action }) => action === "UPDATE").length,
  };
  return {
    canImport: fileErrors.length === 0 && summary.errorCount === 0,
    fileErrors,
    rows,
    summary,
  };
}

function publicImportPreview(prepared: PreparedMembershipImport) {
  return {
    canImport: prepared.canImport,
    fileErrors: prepared.fileErrors,
    rows: prepared.rows.map((row) => ({
      action: row.action,
      errors: row.errors,
      normalized: {
        departmentCode: row.departmentCode ?? null,
        employeeNo: row.employeeNo ?? null,
        maskedPhone: row.phone ? maskPhone(row.phone) : "格式无效",
        name: row.name,
      },
      rowNumber: row.rowNumber,
    })),
    summary: prepared.summary,
  };
}

function importValidationException(prepared: PreparedMembershipImport): BadRequestException {
  const hasPhoneNameConflict = prepared.rows.some(({ errors }) =>
    errors.some(({ code }) => code === "PHONE_NAME_CONFLICT"),
  );
  return new BadRequestException({
    code: "MEMBERSHIP_IMPORT_VALIDATION_FAILED",
    message: hasPhoneNameConflict
      ? "导入手机号已对应本企业其他姓名的员工，请核实；整批未写入"
      : "导入数据未通过预检，整批未写入",
    preview: publicImportPreview(prepared),
  });
}

function validateCsvHeaders(headers: string[] | undefined): ImportRowError[] {
  if (!headers) return [];
  const normalized = headers.map((header) => header.replace(/^\uFEFF/u, "").trim());
  const errors: ImportRowError[] = [];
  const counts = countValues(normalized);
  for (const required of REQUIRED_CSV_HEADERS) {
    if (!counts.has(required)) {
      errors.push({ code: "CSV_HEADER_REQUIRED", message: `CSV 缺少必填表头：${required}` });
    }
  }
  for (const header of normalized) {
    if (!CSV_HEADERS.includes(header as (typeof CSV_HEADERS)[number])) {
      errors.push({
        code: "CSV_HEADER_UNKNOWN",
        message: header ? `CSV 包含未知表头：${header}` : "CSV 包含空白表头",
      });
    } else if ((counts.get(header) ?? 0) > 1) {
      errors.push({ code: "CSV_HEADER_DUPLICATE", message: `CSV 表头重复：${header}` });
    }
  }
  return deduplicateErrors(errors);
}

function addRowError(row: PreparedImportRow, code: string, message: string): void {
  if (!row.errors.some((error) => error.code === code)) row.errors.push({ code, message });
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function optionalTrim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function generateDepartmentCode(): string {
  return `DEP_${randomBytes(6).toString("hex").toUpperCase()}`;
}

function maskPhone(value: string): string {
  return value.replace(/^(\d{3})\d+(\d{4})$/u, "$1****$2");
}

function deduplicateErrors(errors: ImportRowError[]): ImportRowError[] {
  return errors.filter(
    (error, index) =>
      errors.findIndex(
        (candidate) => candidate.code === error.code && candidate.message === error.message,
      ) === index,
  );
}

async function requireEnterprise(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  enterpriseId: string,
): Promise<void> {
  const enterprise = await transaction.enterprise.findFirst({
    select: { id: true },
    where: { id: enterpriseId, status: "ACTIVE", tenantId },
  });
  if (!enterprise) {
    throw new NotFoundException("Active enterprise was not found");
  }
}

async function requireDepartment(
  transaction: Prisma.TransactionClient | PrismaService,
  tenantId: string,
  enterpriseId: string,
  departmentId: string,
) {
  const department = await transaction.department.findFirst({
    where: { enterpriseId, id: departmentId, tenantId },
  });
  if (!department) {
    throw new NotFoundException("当前企业中未找到该部门");
  }
  return department;
}

async function requireMembership(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  enterpriseId: string,
  membershipId: string,
) {
  const membership = await transaction.enterpriseMembership.findFirst({
    where: { enterpriseId, id: membershipId, tenantId },
  });
  if (!membership) {
    throw new NotFoundException("Enterprise membership was not found in the active scope");
  }
  return membership;
}

async function auditMembershipChange(
  transaction: Prisma.TransactionClient,
  input: Readonly<{
    action: string;
    actorUserId: string;
    enterpriseId: string;
    membershipId: string;
    reason: string;
    tenantId: string;
  }>,
): Promise<void> {
  await transaction.auditLog.create({
    data: {
      action: input.action,
      actorType: "USER",
      actorUserId: input.actorUserId,
      enterpriseId: input.enterpriseId,
      reason: input.reason,
      resourceId: input.membershipId,
      resourceType: "EnterpriseMembership",
      tenantId: input.tenantId,
    },
  });
}
