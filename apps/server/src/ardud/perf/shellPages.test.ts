import { expect, it } from "@effect/vitest";

import {
  SHELL_PAGE_SIZE,
  SHELL_RECENT_PAGE_SIZE,
  SHELL_WALK_START_CURSOR,
  shellPageNextAfter,
  shellPageRead,
  shellPageSize,
} from "./shellPages.ts";

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `thread-${String(index).padStart(4, "0")}` }));

it("reads the newest rows first only for a first page that asked for it", () => {
  expect(shellPageRead(undefined, true)).toEqual({ recentFirst: true });
  expect(shellPageRead(undefined, false)).toEqual({});
  expect(shellPageRead("thread-0499", true)).toEqual({ afterThreadId: "thread-0499" });
  expect(shellPageRead("thread-0499", false)).toEqual({ afterThreadId: "thread-0499" });
});

it("starts the id walk from the recent page's cursor, whatever the switch says", () => {
  expect(shellPageRead(SHELL_WALK_START_CURSOR, true)).toEqual({});
  expect(shellPageRead(SHELL_WALK_START_CURSOR, false)).toEqual({});
});

it("keeps the recent page small and the walk pages full size", () => {
  expect(shellPageSize({ recentFirst: true })).toBe(SHELL_RECENT_PAGE_SIZE);
  expect(shellPageSize({})).toBe(SHELL_PAGE_SIZE);
  expect(shellPageSize({ afterThreadId: "a" })).toBe(SHELL_PAGE_SIZE);
  expect(SHELL_RECENT_PAGE_SIZE).toBeLessThan(SHELL_PAGE_SIZE);
});

it("hands out the walk cursor after a full recent page and thread ids during the walk", () => {
  expect(shellPageNextAfter({ recentFirst: true }, rows(SHELL_RECENT_PAGE_SIZE + 1))).toBe(
    SHELL_WALK_START_CURSOR,
  );
  const full = rows(SHELL_PAGE_SIZE + 1);
  expect(shellPageNextAfter({}, full)).toBe("thread-0499");
  expect(shellPageNextAfter({ afterThreadId: "a" }, full)).toBe("thread-0499");
});

it("ends the load when a page holds every remaining row", () => {
  // A list that fits the recent page is complete after it: no second read.
  expect(shellPageNextAfter({ recentFirst: true }, rows(SHELL_RECENT_PAGE_SIZE))).toBeNull();
  expect(shellPageNextAfter({ recentFirst: true }, rows(3))).toBeNull();
  expect(shellPageNextAfter({}, rows(SHELL_PAGE_SIZE))).toBeNull();
  expect(shellPageNextAfter({ afterThreadId: "a" }, [])).toBeNull();
});
