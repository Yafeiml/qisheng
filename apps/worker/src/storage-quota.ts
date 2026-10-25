import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type StorageReservation } from "@xhs-agentic/database";
import type { ObjectStorage } from "@xhs-agentic/object-storage";
import { isPrismaSerializationConflict } from "./generation-execution";

type ReservationInput = Readonly<{
  byteSize: number;
  expiresAt: Date;
  reservationKey: string;
  resourceId: string;
  resourceType: string;
  storageKey: string;
  tenantId: string;
}>;

type AccountRow = Readonly<{ reserved_bytes: bigint; used_bytes: bigint }>;

export class WorkerStorageQuota {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
  ) {}

  async reserve(input: ReservationInput): Promise<StorageReservation> {
    await this.releaseExpired(input.tenantId);
    return this.serializable(async (transaction) => {
      const bytes = BigInt(input.byteSize);
      if (bytes < 1n || input.expiresAt <= new Date()) {
        throw new StorageQuotaError("STORAGE_RESERVATION_INVALID");
      }
      const account = await lockAccount(transaction, input.tenantId);
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
          existing.byteSize !== bytes ||
          existing.resourceId !== input.resourceId ||
          existing.resourceType !== input.resourceType ||
          existing.storageKey !== input.storageKey
        ) {
          throw new StorageQuotaError("STORAGE_RESERVATION_KEY_REUSED");
        }
        if (existing.status === "RELEASED") {
          throw new StorageQuotaError("STORAGE_RESERVATION_RELEASED");
        }
        return existing;
      }
      const capability = await transaction.tenantCapabilityPolicy.upsert({
        create: { tenantId: input.tenantId },
        update: {},
        where: { tenantId: input.tenantId },
      });
      if (account.used_bytes + account.reserved_bytes + bytes > capability.storageLimitBytes) {
        throw new StorageQuotaError("TENANT_STORAGE_LIMIT_EXCEEDED");
      }
      const reservation = await transaction.storageReservation.create({
        data: {
          byteSize: bytes,
          expiresAt: input.expiresAt,
          id: randomUUID(),
          reservationKey: input.reservationKey,
          resourceId: input.resourceId,
          resourceType: input.resourceType,
          storageKey: input.storageKey,
          tenantId: input.tenantId,
        },
      });
      const updated = await transaction.tenantStorageAccount.update({
        data: { reservedBytes: { increment: bytes } },
        where: { tenantId: input.tenantId },
      });
      await transaction.storageUsageLedger.create({
        data: {
          byteSize: bytes,
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
    });
  }

  async commitInTransaction(
    transaction: Prisma.TransactionClient,
    reservationId: string,
    tenantId: string,
    reason: string,
  ): Promise<void> {
    await lockAccount(transaction, tenantId);
    const reservation = await transaction.storageReservation.findFirst({
      where: { id: reservationId, tenantId },
    });
    if (!reservation) throw new StorageQuotaError("STORAGE_RESERVATION_NOT_FOUND");
    if (reservation.status === "COMMITTED") return;
    if (reservation.status !== "RESERVED") {
      throw new StorageQuotaError("STORAGE_RESERVATION_RELEASED");
    }
    const account = await transaction.tenantStorageAccount.update({
      data: {
        reservedBytes: { decrement: reservation.byteSize },
        usedBytes: { increment: reservation.byteSize },
      },
      where: { tenantId },
    });
    await transaction.storageReservation.update({
      data: { committedAt: new Date(), status: "COMMITTED" },
      where: { id: reservation.id },
    });
    await transaction.storageUsageLedger.create({
      data: {
        byteSize: reservation.byteSize,
        id: randomUUID(),
        reason: reason.slice(0, 500),
        reservationId: reservation.id,
        reservedBytesAfter: account.reservedBytes,
        tenantId,
        type: "COMMIT",
        usedBytesAfter: account.usedBytes,
      },
    });
  }

  async release(reservationId: string, tenantId: string, reason: string): Promise<void> {
    await this.serializable(async (transaction) => {
      await lockAccount(transaction, tenantId);
      const reservation = await transaction.storageReservation.findFirst({
        where: { id: reservationId, tenantId },
      });
      if (!reservation || reservation.status === "RELEASED") return;
      if (reservation.status === "COMMITTED") {
        throw new StorageQuotaError("STORAGE_RESERVATION_ALREADY_COMMITTED");
      }
      const account = await transaction.tenantStorageAccount.update({
        data: { reservedBytes: { decrement: reservation.byteSize } },
        where: { tenantId },
      });
      await transaction.storageReservation.update({
        data: { releasedAt: new Date(), status: "RELEASED" },
        where: { id: reservation.id },
      });
      await transaction.storageUsageLedger.create({
        data: {
          byteSize: reservation.byteSize,
          id: randomUUID(),
          reason: reason.slice(0, 500),
          reservationId: reservation.id,
          reservedBytesAfter: account.reservedBytes,
          tenantId,
          type: "RELEASE",
          usedBytesAfter: account.usedBytes,
        },
      });
    });
  }

  async releaseExpired(tenantId?: string): Promise<number> {
    const rows = await this.prisma.storageReservation.findMany({
      orderBy: { expiresAt: "asc" },
      take: 200,
      where: { expiresAt: { lte: new Date() }, status: "RESERVED", tenantId },
    });
    let count = 0;
    for (const row of rows) {
      try {
        if (row.storageKey) await this.storage.delete(row.storageKey);
        await this.release(
          row.id,
          row.tenantId,
          "Release expired storage reservation after partial object cleanup",
        );
        count += 1;
      } catch {
        // Never release capacity unless cleanup and ledger mutation both succeed.
      }
    }
    return count;
  }

  private async serializable<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (attempt < 2 && isPrismaSerializationConflict(error)) {
          await new Promise<void>((resolve) => setTimeout(resolve, (attempt + 1) * 25));
          continue;
        }
        throw error;
      }
    }
    throw new StorageQuotaError("STORAGE_TRANSACTION_RETRY_EXHAUSTED");
  }
}

export class StorageQuotaError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StorageQuotaError";
  }
}

async function lockAccount(
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
  if (!account) throw new StorageQuotaError("STORAGE_ACCOUNT_LOCK_FAILED");
  return account;
}
