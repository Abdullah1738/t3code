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

import { unreachedRetryTracker } from "./logic";

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
    const api = createAskApi({
      target: () => {
        const id = mine();
        if (id === null) throw new AskApiError(0, "offline", NOT_CONNECTED);
        return host.target(id);
      },
      answerSecrets: async (input) => {
        const id = mine();
        if (id === null) return { _tag: "offline" };
        return host.sendSecrets(id, input);
      },
      ...(host.fetch === undefined ? {} : { fetch: host.fetch }),
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
    // has tries left (`unreachedRetryTracker`).
    const retries = unreachedRetryTracker();
    const stopRetry = cell.subscribe(() => {
      const due = retries.next(cell.getState(), host.now());
      if (due.size === 0) return;
      host.defer(() => {
        if (!closed) asks.retryUnreachedAskSends(undefined, (send) => due.has(send.id));
      });
    });
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
