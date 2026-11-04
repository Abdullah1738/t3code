import type {
  KanbanBoardListEntry,
  KanbanDiscussion,
  KanbanMessage,
  KanbanScriptRun,
  KanbanWatchEvent,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createKanbanClient } from "./client.ts";
import { KanbanOfflineError, type KanbanRequestTag, type KanbanTransport } from "./transport.ts";

interface Pending {
  readonly tag: string;
  readonly input: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/** A transport whose requests wait until the test answers them. */
function fakeTransport(denied: ReadonlySet<string> = new Set()) {
  const pending: Pending[] = [];
  let push: ((event: KanbanWatchEvent) => void) | null = null;
  let fail: ((error: unknown) => void) | null = null;
  let streams = 0;
  const lists: Array<(list: ReadonlyArray<KanbanBoardListEntry>) => void> = [];
  const listFailures: Array<(error: unknown) => void> = [];
  const transport: KanbanTransport = {
    permission: (tag) => Atom.make(() => !denied.has(tag)),
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
    pushList: (list: ReadonlyArray<KanbanBoardListEntry>) => lists.at(-1)?.(list),
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
    titleEditedAt: null,
    settledAt: null,
    snoozedUntil: null,
    pinnedAt: null,
    reopenedAt: null,
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
  it("lifts the requested board pause", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const lifted = client.liftPause("board-toy");
    const request = fake.take("kanban.board.pause");
    expect(request.input).toEqual({ boardId: "board-toy", clear: true });
    request.resolve({});
    await lifted;
  });

  it("reports a denied grant as false, so its control is disabled", () => {
    const fake = fakeTransport(new Set(["kanban.pool.set"]));
    const client = createKanbanClient(fake.transport);
    const registry = AtomRegistry.make();
    const read = (tag: KanbanRequestTag) => registry.get(client.permission(tag));
    expect(read("kanban.pool.set")).toBe(false);
    expect(read("kanban.board.update")).toBe(true);
  });

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

  it("leaves a settle's result to the board feed, so a late reply can't undo a newer change", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const store = client.board("board-toy");
    const stop = store.subscribe(() => {});
    fake.push(snapshotEvent(0));
    fake.take("kanban.discussions").resolve([discussion(3, 3)]);
    await settle();

    const settled = client.updateDiscussion("board-toy", "disc-1", { settled: true });
    const request = fake.take("kanban.discussion.update");
    expect(request.input).toEqual({ discussionId: "disc-1", settled: true });
    const settledEntry = { ...discussion(3, 3), settledAt: "2026-10-25T12:00:00.000Z" };
    fake.push({
      _tag: "change",
      change: { _tag: "discussion", discussion: settledEntry },
    } as never);
    // Another device renames it (lastSeq doesn't move) before this reply lands.
    fake.push({
      _tag: "change",
      change: { _tag: "discussion", discussion: { ...settledEntry, title: "Renamed" } },
    } as never);
    request.resolve(settledEntry);
    await settled;
    expect(store.get()?.discussions.get("disc-1")).toMatchObject({
      settledAt: "2026-10-25T12:00:00.000Z",
      title: "Renamed",
    });
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
      fake.pushList([
        {
          boardId: "board-toy",
          board: { id: "board-toy" },
          needsOwner: 1,
          running: 0,
          unread: 2,
          threadIds: [],
        },
      ] as never);
      const list = client.boards.get();
      expect(list?.map((summary) => [summary.board.id, summary.needsOwner])).toEqual([
        ["board-toy", 1],
      ]);

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

  it("sends his own words with an answer, and leaves the key out without them", async () => {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport);
    const sent = client.answer("board-toy", "disc-1", 4, "q1", [], "Wait");
    const withWords = fake.take("kanban.answer");
    expect(withWords.input).toEqual({ discussionId: "disc-1", seq: 4, blockId: "q1", choice: [], text: "Wait" });
    withWords.resolve(message(4));
    await sent;

    const plain = client.answer("board-toy", "disc-1", 4, "q1", ["o1"]);
    const bare = fake.take("kanban.answer");
    expect(bare.input).not.toHaveProperty("text");
    bare.resolve(message(4));
    await plain;
  });
});

