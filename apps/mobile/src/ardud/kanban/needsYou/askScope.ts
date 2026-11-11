/**
 * One Needs-you store per server. A scope is the ask store, its state and its
 * server calls, all bound to one environment id for good: its calls reach that
 * server or nothing. When the phone's server changes or goes away (the
 * connection is disabled, removed, or another one takes its place) the scope
 * is closed and a new one is opened for the new server. Closing drops what was
 * waiting instead of carrying it over: a held answer is never sent, an answer
 * that failed is never retried, forms and what was read are cleared, and
 * secrets typed on a screen are cleared before anything else.
 *
 * Nothing here knows about React Native or the app's state, so it runs in a
 * unit test: the host says which server is in use and how to reach it.
 */
import {
  AskApiError,
  createAskApi,
  createAskStateCell,
  createAskStore,
  type AskApi,
  type AskApiTarget,
  type AskSecretSendResult,
  type AskStateCell,
  type AskStore,
  type AskWatchHost,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskSecretAnswerInput } from "@t3tools/contracts";

import { ownerStanding, unreachedRetryTracker, type SessionRead } from "./logic";

/**
 * How the app's connection to a server stands. `live`: there is one to call.
 * `waiting`: the app wants the server and waits between attempts (the
 * connection layer backs off for up to five minutes). `down`: anything else
 * (switched off, the phone is offline, an attempt is under way, refused).
 */
export type AskConnection = "live" | "waiting" | "down";

/** The least time between two "try now" calls to the connection layer. */
export const ASK_RECONNECT_GAP_MS = 30_000;

export interface AskScopeHost {
  /** The server in use now, or null when there is none. */
  readonly paired: () => string | null;
  /** Calls `run` whenever the server in use may have changed. */
  readonly onPairedChange: (run: () => void) => () => void;
  /** How to reach exactly this server. Throws `AskApiError` when it can't be reached. */
  readonly target: (environmentId: string) => AskApiTarget;
  /** Sends an answer with its secrets to exactly this server, over the socket call made for it. */
  readonly sendSecrets: (
    environmentId: string,
    input: KanbanAskSecretAnswerInput,
  ) => Promise<AskSecretSendResult>;
  readonly watch: AskWatchHost;
  /** What the app holds of this server's session at this moment. */
  readonly session: (environmentId: string) => SessionRead;
  /** Calls `run` whenever that may have changed. It also keeps the session read while the scope lives. */
  readonly onSessionChange: (environmentId: string, run: () => void) => () => void;
  /** Reads the session again. */
  readonly rereadSession: (environmentId: string) => void;
  /** How the connection to this server stands now. */
  readonly connection: (environmentId: string) => AskConnection;
  /** Calls `run` whenever that may have changed. */
  readonly onConnectionChange: (environmentId: string, run: () => void) => () => void;
  /** Tells the connection layer to try this server now, not after its delay. */
  readonly reconnect: (environmentId: string) => void;
  /** Runs `run` after the current store update has settled. */
  readonly defer: (run: () => void) => void;
  /** The time now, in epoch ms. */
  readonly now: () => number;
  readonly fetch?: typeof fetch;
  readonly undoMs?: number;
}

export interface AskScope {
  /** Different for every scope: a screen keyed on it starts over with a new server. */
  readonly serial: number;
  /** The one server this scope talks to. Never changes; null is "no server". */
  readonly environmentId: string | null;
  readonly api: AskApi;
  readonly cell: AskStateCell;
  readonly asks: AskStore;
  /** False once its server is no longer the one in use. */
  readonly live: () => boolean;
}

export interface AskScopes {
  readonly current: () => AskScope;
  /** Tells when a new scope replaced the old one. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * A screen that holds secrets in its own state gives the way to clear them.
   * It is called first when the server changes, before anything else is dropped.
   */
  readonly holdSecrets: (drop: () => void) => () => void;
  /** Checks the server in use now; the host's change signal calls the same thing. */
  readonly sync: () => void;
  readonly stop: () => void;
}

const NOT_CONNECTED = "Not connected to Robob.";

