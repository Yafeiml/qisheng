import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma, type StorageReservation } from "@xhs-agentic/database";
import { PrismaService } from "../database/prisma.service";
import { PlatformObjectStorageService } from "../platform-settings/platform-object-storage.service";
import { TenantCapabilityService } from "./tenant-capability.service";

export type StorageReservationInput = Readonly<{
  byteSize: number | bigint;
  expiresAt: Date;
  reservationKey: string;
  resourceId: string;
  resourceType: string;
  storageKey?: string;
  tenantId: string;
}>;

type AccountRow = Readonly<{ reserved_bytes: bigint; used_bytes: bigint }>;

@Injectable()
export class StorageQuotaService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantCapabilityService)
    private readonly tenantCapabilities: TenantCapabilityService,
    @Inject(PlatformObjectStorageService)
    private readonly objectStorage: PlatformObjectStorageService,
  ) {}

  async reserve(input: StorageReservationInput): Promise<StorageReservation> {
    await this.releaseExpired(input.tenantId);
    return this.serializable((transaction) => this.reserveInTransaction(transaction, input));
  }

  async reserveInTransaction(
    transaction: Prisma.TransactionClient,
    input: StorageReservationInput,
  ): Promise<StorageReservation> {
    const byteSize = positiveByteSize(input.byteSize);
    if (input.expiresAt <= new Date()) {
      throw new ConflictException({
        code: "STORAGE_RESERVATION_EXPIRY_INVALID",
        message: "Storage reservation expiry must be in the future",
      });
    }
    const account = await lockStorageAccount(transaction, input.tenantId);
    const existing = await transaction.storageReservation.findUnique({
      where: {
        tenantId_reservationKey: {
          reservationKey: input.reservationKey,
          tenantId: input.tenantId,
        },
      },
    });
    if (existing) {
      if (
        existing.byteSize !== byteSize ||
        existing.resourceId !== input.resourceId ||
        existing.resourceType !== input.resourceType ||
        existing.storageKey !== (input.storageKey ?? null)
      ) {
        throw new ConflictException({
          code: "STORAGE_RESERVATION_KEY_REUSED",
          message: "Storage reservation key was reused with a different resource",
        });
      }
      if (existing.status === "RELEASED") {
        throw new ConflictException({
          code: "STORAGE_RESERVATION_RELEASED",
          message: "Released storage reservation cannot be reused",
        });
      }
      return existing;
    }
    const capability = await this.tenantCapabilities.current(input.tenantId, transaction);
    const requestedTotal = account.used_bytes + account.reserved_bytes + byteSize;
    if (requestedTotal > capability.storageQuotaBytes) {
      throw new ConflictException({
        code: "TENANT_STORAGE_LIMIT_EXCEEDED",
        details: {
          limitBytes: capability.storageQuotaBytes.toString(),
          requestedBytes: byteSize.toString(),
          reservedBytes: account.reserved_bytes.toString(),
          usedBytes: account.used_bytes.toString(),
        },
        message: "The configured tenant storage limit would be exceeded",
      });
    }
    const reservation = await transaction.storageReservation.create({
      data: {
        byteSize,
        expiresAt: input.expiresAt,
        id: randomUUID(),
        reservationKey: input.reservationKey,
        resourceId: input.resourceId,
        resourceType: input.resourceType,
        storageKey: input.storageKey ?? null,
        tenantId: input.tenantId,
      },
    });
    const updated = await transaction.tenantStorageAccount.update({
      data: { reservedBytes: { increment: byteSize } },
      where: { tenantId: input.tenantId },
    });
    await transaction.storageUsageLedger.create({
      data: {
        byteSize,
        id: randomUUID(),
        reason: `Reserve storage for ${input.resourceType}`,
        reservationId: reservation.id,
        reservedBytesAfter: updated.reservedBytes,
        tenantId: input.tenantId,
        type: "RESERVE",
        usedBytesAfter: updated.usedBytes,
      },
    });
    return reservation;
  }

  async commit(
    reservationId: string,
    tenantId: string,
    reason: string,
  ): Promise<StorageReservation> {
    return this.serializable((transaction) =>
      this.commitInTransaction(transaction, reservationId, tenantId, reason),
    );
  }

  async commitInTransaction(
    transaction: Prisma.TransactionClient,
    reservationId: string,
    tenantId: string,
    reason: string,
  ): Promise<StorageReservation> {
    await lockStorageAccount(transaction, tenantId);
    const reservation = await transaction.storageReservation.findFirst({
      where: { id: reservationId, tenantId },
    });
    if (!reservation) throw storageReservationNotFound();
    if (reservation.status === "COMMITTED") return reservation;
    if (reservation.status === "RELEASED") {
      throw new ConflictException({
        code: "STORAGE_RESERVATION_RELEASED",
        message: "Released storage reservation cannot be committed",
      });
    }
    const updated = await transaction.tenantStorageAccount.update({
      data: {
        reservedBytes: { decrement: reservation.byteSize },
        usedBytes: { increment: reservation.byteSize },
      },
      where: { tenantId },
    });
    const committed = await transaction.storageReservation.update({
      data: { committedAt: new Date(), status: "COMMITTED" },
      where: { id: reservation.id },
    });
    await transaction.storageUsageLedger.create({
      data: {
        byteSize: reservation.byteSize,
        id: randomUUID(),
        reason: boundedReason(reason),
        reservationId: reservation.id,
        reservedBytesAfter: updated.reservedBytes,
        tenantId,
        type: "COMMIT",
        usedBytesAfter: updated.usedBytes,
      },
    });
    return committed;
  }

  async release(
    reservationId: string,
    tenantId: string,
    reason: string,
  ): Promise<StorageReservation> {
    return this.serializable((transaction) =>
      this.releaseInTransaction(transaction, reservationId, tenantId, reason),
    );
  }

  async releaseInTransaction(
    transaction: Prisma.TransactionClient,
    reservationId: string,
    tenantId: string,
    reason: string,
  ): Promise<StorageReservation> {
    await lockStorageAccount(transaction, tenantId);
    const reservation = await transaction.storageReservation.findFirst({
      where: { id: reservationId, tenantId },
    });
    if (!reservation) throw storageReservationNotFound();
    if (reservation.status === "RELEASED") return reservation;
    if (reservation.status === "COMMITTED") {
      throw new ConflictException({
        code: "STORAGE_RESERVATION_ALREADY_COMMITTED",
        message: "Committed storage usage cannot be released without deleting the stored resource",
      });
    }
    const updated = await transaction.tenantStorageAccount.update({
      data: { reservedBytes: { decrement: reservation.byteSize } },
      where: { tenantId },
    });
    const released = await transaction.storageReservation.update({
      data: { releasedAt: new Date(), status: "RELEASED" },
      where: { id: reservation.id },
    });
    await transaction.storageUsageLedger.create({
      data: {
        byteSize: reservation.byteSize,
        id: randomUUID(),
        reason: boundedReason(reason),
        reservationId: reservation.id,
        reservedBytesAfter: updated.reservedBytes,
        tenantId,
        type: "RELEASE",
        usedBytesAfter: updated.usedBytes,
      },
    });
    return released;
  }

  async releaseExpired(tenantId?: string): Promise<number> {
    const expired = await this.prisma.storageReservation.findMany({
      orderBy: { expiresAt: "asc" },
      take: 200,
      where: { expiresAt: { lte: new Date() }, status: "RESERVED", tenantId },
    });
    if (expired.length === 0) return 0;
    const { storage } = await this.objectStorage.current();
    let released = 0;
    for (const reservation of expired) {
      try {
        if (reservation.storageKey) await storage.delete(reservation.storageKey);
        await this.release(
          reservation.id,
          reservation.tenantId,
          "Release expired storage reservation after deleting any partial object",
        );
        released += 1;
      } catch {
        // Keep capacity reserved when object cleanup or the serialized release cannot be proven.
      }
    }
    return released;
  }

  async account(tenantId: string) {
    const capability = await this.tenantCapabilities.current(tenantId);
    const account = await this.prisma.tenantStorageAccount.upsert({
      create: { tenantId },
      update: {},
      where: { tenantId },
    });
    return {
      availableBytes: (
        capability.storageQuotaBytes -
        account.usedBytes -
        account.reservedBytes
      ).toString(),
      limitBytes: capability.storageQuotaBytes.toString(),
      reservedBytes: account.reservedBytes.toString(),
      usedBytes: account.usedBytes.toString(),
    };
  }

  private async serializable<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (attempt < 2 && isSerializableConflict(error)) {
          await new Promise<void>((resolve) => setTimeout(resolve, (attempt + 1) * 25));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Storage quota transaction retry exhausted");
  }
}

