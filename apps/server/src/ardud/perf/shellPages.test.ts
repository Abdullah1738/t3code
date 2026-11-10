import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

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

it("uses a walk cursor no thread id can equal", () => {
  // Any non-blank string is a valid thread id, so only a blank cursor is safe: a thread
  // named like the cursor at a page boundary would restart the walk for ever.
  expect(SHELL_WALK_START_CURSOR.trim()).toBe("");
  expect(SHELL_WALK_START_CURSOR).not.toBe("");
  expect(Schema.is(ThreadId)(SHELL_WALK_START_CURSOR)).toBe(false);
  expect(Schema.decodeUnknownOption(ThreadId)(SHELL_WALK_START_CURSOR)._tag).toBe("None");
  // The cursor's earlier spelling was a legal thread id; it pages like any other now.
  for (const recentFirst of [true, false]) {
    expect(shellPageRead("!recent-first", recentFirst)).toEqual({
      afterThreadId: "!recent-first",
    });
  }
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

it("finishes a load whose page ends at a thread named like the old cursor", () => {
  // 499 ids before it, "!recent-first" as row 500, one id after: with the old cursor the
  // second request restarted page one for ever, with the switch on or off.
  const list = [
    ...Array.from({ length: SHELL_PAGE_SIZE - 1 }, (_, index) => ({
      id: `!a-${String(index).padStart(4, "0")}`,
    })),
    { id: "!recent-first" },
    { id: "thread-last" },
  ];
  expect(list.map((row) => row.id)).toEqual(list.map((row) => row.id).toSorted());
  const recent = list.toReversed();
  for (const recentFirst of [true, false]) {
    const delivered = new Set<string>();
    let after: string | undefined;
    let requests = 0;
    for (;;) {
      expect(++requests).toBeLessThanOrEqual(4);
      const read = shellPageRead(after, recentFirst);
      const read1 = (read.recentFirst === true ? recent : list)
        .filter((row) => read.afterThreadId === undefined || row.id > read.afterThreadId)
        .slice(0, shellPageSize(read) + 1);
      for (const row of read1.slice(0, shellPageSize(read))) delivered.add(row.id);
      const next = shellPageNextAfter(read, read1);
      if (next === null) break;
      after = next;
    }
    expect(requests).toBe(recentFirst ? 3 : 2);
    expect(delivered.size).toBe(list.length);
  }
});
