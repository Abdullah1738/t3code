import type {
  ArdudBoardClearResult,
  ArdudBoardDelta,
  ArdudBoardEntry,
  ArdudBoardSnapshot,
} from "@t3tools/contracts";
import { create } from "zustand";

import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";

/**
 * Client for the fork's session board (/api/ardud/board). The server pushes
 * one snapshot and then small deltas; there is no polling. On disconnect the
 * stream reconnects with backoff and starts from a fresh snapshot.
 */

export type BoardEntry = ArdudBoardEntry;

interface BoardState {
  readonly entries: ReadonlyMap<string, BoardEntry>;
  readonly revision: number;
  readonly syncError: string | null;
  readonly connection: "connecting" | "live" | "offline";
  readonly error: string | null;
}

export const useBoardStore = create<BoardState>(() => ({
  entries: new Map(),
  revision: -1,
  syncError: null,
  connection: "connecting",
  error: null,
}));

export function applyBoardSnapshot(state: BoardState, snapshot: ArdudBoardSnapshot): BoardState {
  return {
    ...state,
    entries: new Map(snapshot.entries.map((entry) => [entry.threadId, entry])),
    revision: snapshot.revision,
    syncError: snapshot.syncError,
  };
}

export function applyBoardDelta(state: BoardState, delta: ArdudBoardDelta): BoardState {
  const entries = new Map(state.entries);
  for (const id of delta.removed) entries.delete(id);
  for (const entry of delta.upserts) entries.set(entry.threadId, entry);
  return {
    ...state,
    entries,
    revision: Math.max(state.revision, delta.revision),
    syncError: delta.syncError,
  };
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await readDesktopPrimaryBearerToken().catch(() => null);
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<A>(path: string, init?: { body?: unknown }): Promise<A> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(`/api/ardud/board${path}`), {
    method: init ? "POST" : "GET",
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(await authHeaders()),
      ...(init ? { "content-type": "application/json" } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body ?? {}) } : {}),
  });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? "The session board is unavailable.");
  }
  return body as A;
}

const token = (entry: BoardEntry) => ({
  threadId: entry.threadId,
  workRevision: entry.workRevision,
});

const acceptSnapshot = (snapshot: ArdudBoardSnapshot) =>
  useBoardStore.setState((state) =>
    snapshot.revision >= state.revision ? applyBoardSnapshot(state, snapshot) : state,
  );

export const boardActions = {
  review: (entry: BoardEntry) =>
    request<ArdudBoardSnapshot>("/review", { body: token(entry) }).then(acceptSnapshot),
  backlog: (entry: BoardEntry) =>
    request<ArdudBoardSnapshot>("/backlog", { body: token(entry) }).then(acceptSnapshot),
  restore: (entry: BoardEntry) =>
    request<ArdudBoardSnapshot>("/restore", { body: token(entry) }).then(acceptSnapshot),
  clear: async (lane: "waiting" | "backlog" | "scheduled", entries: ReadonlyArray<BoardEntry>) => {
    const result = await request<ArdudBoardClearResult>("/clear", {
      body: { lane, entries: entries.slice(0, 500).map(token) },
    });
    acceptSnapshot(result);
    return result;
  },
  reconcile: () => request<ArdudBoardSnapshot>("/reconcile", { body: {} }).then(acceptSnapshot),
};

/** Parses a text/event-stream body into (event, data) pairs. */
export function createSseParser(onEvent: (event: string, data: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) onEvent(event, data.join("\n"));
      boundary = buffer.indexOf("\n\n");
    }
  };
}

let subscribers = 0;
let controller: AbortController | null = null;

async function runStream(signal: AbortSignal) {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      useBoardStore.setState({ connection: "connecting" });
      const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/ardud/board/events"), {
        credentials: "include",
        cache: "no-store",
        headers: { ...(await authHeaders()), accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`Session board stream failed (${response.status}).`);
      }
      const decoder = new TextDecoder();
      const parse = createSseParser((event, data) => {
        if (event === "snapshot") {
          // A (re)connect snapshot is authoritative even at an equal revision.
          useBoardStore.setState((state) => ({
            ...applyBoardSnapshot(state, JSON.parse(data) as ArdudBoardSnapshot),
            connection: "live",
            error: null,
          }));
          attempt = 0;
        } else if (event === "delta") {
          useBoardStore.setState((state) =>
            applyBoardDelta(state, JSON.parse(data) as ArdudBoardDelta),
          );
        }
      });
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (signal.aborted) return;
      useBoardStore.setState({
        connection: "offline",
        error: error instanceof Error ? error.message : "The session board is unavailable.",
      });
    }
    if (signal.aborted) return;
    attempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Keeps the board stream open while at least one view is mounted. */
export function subscribeBoard(): () => void {
  subscribers += 1;
  if (controller === null) {
    controller = new AbortController();
    void runStream(controller.signal);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscribers -= 1;
    if (subscribers === 0) {
      controller?.abort();
      controller = null;
    }
  };
}