export function createAskScopes(host: AskScopeHost): AskScopes {
  let serial = 0;
  const listeners = new Set<() => void>();
  const secretHolders = new Set<() => void>();
  const closers = new WeakMap<AskScope, () => void>();

  const open = (environmentId: string | null): AskScope => {
    let closed = false;
    // Its own server, still the one in use, or nothing at all.
    const mine = (): string | null =>
      !closed && environmentId !== null && host.paired() === environmentId ? environmentId : null;
    // The address and credential of this server as last used over a live
    // connection, in memory only. While the connection layer waits between
    // attempts there is nothing live to call, though the server may be back
    // long before the next attempt: the calls then go to where they last went.
    // That is how the feed's own poll finds the server again. A credential the
    // server no longer takes is dropped.
    let kept: AskApiTarget | null = null;
    let keptUsed = false;
    const send = host.fetch ?? fetch;
    const api = createAskApi({
      target: () => {
        const id = mine();
        if (id === null) throw new AskApiError(0, "offline", NOT_CONNECTED);
        try {
          const live = host.target(id);
          kept = live;
          keptUsed = false;
          return live;
        } catch (error) {
          const offline = error instanceof AskApiError && error.code === "offline";
          if (!offline || kept === null || host.connection(id) !== "waiting") throw error;
          keptUsed = true;
          return kept;
        }
      },
      fetch: (async (...call: Parameters<typeof fetch>) => {
        const response = await send(...call);
        if (response.status === 401 && keptUsed) kept = null;
        return response;
      }) as typeof fetch,
      answerSecrets: async (input) => {
        const id = mine();
        if (id === null) return { _tag: "offline" };
        return host.sendSecrets(id, input);
      },
    });
    const cell = createAskStateCell();
    const asks = createAskStore({
      api,
      cell,
      watch: host.watch,
      ...(host.undoMs === undefined ? {} : { undoMs: host.undoMs }),
    });
    // An answer that never reached the server is kept in memory as "not
    // sent". Once the feed has been read with success a while after it failed,
    // the server is reachable: the answer goes once more, by itself, while it
    // has tries left (`unreachedRetryTracker`). Sending is the owner's alone, so
    // it goes by itself only while the session is known to be his and the
    // server has not refused this phone since: asked at the moment it would go.
    // "Known to be his" is what the answer controls go by too (`ownerStanding`):
    // the session says so now, or said so before the connection went and
    // nothing has said otherwise since.
    const ownerNow = (): boolean => {
      const id = mine();
      if (id === null) return false;
      const state = cell.getState();
      return ownerStanding(host.session(id), state.notOwner !== null, state.ownerSeen) === "owner";
    };
    const retries = unreachedRetryTracker();
    let readsSeen = 0;
    let reconnectAt: number | null = null;
    const stopRetry = cell.subscribe(() => {
      const state = cell.getState();
      // The feed was read while the connection layer still waits to try again:
      // the server is back, so it is told to try now. Without this the rest of
      // the app (and the session) stays disconnected for the rest of the delay.
      if (state.reads !== readsSeen) {
        const read = state.reads > readsSeen;
        readsSeen = state.reads;
        const id = mine();
        const now = host.now();
        if (
          read &&
          id !== null &&
          host.connection(id) === "waiting" &&
          (reconnectAt === null || now - reconnectAt >= ASK_RECONNECT_GAP_MS)
        ) {
          reconnectAt = now;
          host.reconnect(id);
        }
      }
      const due = retries.next(state, host.now());
      if (due.size === 0) return;
      host.defer(() => {
        if (closed || !ownerNow()) return;
        asks.retryUnreachedAskSends(undefined, (send) => due.has(send.id));
      });
    });
    // What the session says goes to the store as it changes, whatever screen is
    // up: a session that says owner is remembered for when it can't be read.
    let noted: boolean | null | undefined;
    const noteSession = () => {
      const id = mine();
      if (id === null) return;
      const read = host.session(id);
      const owner =
        read.state === "reading"
          ? undefined
          : read.state === "read" && read.authenticated && read.owner !== undefined
            ? read.owner
            : null;
      if (owner === noted) return;
      noted = owner;
      asks.noteOwnerStanding(owner);
    };
    // The connection is back: the feed is read at once, not at the next poll.
    // The session reads itself again with every new connection.
    let live = environmentId !== null && host.connection(environmentId) === "live";
    const noteConnection = () => {
      const id = mine();
      const now = id !== null && host.connection(id) === "live";
      const back = now && !live;
      live = now;
      // Only a store that has read, or tried to: the first read is the screen's to start.
      if (back && cell.getState().status !== "idle") void asks.refreshAsks();
    };
    const stops =
      environmentId === null
        ? []
        : [
            host.onSessionChange(environmentId, noteSession),
            host.onConnectionChange(environmentId, noteConnection),
            // Back in front: the session is read again (the store reads the feed).
            host.watch.onForeground(() => {
              const id = mine();
              if (id !== null) host.rereadSession(id);
            }),
          ];
    noteSession();
    const scope: AskScope = {
      serial: ++serial,
      environmentId,
      api,
      cell,
      asks,
      live: () => mine() !== null,
    };
    closers.set(scope, () => {
      if (closed) return;
      // Closed first, so nothing the store does while it empties can reach a server.
      closed = true;
      stopRetry();
      for (const stop of stops) stop();
      kept = null;
      asks.dispose();
    });
    return scope;
  };

  let current = open(host.paired());

  const sync = () => {
    const next = host.paired();
    if (next === current.environmentId) return;
    // Secrets first: they live on a screen, typed for the old server.
    for (const drop of Array.from(secretHolders)) drop();
    closers.get(current)?.();
    current = open(next);
    for (const listener of Array.from(listeners)) listener();
  };
  const stopHost = host.onPairedChange(sync);

  return {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    holdSecrets: (drop) => {
      secretHolders.add(drop);
      return () => void secretHolders.delete(drop);
    },
    sync,
    stop: () => {
      stopHost();
      closers.get(current)?.();
    },
  };
}
