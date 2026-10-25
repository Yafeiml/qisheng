import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@xhs-agentic/database";
import { RequestAccessContext } from "../access/request-access-context";
import { PrismaService } from "../database/prisma.service";

const LOCK_DURATION_MS = 5 * 60 * 1000;
const RETENTION_DURATION_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/u;

export type IdempotencyRequest = Readonly<{
  body: unknown;
  key: string;
  method: string;
  params: Readonly<Record<string, unknown>>;
  path: string;
  query: Readonly<Record<string, unknown>>;
}>;

export type IdempotencyClaim =
  | Readonly<{ kind: "OWNED"; lockToken: string; recordId: string }>
  | Readonly<{ body: unknown; kind: "REPLAY"; statusCode: number }>;

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequestAccessContext) private readonly accessContext: RequestAccessContext,
  ) {}

  async claim(input: IdempotencyRequest): Promise<IdempotencyClaim> {
    const key = validatedKey(input.key);
    const principal = this.accessContext.requirePrincipal();
    const identity = {
      audience: principal.audience,
      userId: principal.userId,
    } as const;
    const method = input.method.toUpperCase();
    const requestHash = hashRequest({ ...input, key, method });
    const now = new Date();
    const lockToken = randomUUID();

    try {
      const record = await this.prisma.idempotencyRecord.create({
        data: {
          ...identity,
          expiresAt: after(now, RETENTION_DURATION_MS),
          key,
          lockedUntil: after(now, LOCK_DURATION_MS),
          lockToken,
          method,
          requestHash,
          requestPath: input.path,
        },
        select: { id: true },
      });
      return { kind: "OWNED", lockToken, recordId: record.id };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
    }

    return this.resolveExisting({
      ...identity,
      key,
      lockToken,
      method,
      now,
      path: input.path,
      requestHash,
    });
  }

  async complete(
    claim: Extract<IdempotencyClaim, { kind: "OWNED" }>,
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    const now = new Date();
    const updated = await this.prisma.idempotencyRecord.updateMany({
      data: {
        completedAt: now,
        expiresAt: after(now, RETENTION_DURATION_MS),
        lockedUntil: now,
        responseBody: jsonValue(body),
        responseStatusCode: statusCode,
        status: "COMPLETED",
      },
      where: {
        id: claim.recordId,
        lockToken: claim.lockToken,
        status: "PROCESSING",
      },
    });
    if (updated.count !== 1) {
      throw new Error("Idempotency ownership was lost before the response could be persisted");
    }
  }

  async release(claim: Extract<IdempotencyClaim, { kind: "OWNED" }>): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({
      where: {
        id: claim.recordId,
        lockToken: claim.lockToken,
        status: "PROCESSING",
      },
    });
  }

  private async resolveExisting(
    input: Readonly<{
      audience: "SAAS_ADMIN" | "EMPLOYEE";
      key: string;
      lockToken: string;
      method: string;
      now: Date;
      path: string;
      requestHash: string;
      userId: string;
    }>,
  ): Promise<IdempotencyClaim> {
    const existing = await this.prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        userId_audience_key: {
          audience: input.audience,
          key: input.key,
          userId: input.userId,
        },
      },
    });

    if (existing.expiresAt <= input.now) {
      const reset = await this.prisma.idempotencyRecord.updateMany({
        data: {
          completedAt: null,
          expiresAt: after(input.now, RETENTION_DURATION_MS),
          lockedUntil: after(input.now, LOCK_DURATION_MS),
          lockToken: input.lockToken,
          method: input.method,
          requestHash: input.requestHash,
          requestPath: input.path,
          responseBody: Prisma.DbNull,
          responseStatusCode: null,
          status: "PROCESSING",
        },
        where: { expiresAt: { lte: input.now }, id: existing.id },
      });
      if (reset.count === 1) {
        return { kind: "OWNED", lockToken: input.lockToken, recordId: existing.id };
      }
      return this.resolveExisting(input);
    }

    if (
      existing.method !== input.method ||
      existing.requestPath !== input.path ||
      existing.requestHash !== input.requestHash
    ) {
      throw idempotencyConflict(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key has already been used for a different request",
      );
    }

    if (existing.status === "COMPLETED") {
      if (existing.responseStatusCode === null) {
        throw new Error("Completed idempotency record has no response status");
      }
      return {
        body: existing.responseBody,
        kind: "REPLAY",
        statusCode: existing.responseStatusCode,
      };
    }

    if (existing.lockedUntil > input.now) {
      throw idempotencyConflict(
        "IDEMPOTENCY_IN_PROGRESS",
        "An identical request with this idempotency key is still processing",
      );
    }

    const claimed = await this.prisma.idempotencyRecord.updateMany({
      data: {
        lockedUntil: after(input.now, LOCK_DURATION_MS),
        lockToken: input.lockToken,
      },
      where: {
        id: existing.id,
        lockedUntil: { lte: input.now },
        requestHash: input.requestHash,
        status: "PROCESSING",
      },
    });
    if (claimed.count === 1) {
      return { kind: "OWNED", lockToken: input.lockToken, recordId: existing.id };
    }
    throw idempotencyConflict(
      "IDEMPOTENCY_IN_PROGRESS",
      "An identical request with this idempotency key is still processing",
    );
  }
}

function validatedKey(value: string): string {
  if (!value) {
    throw new BadRequestException({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "Idempotency-Key header is required for this operation",
    });
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new BadRequestException({
      code: "IDEMPOTENCY_KEY_INVALID",
      details: { maxLength: 200, minLength: 8 },
      message: "Idempotency-Key header has an invalid format",
    });
  }
  return value;
}

function hashRequest(input: IdempotencyRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalValue({
          body: input.body ?? null,
          method: input.method,
          params: input.params,
          path: input.path,
          query: input.query,
        }),
      ),
    )
    .digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function after(now: Date, durationMs: number): Date {
  return new Date(now.getTime() + durationMs);
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function idempotencyConflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}
