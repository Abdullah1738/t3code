import {
  WS_METHODS,
  type MissionId,
  type MissionRecordRef,
  type OwnerCondition,
  type OwnerRequestId,
  type OwnerRequestStatus,
  type OwnerRequestView,
  type RoomId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { MissionsTransport } from "../rpcSource.ts";
import type { Listener, Unsubscribe } from "../source.ts";
import type { FormResult } from "./inbox.ts";

// The owner's requests to the master on the phone: "Your requests" and the
// Discuss conversation on a card. Read straight from the router's
// owner-request RPCs with the contract types, so the phone does not depend on
// how the shared source models requests.

export interface RequestMessageView {
  readonly id: string;
  readonly author: "owner" | "master";
  readonly text: string;
  readonly at: string;
  readonly seq: number;
}

export interface RequestThread {
  readonly id: OwnerRequestId;
  readonly missionId: MissionId;
  readonly roomId: RoomId;
  readonly title: string;
  readonly status: OwnerRequestStatus;
  /** The record a Discuss conversation is about; null for a plain request. */
  readonly subject: MissionRecordRef | null;
  readonly unread: boolean;
  /** Oldest first. */
  readonly messages: ReadonlyArray<RequestMessageView>;
  readonly hasOlder: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpenRequestForm {
  readonly missionId: MissionId;
  readonly text: string;
  readonly subject?: MissionRecordRef;
}

export interface MobileRequests {
  /** Every request of a mission, newest activity first. */
  subscribeRequests(
    missionId: MissionId,
    listener: Listener<ReadonlyArray<RequestThread>>,
  ): Unsubscribe;
  /** One request with its longer conversation; null when it does not exist. */
  subscribeRequest(
    missionId: MissionId,
    requestId: OwnerRequestId,
    listener: Listener<RequestThread | null>,
  ): Unsubscribe;
  open(form: OpenRequestForm): Promise<OwnerRequestId>;
  reply(thread: RequestThread, text: string): Promise<void>;
  settle(thread: RequestThread): Promise<void>;
  reopen(thread: RequestThread): Promise<void>;
  /** Marks the conversation read up to its newest message. */
  markRead(thread: RequestThread): Promise<void>;
}

export const REQUEST_STATUS_TEXT: Readonly<Record<OwnerRequestStatus, string>> = {
  "waiting-on-master": "Waiting",
  answered: "Answered",
  settled: "Settled",
};

const REQUEST_TEXT_MAX = 20_000;

function sameRef(left: MissionRecordRef, right: MissionRecordRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export function requestThreadOf(
  view: OwnerRequestView,
  subject: MissionRecordRef | null = null,
): RequestThread {
  const { request } = view;
  return {
    id: request.id,
    missionId: request.missionId,
    roomId: request.roomId,
    title: request.title,
    status: request.status,
    subject: request.subject ?? subject,
    unread: request.status !== "settled" && view.unreadForOwner,
    messages: view.messages.map(({ message, body }) => ({
      id: message.id,
      author: message.author._tag === "owner" ? "owner" : "master",
      text: body ?? message.summary,
      at: message.createdAt,
      seq: message.seq,
    })),
    hasOlder: view.hasOlder,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

/**
 * Your requests: only the owner's own asks. A Discuss conversation about a
 * record stays on that record's card, so it never lists here. Open requests
 * with unread answers first, then newest; settled ones fold away.
 */
export function requestGroups(threads: ReadonlyArray<RequestThread>): {
  readonly open: ReadonlyArray<RequestThread>;
  readonly settled: ReadonlyArray<RequestThread>;
} {
  const own = threads.filter((thread) => thread.subject === null);
  const newest = (left: RequestThread, right: RequestThread) =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  const open = own
    .filter((thread) => thread.status !== "settled")
    .sort((left, right) => Number(right.unread) - Number(left.unread) || newest(left, right));
  const settled = own.filter((thread) => thread.status === "settled").sort(newest);
  return { open, settled };
}

/** Unread answers to the owner's own asks (the Your requests badge). */
export function unreadRequestTotal(threads: ReadonlyArray<RequestThread>): number {
  return threads.filter((thread) => thread.subject === null && thread.unread).length;
}

/** Discussions on records the master answered and the owner has not read; they count toward Needs you. */
export function unreadDiscussionTotal(threads: ReadonlyArray<RequestThread>): number {
  return threads.filter((thread) => thread.subject !== null && thread.unread).length;
}

/** The master's newest reply, for the one line a row shows. */
export function lastMasterReply(thread: RequestThread): RequestMessageView | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (message.author === "master") return message;
  }
  return null;
}

/** The open conversation about a record; one per record. */
export function threadAbout(
  threads: ReadonlyArray<RequestThread>,
  subject: MissionRecordRef,
): RequestThread | null {
  return (
    threads.find(
      (thread) =>
        thread.status !== "settled" && thread.subject !== null && sameRef(thread.subject, subject),
    ) ?? null
  );
}

/** The owner's condition a record was decided on, when the master settled it that way. */
export function conditionOf(record: {
  readonly onOwnerCondition?: OwnerCondition | null | undefined;
}): OwnerCondition | null {
  return record.onOwnerCondition ?? null;
}

function textForm<T>(text: string, empty: string, build: (text: string) => T): FormResult<T> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: empty };
  if (trimmed.length > REQUEST_TEXT_MAX) {
    return {
      ok: false,
      error: `Keep it under ${REQUEST_TEXT_MAX.toLocaleString("en-US")} characters.`,
    };
  }
  return { ok: true, input: build(trimmed) };
}

export function requestForm(missionId: MissionId, text: string): FormResult<OpenRequestForm> {
  return textForm(text, "Write what you want to ask first.", (trimmed) => ({
    missionId,
    text: trimmed,
  }));
}

export function discussForm(
  missionId: MissionId,
  subject: MissionRecordRef,
  text: string,
): FormResult<OpenRequestForm> {
  return textForm(text, "Write what you want to discuss first.", (trimmed) => ({
    missionId,
    text: trimmed,
    subject,
  }));
}

export function replyForm(text: string): FormResult<string> {
  return textForm(text, "Write a reply first.", (trimmed) => trimmed);
}

// ---------------------------------------------------------------------------
// Live adapter

/** One upstream feed per key, shared by readers, replaying the latest value. */
function sharedFeeds<K, T>(open: (key: K, emit: (value: T) => void) => Unsubscribe) {
  interface Entry {
    has: boolean;
    value: T | undefined;
    readonly listeners: Set<Listener<T>>;
    close: Unsubscribe;
  }
  const entries = new Map<K, Entry>();
  return (key: K, listener: Listener<T>): Unsubscribe => {
    let entry = entries.get(key);
    if (entry === undefined) {
      const created: Entry = {
        has: false,
        value: undefined,
        listeners: new Set(),
        close: () => {},
      };
      entries.set(key, created);
      created.listeners.add(listener);
      created.close = open(key, (value) => {
        created.has = true;
        created.value = value;
        for (const each of Array.from(created.listeners)) each(value);
      });
      entry = created;
    } else {
      entry.listeners.add(listener);
      if (entry.has) listener(entry.value as T);
    }
    const own = entry;
    return () => {
      own.listeners.delete(listener);
      if (own.listeners.size > 0 || entries.get(key) !== own) return;
      entries.delete(key);
      own.close();
    };
  };
}

/** Re-runs a load on demand; asks during a run collapse into one more run. */
function refetching<T>(load: () => Promise<T>, emit: (value: T) => void, onError: () => void) {
  let inFlight = false;
  let again = false;
  let closed = false;
  const run = () => {
    if (closed) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    load()
      .then(
        (value) => {
          if (!closed) emit(value);
        },
        () => {
          if (!closed) onError();
        },
      )
      .finally(() => {
        inFlight = false;
        if (!again) return;
        again = false;
        run();
      });
  };
  return {
    run,
    close: () => {
      closed = true;
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code: unknown }).code === "not-found"
  );
}

