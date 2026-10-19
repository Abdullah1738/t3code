import {
  MissionError,
  WS_METHODS,
  type MissionId,
  type MissionMessage,
  type MissionRecordRef,
  type OwnerRequest,
  type OwnerRequestId,
  type OwnerRequestView,
  type RoleId,
  type RoomId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MissionsTransport } from "../rpcSource.ts";
import {
  conditionOf,
  createMemoryMobileRequests,
  createRpcMobileRequests,
  discussForm,
  requestGroups,
  threadAbout,
  unreadDiscussionTotal,
  unreadRequestTotal,
  type RequestThread,
} from "./requests.ts";

const CRPKO = "crpko-engineering" as MissionId;
const AT = "2026-10-19T08:00:00.000Z";
const ASK: MissionRecordRef = { kind: "ask", id: "ask-1" };

function request(id: string, patch: Partial<OwnerRequest> = {}): OwnerRequest {
  return {
    id: id as OwnerRequestId,
    missionId: CRPKO,
    subMissionId: null,
    title: `Title ${id}`,
    status: "answered",
    roomId: `room-${id}` as RoomId,
    createdBy: { _tag: "owner-app", surface: "mobile", sessionId: null },
    lastOwnerAt: AT,
    lastMasterAt: AT,
    links: [],
    unreadForOwner: true,
    settledBy: null,
    settledAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  };
}

function message(seq: number, owner: boolean): MissionMessage {
  return {
    id: `message-${seq}` as MissionMessage["id"],
    missionId: CRPKO,
    roomId: "room-a" as RoomId,
    seq,
    kind: "request",
    author: owner ? { _tag: "owner" } : { _tag: "role", roleId: "master" as RoleId },
    provenance: { _tag: "owner-app", surface: "mobile", sessionId: null },
    to: [],
    summary: `summary ${seq}`,
    hasBody: false,
    key: null,
    workItemId: null,
    links: [],
    receipt: null,
    isCorrection: false,
    createdAt: AT,
  };
}

function view(owner: OwnerRequest, seqs: ReadonlyArray<number> = [1, 2]): OwnerRequestView {
  return {
    request: owner,
    messages: seqs.map((seq) => ({ message: message(seq, seq % 2 === 1), body: null })),
    hasOlder: false,
    unreadForOwner: owner.unreadForOwner,
  };
}

