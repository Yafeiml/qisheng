import { BadRequestException } from "@nestjs/common";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export class CursorPaginationQueryDto {
  @ApiPropertyOptional({
    description: "上一页返回的不透明游标；不要解析或自行构造。",
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({
    default: DEFAULT_PAGE_SIZE,
    maximum: MAX_PAGE_SIZE,
    minimum: 1,
    type: Number,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit = DEFAULT_PAGE_SIZE;
}

export type CursorPage<T> = Readonly<{
  items: readonly T[];
  pageInfo: Readonly<{
    hasNextPage: boolean;
    nextCursor: string | null;
  }>;
}>;

export type CursorDirection = "asc" | "desc";
export type CreatedAtRow = Readonly<{ createdAt: Date; id: string }>;
export type TimestampedRow = Readonly<{ id: string }>;

export function createdAtCursorWhere(
  query: CursorPaginationQueryDto,
  direction: CursorDirection = "desc",
) {
  return timestampCursorWhere(query, "createdAt", direction);
}

export function timestampCursorWhere(
  query: CursorPaginationQueryDto,
  field: string,
  direction: CursorDirection = "desc",
) {
  if (!query.cursor) return {};
  const cursor = decodeCursor(query.cursor);
  const comparison = direction === "desc" ? "lt" : "gt";
  return {
    OR: [
      { [field]: { [comparison]: cursor.timestamp } },
      { [field]: cursor.timestamp, id: { [comparison]: cursor.id } },
    ],
  };
}

export function createdAtOrderBy(
  direction: CursorDirection = "desc",
): [{ createdAt: CursorDirection }, { id: CursorDirection }] {
  return [{ createdAt: direction }, { id: direction }];
}

export function pageTake(query: CursorPaginationQueryDto): number {
  return query.limit + 1;
}

export function toCursorPage<T extends CreatedAtRow>(
  rows: readonly T[],
  query: CursorPaginationQueryDto,
): CursorPage<T> {
  return toCursorPageBy(rows, query, ({ createdAt }) => createdAt);
}

export function toCursorPageBy<T extends TimestampedRow>(
  rows: readonly T[],
  query: CursorPaginationQueryDto,
  timestampOf: (row: T) => Date,
): CursorPage<T> {
  const hasNextPage = rows.length > query.limit;
  const items = hasNextPage ? rows.slice(0, query.limit) : [...rows];
  const last = items.at(-1);
  return {
    items,
    pageInfo: {
      hasNextPage,
      nextCursor: hasNextPage && last ? encodeCursor(last.id, timestampOf(last)) : null,
    },
  };
}

function encodeCursor(id: string, timestamp: Date): string {
  return Buffer.from(
    JSON.stringify({ id, timestamp: timestamp.toISOString(), version: 1 }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(value: string): Readonly<{ id: string; timestamp: Date }> {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const timestamp = new Date(typeof decoded.timestamp === "string" ? decoded.timestamp : "");
    if (
      decoded.version !== 1 ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0 ||
      decoded.id.length > 200 ||
      Number.isNaN(timestamp.getTime())
    ) {
      throw new Error("Cursor payload is invalid");
    }
    return { id: decoded.id, timestamp };
  } catch {
    throw new BadRequestException({
      code: "PAGINATION_CURSOR_INVALID",
      message: "Pagination cursor is invalid or expired",
    });
  }
}