export interface RpcMobileRequestsOptions {
  readonly transport: MissionsTransport;
  /**
   * Calls `onChange` with the mission's current state and again whenever it
   * moves (its overview stream re-sends on owner-request changes); requests
   * refetch on every call after the first.
   */
  readonly watch: (missionId: MissionId, onChange: () => void) => Unsubscribe;
}

export function createRpcMobileRequests(options: RpcMobileRequestsOptions): MobileRequests {
  const { transport, watch } = options;
  const touched = new Map<MissionId, Set<() => void>>();
  // The router may not keep `subject` yet; the phone remembers what it opened
  // a conversation about so Discuss finds it again this session.
  const subjects = new Map<OwnerRequestId, MissionRecordRef>();

  const onTouch = (missionId: MissionId, handler: () => void): Unsubscribe => {
    const handlers = touched.get(missionId) ?? new Set();
    handlers.add(handler);
    touched.set(missionId, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) touched.delete(missionId);
    };
  };
  const touch = (missionId: MissionId) => {
    for (const handler of Array.from(touched.get(missionId) ?? [])) handler();
  };
  const thread = (view: OwnerRequestView) =>
    requestThreadOf(view, subjects.get(view.request.id) ?? null);

  const follow = (missionId: MissionId, run: () => void, close: () => void): Unsubscribe => {
    run();
    // The first call reports where the mission is now, which `run` just read.
    let primed = false;
    const stopWatch = watch(missionId, () => {
      if (primed) run();
      primed = true;
    });
    const stopTouch = onTouch(missionId, run);
    return () => {
      close();
      stopWatch();
      stopTouch();
    };
  };

  const listFeed = sharedFeeds<MissionId, ReadonlyArray<RequestThread>>((missionId, emit) => {
    const feed = refetching(
      () => transport.request(WS_METHODS.missionsOwnerRequests, { missionId }),
      (value) => emit(value.requests.map(thread)),
      () => {},
    );
    return follow(missionId, feed.run, feed.close);
  });

  const threadFeed = sharedFeeds<string, RequestThread | null>((key, emit) => {
    const [missionId, requestId] = key.split("\n") as [MissionId, OwnerRequestId];
    const feed = refetching(
      () =>
        transport
          .request(WS_METHODS.missionsOwnerRequests, { missionId, requestId })
          .then((value) => value.requests.find((view) => view.request.id === requestId) ?? null)
          .catch((error: unknown) => {
            if (isNotFound(error)) return null;
            throw error;
          }),
      (view) => emit(view === null ? null : thread(view)),
      () => {},
    );
    return follow(missionId, feed.run, feed.close);
  });

  return {
    subscribeRequests: (missionId, listener) => listFeed(missionId, listener),
    subscribeRequest: (missionId, requestId, listener) =>
      threadFeed(`${missionId}\n${requestId}`, listener),
    open: async (form) => {
      // `subject` is a router addition; until the contract carries it the
      // server drops the field and the session map above keeps the link.
      const input = {
        missionId: form.missionId,
        text: form.text,
        ...(form.subject ? { subject: form.subject } : {}),
      };
      const request = await transport.request(WS_METHODS.missionsOpenOwnerRequest, input);
      if (form.subject) subjects.set(request.id, form.subject);
      touch(form.missionId);
      return request.id;
    },
    reply: async (target, text) => {
      await transport.request(WS_METHODS.missionsReplyOwnerRequest, {
        requestId: target.id,
        text,
      });
      touch(target.missionId);
    },
    settle: async (target) => {
      await transport.request(WS_METHODS.missionsSettleOwnerRequest, { requestId: target.id });
      touch(target.missionId);
    },
    reopen: async (target) => {
      await transport.request(WS_METHODS.missionsReopenOwnerRequest, { requestId: target.id });
      touch(target.missionId);
    },
    markRead: async (target) => {
      const newest = target.messages.at(-1);
      if (!target.unread || newest === undefined) return;
      await transport.request(WS_METHODS.missionsMarkRead, {
        roomId: target.roomId,
        seq: newest.seq,
      });
      touch(target.missionId);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory adapter (dev fixture mode)

export function createMemoryMobileRequests(now: () => number = Date.now): MobileRequests {
  const threads = new Map<OwnerRequestId, RequestThread>();
  const listeners = new Set<() => void>();
  let counter = 0;
  const changed = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const at = () => DateTime.formatIso(DateTime.makeUnsafe(now()));
  const update = (id: OwnerRequestId, change: (thread: RequestThread) => RequestThread) => {
    const current = threads.get(id);
    if (!current) return Promise.reject(new Error("That request is gone."));
    threads.set(id, change(current));
    changed();
    return Promise.resolve();
  };
  const listOf = (missionId: MissionId) =>
    Array.from(threads.values())
      .filter((thread) => thread.missionId === missionId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const watchList = <T>(read: () => T, listener: Listener<T>): Unsubscribe => {
    const emit = () => listener(read());
    listeners.add(emit);
    emit();
    return () => listeners.delete(emit);
  };
  const message = (author: "owner" | "master", text: string, seq: number) => ({
    id: `message-${(counter += 1)}`,
    author,
    text,
    at: at(),
    seq,
  });

  return {
    subscribeRequests: (missionId, listener) => watchList(() => listOf(missionId), listener),
    subscribeRequest: (_missionId, requestId, listener) =>
      watchList(() => threads.get(requestId) ?? null, listener),
    open: (form) => {
      const existing = form.subject ? threadAbout(listOf(form.missionId), form.subject) : null;
      if (existing) {
        return update(existing.id, (thread) => appendOwner(thread, form.text)).then(
          () => existing.id,
        );
      }
      counter += 1;
      const id = `request-local-${counter}` as OwnerRequestId;
      const stamp = at();
      threads.set(id, {
        id,
        missionId: form.missionId,
        roomId: `room-${id}` as RoomId,
        title: form.text.split("\n")[0]!.slice(0, 120),
        status: "waiting-on-master",
        subject: form.subject ?? null,
        unread: false,
        messages: [message("owner", form.text, 1)],
        hasOlder: false,
        createdAt: stamp,
        updatedAt: stamp,
      });
      changed();
      return Promise.resolve(id);
    },
    reply: (target, text) => {
      if (target.status === "settled") {
        return Promise.reject(new Error(`Request "${target.title}" is settled; reopen it first.`));
      }
      return update(target.id, (thread) => appendOwner(thread, text));
    },
    settle: (target) =>
      update(target.id, (thread) => ({
        ...thread,
        status: "settled",
        unread: false,
        updatedAt: at(),
      })),
    reopen: (target) =>
      update(target.id, (thread) => ({ ...thread, status: "waiting-on-master", updatedAt: at() })),
    markRead: (target) => update(target.id, (thread) => ({ ...thread, unread: false })),
  };

  function appendOwner(thread: RequestThread, text: string): RequestThread {
    const seq = (thread.messages.at(-1)?.seq ?? 0) + 1;
    return {
      ...thread,
      status: "waiting-on-master",
      messages: [...thread.messages, message("owner", text, seq)],
      updatedAt: at(),
    };
  }
}
