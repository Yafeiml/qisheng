import { describe, expect, it } from "vitest";
import { CursorPaginationQueryDto, createdAtCursorWhere, toCursorPage } from "./cursor-pagination";

describe("cursor pagination contract", () => {
  it("emits a deterministic next cursor and excludes the boundary in descending queries", () => {
    const query = new CursorPaginationQueryDto();
    query.limit = 2;
    const createdAt = new Date("2026-08-28T12:00:00.000Z");
    const page = toCursorPage(
      [
        { createdAt, id: "c" },
        { createdAt, id: "b" },
        { createdAt, id: "a" },
      ],
      query,
    );

    expect(page.items.map(({ id }) => id)).toEqual(["c", "b"]);
    expect(page.pageInfo.hasNextPage).toBe(true);
    const next = new CursorPaginationQueryDto();
    next.cursor = page.pageInfo.nextCursor ?? undefined;
    expect(createdAtCursorWhere(next)).toEqual({
      OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: "b" } }],
    });
  });

  it("rejects malformed cursors with a stable API error code", () => {
    const query = new CursorPaginationQueryDto();
    query.cursor = "not-a-valid-cursor";
    expect(() => createdAtCursorWhere(query)).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({ code: "PAGINATION_CURSOR_INVALID" }),
      }),
    );
  });
});
