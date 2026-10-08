import {
  acceptBoardSnapshot,
  applyBoardDelta,
  applyBoardSnapshot,
  boardReconnectDelay,
  createSseParser,
} from "@t3tools/client-runtime/ardud/board";
import type {
  ArdudBoardClearResult,
  ArdudBoardDelta,
  ArdudBoardEntry,
  ArdudBoardSnapshot,
} from "@t3tools/contracts";
import { create } from "zustand";

import { resolveBoardEndpoint } from "./boardEnvironment";

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

async function request<A>(path: string, init?: { body?: unknown }): Promise<A> {
  const endpoint = await resolveBoardEndpoint(`/api/ardud/board${path}`);
  const response = await fetch(endpoint.url, {
    method: init ? "POST" : "GET",
    credentials: endpoint.credentials,
    cache: "no-store",
    headers: {
      ...endpoint.headers,
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
  useBoardStore.setState((state) => acceptBoardSnapshot(state, snapshot));

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

let subscribers = 0;
let controller: AbortController | null = null;

async function runStream(signal: AbortSignal) {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      useBoardStore.setState({ connection: "connecting" });
      const endpoint = await resolveBoardEndpoint("/api/ardud/board/events");
      const response = await fetch(endpoint.url, {
        credentials: endpoint.credentials,
        cache: "no-store",
        headers: { ...endpoint.headers, accept: "text/event-stream" },
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
    await new Promise((resolve) => setTimeout(resolve, boardReconnectDelay(attempt)));
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