async function lockStorageAccount(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<AccountRow> {
  await transaction.tenantStorageAccount.upsert({
    create: { tenantId },
    update: {},
    where: { tenantId },
  });
  const rows = await transaction.$queryRaw<AccountRow[]>(Prisma.sql`
    SELECT used_bytes, reserved_bytes
    FROM tenant_storage_accounts
    WHERE tenant_id = ${tenantId}
    FOR UPDATE
  `);
  const account = rows[0];
  if (!account) throw new Error("Tenant storage account lock was not acquired");
  return account;
}

function positiveByteSize(value: number | bigint): bigint {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 1n) {
    throw new ConflictException({
      code: "STORAGE_RESERVATION_SIZE_INVALID",
      message: "Storage reservation requires a positive byte size",
    });
  }
  return parsed;
}

function isSerializableConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;
  const metadataCode =
    error.meta && typeof error.meta === "object" && "code" in error.meta
      ? String(error.meta.code)
      : undefined;
  return metadataCode === "40001" || /\b40001\b|could not serialize access/iu.test(error.message);
}

function boundedReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 2 || reason.length > 500) {
    throw new ConflictException({
      code: "STORAGE_RESERVATION_REASON_INVALID",
      message: "Storage reservation reason must contain 2 to 500 characters",
    });
  }
  return reason;
}

function storageReservationNotFound(): ConflictException {
  return new ConflictException({
    code: "STORAGE_RESERVATION_NOT_FOUND",
    message: "Storage reservation was not found in the tenant",
  });
}