describe("discussion preview loader", () => {
  // The grace the feed keeps after its last reader leaves (the store keepalive).
  const KEEP_ALIVE = { keepAliveMs: 120_000 };
  const previewDiscussion = (
    id: string,
    lastSeq: number,
    boardId = "board-toy",
  ): KanbanDiscussion => ({ ...discussion(lastSeq, 0), id, boardId, lastSeq }) as never;
  const previewMessage = (discussionId: string, seq: number): KanbanMessage =>
    ({ ...message(seq), discussionId }) as never;
  const previewChange = (id: string, lastSeq: number): KanbanWatchEvent =>
    ({
      _tag: "change",
      change: { _tag: "discussion", discussion: previewDiscussion(id, lastSeq) },
    }) as never;
  const messageReads = (fake: ReturnType<typeof fakeTransport>, discussionId?: string) =>
    fake.pending.filter(
      (entry) =>
        entry.tag === "kanban.messages" &&
        (discussionId === undefined ||
          (entry.input as { discussionId: string }).discussionId === discussionId),
    );

  /** Opens a board with `count` seq=1 discussions and watches its previews. */
  async function openWithDiscussions(count: number) {
    const fake = fakeTransport();
    const client = createKanbanClient(fake.transport, KEEP_ALIVE);
    const board = client.board("board-toy");
    const stopBoard = board.subscribe(() => {});
    const stopPreviews = client.watchPreviews("board-toy");
    fake.push(snapshotEvent(0));
    fake
      .take("kanban.discussions")
      .resolve(Array.from({ length: count }, (_, i) => previewDiscussion(`disc-${i}`, 1)));
    await settle();
    return { fake, client, board, stopBoard, stopPreviews };
  }

  it("preview loader bounds in-flight reads at 40 while eventually loading every preview", async () => {
    const { fake, board, stopBoard, stopPreviews } = await openWithDiscussions(100);
    expect(messageReads(fake)).toHaveLength(40);

    let answered = 0;
    while (messageReads(fake).length > 0) {
      expect(messageReads(fake).length).toBeLessThanOrEqual(40);
      const next = messageReads(fake)[0]!;
      const input = next.input as { discussionId: string; afterSeq: number };
      fake.pending.splice(fake.pending.indexOf(next), 1);
      next.resolve([previewMessage(input.discussionId, input.afterSeq + 1)]);
      answered += 1;
      await settle();
    }
    expect(answered).toBe(100);
    expect(board.get()?.lastMessages.size).toBe(100);
    stopPreviews();
    stopBoard();
  });

  it("stops watching previews and keeps the ones already received", async () => {
    const { fake, board, stopBoard, stopPreviews } = await openWithDiscussions(100);
    stopPreviews();
    for (const entry of fake.pending.splice(0)) {
      entry.resolve([previewMessage((entry.input as { discussionId: string }).discussionId, 1)]);
    }
    await settle();
    expect(fake.pending).toHaveLength(0);
    expect(board.get()?.lastMessages.size).toBe(40);
    stopBoard();
  });

  it("releases the slot on an empty response and does not refetch the same seq", async () => {
    const { fake, stopBoard, stopPreviews } = await openWithDiscussions(41);
    fake.take("kanban.messages").resolve([]);
    await settle();
    expect(messageReads(fake)).toHaveLength(40);
    expect(messageReads(fake, "disc-0")).toHaveLength(0);
    stopPreviews();
    stopBoard();
  });

  it("waits for the next state change before retrying a failed preview", async () => {
    const { fake, stopBoard, stopPreviews } = await openWithDiscussions(1);
    fake.take("kanban.messages").reject(new Error("offline"));
    await settle();
    expect(fake.pending).toHaveLength(0);
    fake.push(previewChange("disc-0", 1));
    await settle();
    expect(messageReads(fake, "disc-0")).toHaveLength(1);
    stopPreviews();
    stopBoard();
  });

  it("does not double-book a pending preview when its seq advances", async () => {
    const { fake, stopBoard, stopPreviews } = await openWithDiscussions(1);
    const first = fake.take("kanban.messages");
    fake.push(previewChange("disc-0", 2));
    await settle();
    expect(fake.pending).toHaveLength(0);
    first.resolve([previewMessage("disc-0", 1)]);
    await settle();
    const reads = messageReads(fake, "disc-0");
    expect(reads).toHaveLength(1);
    expect((reads[0]!.input as { afterSeq: number }).afterSeq).toBe(1);
    stopPreviews();
    stopBoard();
  });

  it("ignores a late reply from an obsolete feed", async () => {
    vi.useFakeTimers();
    try {
      const { fake, client, board, stopBoard, stopPreviews } = await openWithDiscussions(1);
      const stale = fake.take("kanban.messages");
      stopPreviews();
      stopBoard();
      vi.advanceTimersByTime(120_000);

      const stopBoardAgain = client.board("board-toy").subscribe(() => {});
      const stopPreviewsAgain = client.watchPreviews("board-toy");
      fake.push(snapshotEvent(0));
      fake.take("kanban.discussions").resolve([previewDiscussion("disc-0", 1)]);
      await settle();

      stale.resolve([previewMessage("disc-0", 100)]);
      await settle();
      expect(board.get()?.lastMessages.size ?? 0).toBe(0);

      fake.take("kanban.messages").resolve([previewMessage("disc-0", 1)]);
      await settle();
      expect(board.get()?.lastMessages.get("disc-0")?.seq).toBe(1);
      stopPreviewsAgain();
      stopBoardAgain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads previews after the keepalive expires and the board is reopened", async () => {
    vi.useFakeTimers();
    try {
      const { fake, client, board, stopBoard, stopPreviews } = await openWithDiscussions(1);
      fake.take("kanban.messages").resolve([previewMessage("disc-0", 1)]);
      await settle();
      stopPreviews();
      stopBoard();
      vi.advanceTimersByTime(120_000);

      const stopBoardAgain = client.board("board-toy").subscribe(() => {});
      const stopPreviewsAgain = client.watchPreviews("board-toy");
      fake.push(snapshotEvent(0));
      fake.take("kanban.discussions").resolve([previewDiscussion("disc-0", 1)]);
      await settle();
      expect(messageReads(fake, "disc-0")).toHaveLength(1);
      fake.take("kanban.messages").resolve([previewMessage("disc-0", 1)]);
      await settle();
      expect(board.get()?.lastMessages.size).toBe(1);
      stopPreviewsAgain();
      stopBoardAgain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopening before the keepalive expires shares the feed and keeps the preview", async () => {
    vi.useFakeTimers();
    try {
      const { fake, client, board, stopBoard, stopPreviews } = await openWithDiscussions(1);
      fake.take("kanban.messages").resolve([previewMessage("disc-0", 1)]);
      await settle();
      stopPreviews();
      stopBoard();
      vi.advanceTimersByTime(5_000);

      const stopBoardAgain = client.board("board-toy").subscribe(() => {});
      const stopPreviewsAgain = client.watchPreviews("board-toy");
      await settle();
      expect(fake.streams()).toBe(1);
      expect(fake.pending).toHaveLength(0);
      expect(board.get()?.lastMessages.size).toBe(1);
      stopPreviewsAgain();
      stopBoardAgain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reconnect on the same feed keeps a completed preview", async () => {
    const { fake, board, stopBoard, stopPreviews } = await openWithDiscussions(1);
    fake.take("kanban.messages").resolve([previewMessage("disc-0", 1)]);
    await settle();
    fake.push(snapshotEvent(0));
    fake.take("kanban.discussions").resolve([previewDiscussion("disc-0", 1)]);
    await settle();
    expect(fake.pending).toHaveLength(0);
    expect(board.get()?.lastMessages.size).toBe(1);
    stopPreviews();
    stopBoard();
  });

  it("bounds each board's previews at 40 independently", async () => {
    // One stream per board, so each feed gets its own snapshot.
    const streams = new Map<string, (event: KanbanWatchEvent) => void>();
    const pending: Pending[] = [];
    const transport: KanbanTransport = {
      permission: () => Atom.make(() => true),
      stream(tag, input, onValue) {
        if (tag === "kanban.boards") return () => {};
        const boardId = (input as { boardId: string }).boardId;
        streams.set(boardId, onValue as (event: KanbanWatchEvent) => void);
        return () => {
          streams.delete(boardId);
        };
      },
      request(tag, input) {
        return new Promise((resolve, reject) => {
          pending.push({ tag, input, resolve, reject } as Pending);
        }) as never;
      },
    };
    const client = createKanbanClient(transport, KEEP_ALIVE);
    const takeFor = (tag: string, boardId: string) => {
      const index = pending.findIndex(
        (entry) =>
          entry.tag === tag &&
          (entry.input as { discussionId?: string; boardId?: string }).boardId === boardId,
      );
      if (index < 0) throw new Error(`no pending ${tag} for ${boardId}`);
      return pending.splice(index, 1)[0]!;
    };
    const readsFor = (boardId: string) =>
      pending.filter(
        (entry) =>
          entry.tag === "kanban.messages" &&
          (entry.input as { discussionId: string }).discussionId.startsWith(`${boardId}-`),
      ).length;

    const stopA = client.board("board-a").subscribe(() => {});
    const previewsA = client.watchPreviews("board-a");
    const stopB = client.board("board-b").subscribe(() => {});
    const previewsB = client.watchPreviews("board-b");
    for (const boardId of ["board-a", "board-b"]) {
      streams.get(boardId)!({
        _tag: "snapshot",
        snapshot: {
          board: { id: boardId },
          cards: [],
          goals: [],
          pools: [],
          groups: [],
          threads: [],
          unread: [],
        },
      } as never);
    }
    for (const boardId of ["board-a", "board-b"]) {
      takeFor("kanban.discussions", boardId).resolve(
        Array.from({ length: 100 }, (_, i) => previewDiscussion(`${boardId}-${i}`, 1, boardId)),
      );
    }
    await settle();
    expect(readsFor("board-a")).toBe(40);
    expect(readsFor("board-b")).toBe(40);

    // Closing board-a's preview watcher leaves board-b's count alone.
    previewsA();
    expect(readsFor("board-b")).toBe(40);
    previewsB();
    stopA();
    stopB();
  });
});
