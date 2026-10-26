import type {
  KanbanBoardSummary,
  KanbanDiscussion,
  KanbanMessage,
  KanbanScriptRun,
  KanbanWatchEvent,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createKanbanClient } from "./client.ts";
import { KanbanOfflineError, type KanbanTransport } from "./transport.ts";

interface Pending {
  readonly tag: string;
  readonly input: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** A transport whose requests wait until the test answers them. */
function fakeTransport() {
  const pending: Pending[] = [];
  let push: ((event: KanbanWatchEvent) => void) | null = null;
  let fail: ((error: unknown) => void) | null = null;
  let streams = 0;
  const lists: Array<(list: ReadonlyArray<KanbanBoardSummary>) => void> = [];
  const listFailures: Array<(error: unknown) => void> = [];
  const transport: KanbanTransport = {
    stream(tag, _input, onValue, onError) {
      streams += 1;
      if (tag === "kanban.boards") {
        lists.push(onValue as never);
        listFailures.push(onError ?? (() => {}));
        return () => {};
      }
      push = onValue as (event: KanbanWatchEvent) => void;
      fail = onError ?? null;
      return () => {
        push = null;
      };
    },
    request(tag, input) {
      return new Promise((resolve, reject) => {
        pending.push({ tag, input, resolve, reject } as Pending);
      }) as never;
    },
  };
  const take = (tag: string) => {
    const index = pending.findIndex((entry) => entry.tag === tag);
    if (index < 0) throw new Error(`no pending ${tag}`);
    return pending.splice(index, 1)[0]!;
  };
  return {
    transport,
    pending,
    take,
    push: (event: KanbanWatchEvent) => push?.(event),
    fail: (error: unknown) => fail?.(error),
    streams: () => streams,
    pushList: (list: ReadonlyArray<KanbanBoardSummary>) => lists.at(-1)?.(list),
    failList: (error: unknown) => listFailures.at(-1)?.(error),
  };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await flush();
};

function discussion(lastSeq: number, ownerRead: number): KanbanDiscussion {
  return {
    id: "disc-1",
    boardId: "board-toy",
    cardId: null,
    title: "Window",
    evaluatorThreadId: null,
    participants: [
      {
        actor: { _tag: "owner" },
        name: "You",
        lastReadSeq: ownerRead,
        typingUntil: null,
        owes: null,
      },
    ],
    lastSeq,
    lastMessageAt: "2026-10-25T11:00:00.000Z",
    createdBy: { _tag: "owner" },
    createdAt: "2026-10-25T09:00:00.000Z",
    archivedAt: null,
  } as never;
}

function message(seq: number, answers: KanbanMessage["answers"] = []): KanbanMessage {
  return {
    discussionId: "disc-1",
    seq,
    author: { _tag: "evaluator", threadId: "t-1" },
    authorName: "Evaluator",
    blocks: [{ _tag: "md", text: `m${seq}` }],
    answers,
    createdAt: "2026-10-25T11:00:00.000Z",
  } as never;
}

const snapshotEvent = (unread: number): KanbanWatchEvent =>
  ({
    _tag: "snapshot",
    snapshot: {
      board: { id: "board-toy", name: "Toy" },
      cards: [],
      goals: [],
      pools: [],
      groups: [],
      threads: [],
      unread: [{ discussionId: "disc-1", count: unread }],
    },
  }) as never;

function scriptRun(id: number, endedAt: string | null = null): KanbanScriptRun {
  return {
    id,
    scriptId: "script-1",
    startedAt: "2026-10-26T10:00:00.000Z",
    endedAt,
    exitCode: endedAt === null ? null : 0,
    output: "",
    trigger: "manual",
  } as never;
}

const vote = {
  blockId: "b1",
  by: { _tag: "owner" },
  choice: ["a"],
  at: "2026-10-25T11:05:00.000Z",
} as never;

describe("createKanbanClient", () => {
  it("keeps a read the server has not applied yet when the list comes back stale", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const store = client.board("board-toy");
    const stop = store.subscribe(() => {});
    fake.push(snapshotEvent(3));
    fake.take("kanban.discussions").resolve([discussion(3, 0)]);
    await settle();
    expect(store.get()?.unread.get("disc-1")).toBe(3);

    client.markRead("board-toy", "disc-1", 3);
    expect(store.get()?.unread.get("disc-1")).toBe(0);
    // A reconnect replays a snapshot and a list read before the server
    // applied the read: the badge stays cleared.
    fake.push(snapshotEvent(3));
    expect(store.get()?.unread.get("disc-1")).toBe(0);
    fake.take("kanban.discussions").resolve([discussion(3, 0)]);
    await settle();
    expect(store.get()?.unread.get("disc-1")).toBe(0);
    // Once the server echoes the read, a later message counts again.
    fake.push({
      _tag: "change",
      change: { _tag: "discussion", discussion: discussion(3, 3) },
    } as never);
    fake.push({
      _tag: "change",
      change: { _tag: "discussion", discussion: discussion(4, 3) },
    } as never);
    expect(store.get()?.unread.get("disc-1")).toBe(1);
    stop();
  });

  it("sends a lost read again with the next snapshot", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const store = client.board("board-toy");
    const stop = store.subscribe(() => {});
    fake.push(snapshotEvent(3));
    fake.take("kanban.discussions").resolve([discussion(3, 0)]);
    await settle();

    client.markRead("board-toy", "disc-1", 3);
    fake.take("kanban.discussion.read").reject(new Error("socket closed"));
    await settle();
    fake.push(snapshotEvent(3));
    expect(fake.take("kanban.discussion.read").input).toEqual({ discussionId: "disc-1", seq: 3 });
    stop();
  });

