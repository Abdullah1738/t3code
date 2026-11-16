import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { COMPACT_READ_CHARS } from "../../compactRead.ts";
import { page } from "./mcpBoardReplies.ts";

const wide = (count: number, keyChars: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `${i}-${"s".repeat(keyChars)}`,
      "2026-11-15T00:00:00Z",
    ]),
  );

describe("oversized board metadata shapes", () => {
  const cases = [
    { name: "wide service map", metadata: { nextReleaseWindowByService: wide(400, 64) } },
    {
      name: "nested service map",
      metadata: {
        board: { id: "board", name: "Board", nextReleaseWindowByService: wide(400, 64) },
      },
    },
    {
      name: "long object keys require terminal fallback",
      metadata: { nextReleaseWindowByService: wide(2, 30_000) },
    },
    {
      name: "large instructions",
      metadata: { board: { id: "board", name: "Board", instructions: "i".repeat(100_000) } },
    },
    {
      name: "large inventories",
      metadata: { goals: Array.from({ length: 600 }, () => ({ text: "g".repeat(2_000) })) },
    },
  ];
  it.each(cases)("$name", ({ metadata }) => {
    for (const after of [0, 1]) {
      const reply = page(metadata, [{ number: 1 }, { number: 2 }, { number: 3 }], after, 1);
      expect(JSON.stringify(reply).length).toBeLessThanOrEqual(COMPACT_READ_CHARS);
      expect(reply.board.cards.map((row) => row.number)).toEqual([after + 1]);
      expect(reply.board.page).toEqual({ limit: 1, hasMore: true, nextAfter: after + 1 });
    }
  });
});

it.each(["cardIds", "threadIds", "optionIds", "ids", "blockedBy", "keep"])(
  "preserves %s references in a large group inventory",
  (field) => {
    const refs = Array.from(
      { length: 100 },
      (_, i) => `card-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const expected = new Set(refs);
    const groups = Array.from({ length: 16 }, (_, i) => ({ id: `group-${i}`, [field]: refs }));
    const reply = page({ groups }, [{ number: 1 }], 0, 500);
    expect(JSON.stringify(reply).length).toBeLessThanOrEqual(COMPACT_READ_CHARS);
    const kept = (reply.board as Record<string, unknown>).groups as Array<Record<string, string[]>>;
    expect(kept.length).toBeGreaterThan(0);
    for (const group of kept) {
      expect(group[field]!.length).toBeGreaterThan(0);
      expect(group[field]!.length).toBeLessThan(refs.length);
      expect(group[field]!.every((id) => expected.has(id))).toBe(true);
    }
  },
);

it("keeps structured identifiers, URLs and timestamps intact when metadata text is shortened", () => {
  const refs = Array.from(
    { length: 100 },
    (_, i) => `card-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  const groups = Array.from({ length: 32 }, (_, i) => ({ id: `group-${i}`, cardIds: refs }));
  const pools = [
    {
      key: "provider/model-name-with-a-long-routing-key#xhigh",
      model: { instanceId: "provider", model: "model-name-with-a-long-routing-key" },
    },
  ];
  const service = "service-with-a-long-name-that-must-still-match-the-release-ledger";
  const at = "2026-11-15T18:00:00.000Z";
  const url = "https://github.com/Abdullah1738/robob-mission-control/pull/12345";
  const reply = page(
    { groups, pools, service, url, nextReleaseWindowAt: at },
    [{ number: 1 }],
    0,
    500,
  );
  expect(JSON.stringify(reply).length).toBeLessThanOrEqual(COMPACT_READ_CHARS);
  expect(reply.board).toMatchObject({ pools, service, url, nextReleaseWindowAt: at });
});

it("bounds wide objects in a single row and keeps advancing", () => {
  for (const { count, keyChars } of [
    { count: 800, keyChars: 64 },
    { count: 400, keyChars: 512 },
    { count: 2, keyChars: 30_000 },
  ]) {
    const reply = page(
      {},
      [
        {
          id: "card-1",
          number: 1,
          payload: wide(count, keyChars),
          activeThreadId: "thread-".repeat(30),
          stage: "needs_owner",
          priority: 2,
          blockedBy: ["card-".repeat(20)],
          wait: {
            on: "card",
            card: "card-".repeat(20),
            pr: "https://example.com/".repeat(20),
            script: "script-".repeat(20),
          },
        },
        { id: "card-2", number: 2, payload: {} },
      ],
      0,
      1,
    );
    expect(JSON.stringify(reply).length).toBeLessThanOrEqual(COMPACT_READ_CHARS);
    expect(reply.board.cards[0]).toMatchObject({ id: "card-1", number: 1, truncated: true });
    expect(reply.board.cards[0]).toMatchObject({
      activeThreadId: "thread-".repeat(30),
      stage: "needs_owner",
      priority: 2,
      blockedBy: ["card-".repeat(20)],
      wait: {
        on: "card",
        card: "card-".repeat(20),
        pr: "https://example.com/".repeat(20),
        script: "script-".repeat(20),
      },
    });
    expect(reply.board.page.nextAfter).toBe(1);
  }
});

it("preserves each returned card's states while omitting static metadata on later pages", () => {
  const threads = Array.from({ length: 3 }, (_, i) => ({
    threadId: ThreadId.make(`thread-${i + 1}`),
    title: "Thread",
    running: i !== 2,
    needsInput: i === 2,
    lastActivityAt: null,
  }));
  const cards = threads.map((thread, i) => ({ number: i + 1, activeThreadId: thread.threadId }));
  for (const instructions of ["i".repeat(14_000), "i".repeat(100_000)]) {
    for (let after = 0; after < 3; after++) {
      const reply = page({ board: { id: "board", instructions } }, cards, after, 1, threads);
      expect(JSON.stringify(reply).length).toBeLessThanOrEqual(COMPACT_READ_CHARS);
      expect(reply.board).toMatchObject({ threads: [threads[after]] });
      expect(reply.board.cards).toEqual([cards[after]]);
    }
  }
});

it("counts live thread states against the same row budget", () => {
  const threads = Array.from({ length: 600 }, (_, i) => ({
    threadId: ThreadId.make(`thread-${i + 1}`),
    title: "t".repeat(4_000),
    running: true,
    needsInput: false,
    lastActivityAt: null,
  }));
  const cards = threads.map((thread, i) => ({ number: i + 1, activeThreadId: thread.threadId }));
  const seen: number[] = [];
  let after = 0;
  while (true) {
    const reply = page({}, cards, after, 500, threads);
    expect(JSON.stringify(reply).length).toBeLessThanOrEqual(COMPACT_READ_CHARS);
    const states = (reply.board as { threads: typeof threads }).threads;
    expect(states.map((thread) => thread.threadId)).toEqual(
      reply.board.cards.map((card) => card.activeThreadId),
    );
    expect(states.every((thread) => thread.title.length <= 513)).toBe(true);
    seen.push(...reply.board.cards.map((card) => card.number));
    if (!reply.board.page.hasMore) break;
    expect(reply.board.page.nextAfter!).toBeGreaterThan(after);
    after = reply.board.page.nextAfter!;
  }
  expect(seen).toEqual(Array.from({ length: 600 }, (_, i) => i + 1));
});