async function settle() {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

function fakeTransport(handlers: Record<string, (input: never) => unknown>) {
  const asked: Array<{ readonly tag: string; readonly input: unknown }> = [];
  const transport: MissionsTransport = {
    stream: () => () => {},
    request(tag, input) {
      asked.push({ tag, input });
      const handler = handlers[tag];
      if (handler === undefined) {
        return Promise.reject(new MissionError({ code: "not-found", detail: tag })) as never;
      }
      return Promise.resolve().then(() => handler(input as never)) as never;
    },
  };
  return { transport, asked };
}

function watcher() {
  const handlers = new Set<() => void>();
  return {
    watch: (_missionId: MissionId, onChange: () => void) => {
      handlers.add(onChange);
      onChange();
      return () => handlers.delete(onChange);
    },
    move: () => {
      for (const handler of Array.from(handlers)) handler();
    },
    open: () => handlers.size,
  };
}

describe("phone requests over the router RPCs", () => {
  it("lists requests from the server, refetching when the mission moves", async () => {
    let requests = [view(request("a"))];
    const { transport, asked } = fakeTransport({
      [WS_METHODS.missionsOwnerRequests]: () => ({ missionId: CRPKO, requests }),
    });
    const mission = watcher();
    const live = createRpcMobileRequests({ transport, watch: mission.watch });
    const seen: Array<ReadonlyArray<RequestThread>> = [];
    const close = live.subscribeRequests(CRPKO, (value) => seen.push(value));
    await settle();
    expect(seen.at(-1)?.map((thread) => thread.id)).toEqual(["a"]);
    expect(asked.length).toBe(1);

    requests = [view(request("b")), ...requests];
    mission.move();
    await settle();
    expect(seen.at(-1)?.map((thread) => thread.id)).toEqual(["b", "a"]);

    close();
    expect(mission.open()).toBe(0);
  });

  it("maps the conversation and hides unread on settled requests", async () => {
    const { transport } = fakeTransport({
      [WS_METHODS.missionsOwnerRequests]: () => ({
        missionId: CRPKO,
        requests: [view(request("a", { status: "settled", unreadForOwner: true }), [1, 2])],
      }),
    });
    const live = createRpcMobileRequests({ transport, watch: watcher().watch });
    let threads: ReadonlyArray<RequestThread> = [];
    live.subscribeRequests(CRPKO, (value) => {
      threads = value;
    });
    await settle();
    expect(threads[0]?.unread).toBe(false);
    expect(threads[0]?.messages.map((each) => each.author)).toEqual(["owner", "master"]);
    expect(threads[0]?.messages[1]?.text).toBe("summary 2");
  });

  it("Discuss opens a request about the record and finds it again without server subject", async () => {
    const opened = request("d", { status: "waiting-on-master", unreadForOwner: false });
    let requests: OwnerRequestView[] = [];
    const { transport, asked } = fakeTransport({
      [WS_METHODS.missionsOwnerRequests]: () => ({ missionId: CRPKO, requests }),
      [WS_METHODS.missionsOpenOwnerRequest]: () => {
        requests = [view(opened, [1])];
        return opened;
      },
    });
    const live = createRpcMobileRequests({ transport, watch: watcher().watch });
    let threads: ReadonlyArray<RequestThread> = [];
    live.subscribeRequests(CRPKO, (value) => {
      threads = value;
    });
    await settle();

    const form = discussForm(CRPKO, ASK, "  Why not ship Friday?  ");
    if (!form.ok) throw new Error(form.error);
    await live.open(form.input);
    await settle();

    const open = asked.find((each) => each.tag === WS_METHODS.missionsOpenOwnerRequest);
    expect(open?.input).toEqual({ missionId: CRPKO, text: "Why not ship Friday?", subject: ASK });
    expect(threadAbout(threads, ASK)?.id).toBe("d");
  });

  it("marks a request read at its newest message in the request room", async () => {
    const { transport, asked } = fakeTransport({
      [WS_METHODS.missionsOwnerRequests]: () => ({
        missionId: CRPKO,
        requests: [view(request("a"), [1, 2, 3])],
      }),
      [WS_METHODS.missionsMarkRead]: () => undefined,
    });
    const live = createRpcMobileRequests({ transport, watch: watcher().watch });
    let threads: ReadonlyArray<RequestThread> = [];
    live.subscribeRequests(CRPKO, (value) => {
      threads = value;
    });
    await settle();
    await live.markRead(threads[0]!);
    const read = asked.find((each) => each.tag === WS_METHODS.missionsMarkRead);
    expect(read?.input).toEqual({ roomId: "room-a", seq: 3 });
  });

  it("reads one request as null once the server no longer has it", async () => {
    const { transport } = fakeTransport({});
    const live = createRpcMobileRequests({ transport, watch: watcher().watch });
    const seen: Array<RequestThread | null> = [];
    live.subscribeRequest(CRPKO, "gone" as OwnerRequestId, (value) => seen.push(value));
    await settle();
    expect(seen).toEqual([null]);
  });
});

describe("phone request helpers", () => {
  it("puts unread open requests first and folds settled ones", () => {
    const thread = (id: string, patch: Partial<RequestThread>): RequestThread => ({
      id: id as OwnerRequestId,
      missionId: CRPKO,
      roomId: `room-${id}` as RoomId,
      title: id,
      status: "answered",
      subject: null,
      unread: false,
      messages: [],
      hasOlder: false,
      createdAt: AT,
      updatedAt: AT,
      ...patch,
    });
    const threads = [
      thread("old", { updatedAt: "2026-10-18T08:00:00.000Z" }),
      thread("done", { status: "settled" }),
      thread("fresh", { unread: true, updatedAt: "2026-10-17T08:00:00.000Z" }),
      thread("about-ask", { unread: true, subject: ASK }),
    ];
    const groups = requestGroups(threads);
    expect(groups.open.map((each) => each.id)).toEqual(["fresh", "old"]);
    expect(groups.settled.map((each) => each.id)).toEqual(["done"]);
    expect(unreadRequestTotal(threads)).toBe(1);
    expect(unreadDiscussionTotal(threads)).toBe(1);
  });

  it("refuses an empty Discuss and reads the owner's condition", () => {
    expect(discussForm(CRPKO, ASK, "   ")).toEqual({
      ok: false,
      error: "Write what you want to discuss first.",
    });
    const condition = { requestId: "r" as OwnerRequestId, quote: "only if QA signs off" };
    expect(conditionOf({ onOwnerCondition: condition })).toEqual(condition);
    expect(conditionOf({})).toBeNull();
  });

  it("the memory adapter keeps one conversation per record", async () => {
    const memory = createMemoryMobileRequests(() => Date.parse(AT));
    const first = await memory.open({ missionId: CRPKO, text: "First", subject: ASK });
    const again = await memory.open({ missionId: CRPKO, text: "Second", subject: ASK });
    expect(again).toBe(first);
    let threads: ReadonlyArray<RequestThread> = [];
    memory.subscribeRequests(CRPKO, (value) => {
      threads = value;
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messages.map((each) => each.text)).toEqual(["First", "Second"]);
  });
});