  it("stops sending a read once the server has applied it", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const store = client.board("board-toy");
    const stop = store.subscribe(() => {});
    fake.push(snapshotEvent(3));
    fake.take("kanban.discussions").resolve([discussion(3, 0)]);
    await settle();

    client.markRead("board-toy", "disc-1", 3);
    fake.take("kanban.discussion.read").resolve({});
    fake.push({
      _tag: "change",
      change: { _tag: "discussion", discussion: discussion(3, 3) },
    } as never);
    fake.push(snapshotEvent(0));
    await settle();
    expect(fake.pending.some((entry) => entry.tag === "kanban.discussion.read")).toBe(false);
    stop();
  });

  it("never leaves a gap when a reconnect read is a page past what was held", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const board = client.board("board-toy");
    const stopBoard = board.subscribe(() => {});
    fake.push(snapshotEvent(0));
    const store = client.messages("board-toy", "disc-1");
    const stop = store.subscribe(() => {});
    fake.take("kanban.messages").resolve([message(1), message(2)]);
    await settle();

    fake.push(snapshotEvent(0));
    await settle();
    const read = fake.take("kanban.messages");
    // Lands while the read is out; it must not count as held.
    fake.push({ _tag: "change", change: { _tag: "message", message: message(401) } } as never);
    read.resolve(Array.from({ length: 200 }, (_, index) => message(201 + index)));
    await settle();
    const seqs = store.get()?.map((entry) => entry.seq) ?? [];
    expect(seqs[0]).toBe(201);
    expect(seqs.at(-1)).toBe(401);
    expect(seqs).toHaveLength(201);
    stop();
    stopBoard();
  });

  it("keeps a live answer that lands while a message read is out", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const board = client.board("board-toy");
    const stopBoard = board.subscribe(() => {});
    fake.push(snapshotEvent(0));
    const store = client.messages("board-toy", "disc-1");
    const stop = store.subscribe(() => {});
    const read = fake.take("kanban.messages");
    fake.push({
      _tag: "change",
      change: { _tag: "message", message: message(1, [vote]) },
    } as never);
    read.resolve([message(1)]);
    await settle();
    expect(store.get()?.[0]?.answers).toHaveLength(1);
    stop();
    stopBoard();
  });

  it("puts a run that opens while the runs are read on top, and ends it in place", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const board = client.board("board-toy");
    const stopBoard = board.subscribe(() => {});
    fake.push(snapshotEvent(0));
    const store = client.scriptRuns("board-toy", "script-1");
    const stop = store.subscribe(() => {});
    const read = fake.take("kanban.script.runs");
    expect(read.input).toEqual({ scriptId: "script-1", limit: 20 });
    fake.push({ _tag: "change", change: { _tag: "scriptRun", run: scriptRun(3) } } as never);
    read.resolve([
      scriptRun(2, "2026-10-26T09:00:05.000Z"),
      scriptRun(1, "2026-10-26T08:00:05.000Z"),
    ]);
    await settle();
    expect(store.get()?.map((run) => run.id)).toEqual([3, 2, 1]);

    fake.push({
      _tag: "change",
      change: { _tag: "scriptRun", run: scriptRun(3, "2026-10-26T10:00:04.000Z") },
    } as never);
    expect(store.get()?.map((run) => run.id)).toEqual([3, 2, 1]);
    expect(store.get()?.[0]?.endedAt).toBe("2026-10-26T10:00:04.000Z");

    // Another script's run stays out; a reconnect reads the list again.
    fake.push({
      _tag: "change",
      change: { _tag: "scriptRun", run: { ...scriptRun(9), scriptId: "script-2" } },
    } as never);
    expect(store.get()).toHaveLength(3);
    fake.push(snapshotEvent(0));
    await settle();
    fake.take("kanban.script.runs").resolve([scriptRun(3, "2026-10-26T10:00:04.000Z")]);
    await settle();
    expect(store.get()?.map((run) => run.id)).toEqual([3]);
    stop();
    stopBoard();
  });

  it("keeps a run the read has ended over the open copy that came in meanwhile", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const stopBoard = client.board("board-toy").subscribe(() => {});
    fake.push(snapshotEvent(0));
    const store = client.scriptRuns("board-toy", "script-1");
    const stop = store.subscribe(() => {});
    const read = fake.take("kanban.script.runs");
    fake.push({ _tag: "change", change: { _tag: "scriptRun", run: scriptRun(3) } } as never);
    read.resolve([scriptRun(3, "2026-10-26T10:00:04.000Z")]);
    await settle();
    expect(store.get()?.[0]?.endedAt).toBe("2026-10-26T10:00:04.000Z");
    stop();
    stopBoard();
  });

  it("keeps the board list from its stream and opens it again after a server error", () => {
    vi.useFakeTimers();
    try {
      const fake = fakeTransport();
      const client = createKanbanClient(fake.transport);
      const stop = client.boards.subscribe(() => {});
      const list = [{ board: { id: "board-toy" }, needsOwner: 1, running: 0, unread: 2 }] as never;
      fake.pushList(list);
      expect(client.boards.get()).toBe(list);

      fake.failList(new Error("denied"));
      expect(client.boards.failure()).toBeUndefined();
      expect(fake.streams()).toBe(1);
      vi.advanceTimersByTime(5_000);
      expect(fake.streams()).toBe(2);
      // The list stays until the new stream answers.
      expect(client.boards.get()).toBe(list);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits out a missing connection instead of failing a chat", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const board = client.board("board-toy");
    const stopBoard = board.subscribe(() => {});
    fake.push(snapshotEvent(0));
    const store = client.messages("board-toy", "disc-1");
    const stop = store.subscribe(() => {});
    fake.take("kanban.messages").reject(new KanbanOfflineError());
    await settle();
    expect(store.failure()).toBeUndefined();
    // The next snapshot (a reconnect) skips the retry pause.
    fake.push(snapshotEvent(0));
    await settle();
    fake.take("kanban.messages").resolve([message(1)]);
    await settle();
    expect(store.get()).toHaveLength(1);
    stop();
    stopBoard();
  });

  it("keeps an open chat when the board feed fails, and rejoins on the next feed", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const board = client.board("board-toy");
    const stopBoard = board.subscribe(() => {});
    fake.push(snapshotEvent(0));
    fake.take("kanban.discussions").resolve([discussion(1, 1)]);
    const store = client.messages("board-toy", "disc-1");
    const stop = store.subscribe(() => {});
    fake.take("kanban.messages").resolve([message(1)]);
    await settle();

    fake.fail(new Error("stream broke"));
    await settle();
    expect(board.failure()).toBeDefined();
    expect(store.failure()).toBeUndefined();
    expect(store.get()).toHaveLength(1);

    // Retrying the board opens a new feed; the chat joins it and catches up.
    board.retry();
    expect(fake.streams()).toBe(2);
    await settle();
    fake.push(snapshotEvent(0));
    await settle();
    fake.take("kanban.messages").resolve([message(1), message(2)]);
    await settle();
    expect(store.get()).toHaveLength(2);
    stop();
    stopBoard();
  });
});
