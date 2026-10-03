import { useIsFocused } from "@react-navigation/native";
import {
  acceptBoardSnapshot,
  applyBoardDelta,
  applyBoardSnapshot,
  boardReconnectDelay,
  createSseParser,
  type BoardData,
} from "@t3tools/client-runtime/ardud/board";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import type {
  ArdudBoardClearResult,
  ArdudBoardDelta,
  ArdudBoardEntry,
  ArdudBoardSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import { fetch } from "expo/fetch";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";

/**
 * Client for the fork's session board (/api/ardud/board) on one bearer-paired
 * environment. While the screen is focused and the app is in the foreground it
 * holds the SSE stream open (snapshot, then deltas). Focus, foreground and
 * pull-to-refresh also GET the snapshot, so the board stays usable if
 * streaming misbehaves.
 */

export interface BoardConnection {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}

export interface BoardState extends BoardData {
  readonly connection: "connecting" | "live" | "offline";
  readonly error: string | null;
  /** "missing" means the server answered 404: it has no board. */
  readonly availability: "unknown" | "ready" | "missing";
}

const INITIAL_STATE: BoardState = {
  entries: new Map(),
  revision: -1,
  syncError: null,
  connection: "connecting",
  error: null,
  availability: "unknown",
};

const UNAVAILABLE = "The session board is unavailable.";
export const BOARD_CONFLICT_MESSAGE = "Card changed, refreshed";

export class BoardRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const boardUrl = (connection: BoardConnection, path: string) =>
  environmentEndpointUrl(connection.httpBaseUrl, `/api/ardud/board${path}`);

async function boardRequest<A>(
  connection: BoardConnection,
  path: string,
  init?: { readonly body: unknown; readonly signal?: AbortSignal },
): Promise<A> {
  const response = await fetch(boardUrl(connection, path), {
    method: init ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${connection.bearerToken}`,
      ...(init ? { "content-type": "application/json" } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new BoardRequestError(response.status, body?.error ?? UNAVAILABLE);
  return body as A;
}

/** GETs the board on each environment once; 200 means it has a board. */
export async function probeBoard(
  connection: BoardConnection,
  signal: AbortSignal,
): Promise<"board" | "none" | "error"> {
  try {
    const response = await fetch(boardUrl(connection, ""), {
      headers: { authorization: `Bearer ${connection.bearerToken}` },
      signal,
    });
    void response.body?.cancel().catch(() => undefined);
    if (response.ok) return "board";
    return response.status === 404 ? "none" : "error";
  } catch {
    return "error";
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setActive(next === "active"),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

const token = (entry: ArdudBoardEntry) => ({
  threadId: entry.threadId,
  workRevision: entry.workRevision,
});

/** Mount once per environment (key the caller by environment id) so state starts fresh. */
export function useBoard(connection: BoardConnection | null) {
  const focused = useIsFocused();
  const appActive = useAppActive();
  const active = focused && appActive && connection !== null;
  const [state, setState] = useState<BoardState>(INITIAL_STATE);
  const [refreshing, setRefreshing] = useState(false);
  const httpBaseUrl = connection?.httpBaseUrl ?? null;
  const bearerToken = connection?.bearerToken ?? null;
  const stable = useMemo(
    () => (httpBaseUrl !== null && bearerToken !== null ? { httpBaseUrl, bearerToken } : null),
    [httpBaseUrl, bearerToken],
  );

  const refresh = useCallback(async () => {
    if (stable === null) return;
    try {
      const snapshot = await boardRequest<ArdudBoardSnapshot>(stable, "");
      setState((previous) => ({
        ...acceptBoardSnapshot(previous, snapshot),
        availability: "ready",
        error: null,
      }));
    } catch (error) {
      setState((previous) =>
        error instanceof BoardRequestError && error.status === 404
          ? { ...previous, availability: "missing" }
          : { ...previous, error: error instanceof Error ? error.message : UNAVAILABLE },
      );
    }
  }, [stable]);

  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (!active || stable === null) return;
    const controller = new AbortController();
    const { signal } = controller;
    // Focus and foreground fetch the snapshot directly, so the board updates
    // even when streaming is unavailable.
    // oxlint-disable-next-line react/set-state-in-effect -- the state updates land after the network round-trip.
    void refresh();
    void (async () => {
      let attempt = 0;
      while (!signal.aborted) {
        try {
          setState((previous) => ({ ...previous, connection: "connecting" }));
          const response = await fetch(boardUrl(stable, "/events"), {
            headers: {
              authorization: `Bearer ${stable.bearerToken}`,
              accept: "text/event-stream",
            },
            signal,
          });
          if (response.status === 404) {
            setState((previous) => ({ ...previous, availability: "missing" }));
            return;
          }
          if (!response.ok || response.body === null) {
            throw new Error(`Session board stream failed (${response.status}).`);
          }
          const decoder = new TextDecoder();
          const parse = createSseParser((event, data) => {
            if (signal.aborted) return;
            if (event === "snapshot") {
              // A (re)connect snapshot is authoritative even at an equal revision.
              const snapshot = JSON.parse(data) as ArdudBoardSnapshot;
              setState((previous) => ({
                ...applyBoardSnapshot(previous, snapshot),
                connection: "live",
                error: null,
                availability: "ready",
              }));
              attempt = 0;
            } else if (event === "delta") {
              const delta = JSON.parse(data) as ArdudBoardDelta;
              setState((previous) => applyBoardDelta(previous, delta));
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
          setState((previous) => ({
            ...previous,
            connection: "offline",
            error: error instanceof Error ? error.message : UNAVAILABLE,
          }));
        }
        if (signal.aborted) return;
        attempt += 1;
        await sleep(boardReconnectDelay(attempt), signal);
      }
    })();
    return () => controller.abort();
  }, [active, refresh, stable]);

  const run = useCallback(
    async <A extends ArdudBoardSnapshot>(path: string, body: unknown): Promise<A> => {
      if (stable === null) throw new Error(UNAVAILABLE);
      try {
        const result = await boardRequest<A>(stable, path, { body });
        setState((previous) => acceptBoardSnapshot(previous, result));
        return result;
      } catch (error) {
        if (error instanceof BoardRequestError && error.status === 409) {
          void refresh();
          throw new BoardRequestError(409, BOARD_CONFLICT_MESSAGE);
        }
        throw error;
      }
    },
    [refresh, stable],
  );

  const actions = useMemo(
    () => ({
      review: (entry: ArdudBoardEntry) => run("/review", token(entry)),
      backlog: (entry: ArdudBoardEntry) => run("/backlog", token(entry)),
      restore: (entry: ArdudBoardEntry) => run("/restore", token(entry)),
      clear: (lane: "waiting" | "backlog" | "scheduled", entries: ReadonlyArray<ArdudBoardEntry>) =>
        run<ArdudBoardClearResult>("/clear", { lane, entries: entries.slice(0, 500).map(token) }),
    }),
    [run],
  );

  return { state, actions, refresh: pullToRefresh, refreshing };
}

export type BoardCandidate = BoardConnection & {
  readonly environmentId: EnvironmentId;
  readonly label: string;
};

/**
 * With several bearer environments, probes each once and returns the board
 * status per environment so the screen can open the first that has a board.
 */
export function useBoardProbe(candidates: ReadonlyArray<BoardCandidate>) {
  // Probe again only when an environment, URL or token changes, not on every
  // connection-state render.
  const key = JSON.stringify(
    candidates.map(({ environmentId, httpBaseUrl, bearerToken }) => ({
      environmentId,
      httpBaseUrl,
      bearerToken,
    })),
  );
  const [probe, setProbe] = useState<{
    readonly key: string;
    readonly results: ReadonlyMap<EnvironmentId, "board" | "none" | "error">;
  }>({ key: "", results: new Map() });
  useEffect(() => {
    const current = JSON.parse(key) as ReadonlyArray<
      BoardConnection & { readonly environmentId: EnvironmentId }
    >;
    if (current.length < 2) return;
    const controller = new AbortController();
    for (const candidate of current) {
      void probeBoard(candidate, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setProbe((previous) => ({
          key,
          results: new Map(previous.key === key ? previous.results : []).set(
            candidate.environmentId,
            result,
          ),
        }));
      });
    }
    return () => controller.abort();
  }, [key]);
  return probe.key === key ? probe.results : EMPTY_PROBE;
}

const EMPTY_PROBE: ReadonlyMap<EnvironmentId, "board" | "none" | "error"> = new Map();
