import { expect, it } from "@effect/vitest";

import {
  SHELL_PAGE_SIZE,
  SHELL_WALK_START_CURSOR,
  shellPageNextAfter,
  shellPageRead,
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

it("hands out the walk cursor after a full recent page and thread ids during the walk", () => {
  const full = rows(SHELL_PAGE_SIZE + 1);
  expect(shellPageNextAfter({ recentFirst: true }, full)).toBe(SHELL_WALK_START_CURSOR);
  expect(shellPageNextAfter({}, full)).toBe("thread-0499");
  expect(shellPageNextAfter({ afterThreadId: "a" }, full)).toBe("thread-0499");
});

it("ends the load when a page holds every remaining row", () => {
  // A list that fits one page is complete after the recent page: no second read.
  expect(shellPageNextAfter({ recentFirst: true }, rows(SHELL_PAGE_SIZE))).toBeNull();
  expect(shellPageNextAfter({ recentFirst: true }, rows(3))).toBeNull();
  expect(shellPageNextAfter({}, rows(SHELL_PAGE_SIZE))).toBeNull();
  expect(shellPageNextAfter({ afterThreadId: "a" }, [])).toBeNull();
});
