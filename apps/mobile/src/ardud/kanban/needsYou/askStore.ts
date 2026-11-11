/**
 * The phone's Needs-you store: the same store the web page runs
 * (`createAskStore` in the shared runtime), given the app's foreground signal
 * and the board list feed. There is one store per server (`askScope.ts`): a
 * screen takes the store of the server in use when it renders and keeps
 * talking to that one, so an answer, a retry or a secret can only ever go to
 * the server it was made for. When the server changes the old store is closed
 * and emptied, and the screens start over on the new one.
 *
 * Nothing here is written to disk: forms, held answers and failed sends live
 * in memory only, and a secret never enters the store at all.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AskApiError,
  type AskSecretSendResult,
  type AskState,
  type AskStore,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AuthSessionState, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../../state/atom-registry";
import { serverEnvironment } from "../../../state/server";
import { environmentSession } from "../../../state/session";
import { pairedEnvironmentIdAtom } from "../../common/environment";
import { kanbanClient } from "../kanbanStore";
import { createAskScopes, type AskScope } from "./askScope";

const askScopes = createAskScopes({
  paired: () => appAtomRegistry.get(pairedEnvironmentIdAtom),
  onPairedChange: (run) => appAtomRegistry.subscribe(pairedEnvironmentIdAtom, run),
  target: (environmentId) => {
    const connection = Option.getOrNull(
      appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(environmentId as EnvironmentId),
      ),
    );
    if (connection === null) throw new AskApiError(0, "offline", "Not connected to Robob.");
    const authorization = connection.httpAuthorization;
    if (authorization !== null && authorization._tag === "Bearer") {
      return {
        base: connection.httpBaseUrl,
        headers: { authorization: `Bearer ${authorization.token}` },
        cookies: false,
      };
    }
    throw new AskApiError(0, "unsupported", "This connection can't reach the ask routes.");
  },
  sendSecrets: async (environmentId, input): Promise<AskSecretSendResult> => {
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.answerAskSecrets,
      { environmentId: environmentId as EnvironmentId, input },
      // The failure cause holds the request; keep it out of the console and reports.
      { label: "answer ask secrets", reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Success") return { _tag: "sent" };
    if (isAtomCommandInterrupted(result)) return { _tag: "interrupted" };
    return { _tag: "failed", failure: squashAtomCommandFailure(result) };
  },
  watch: {
    onBoardsChange: (run) => kanbanClient().boards.subscribe(run),
    onForeground: (run) => {
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") run();
      });
      return () => subscription.remove();
    },
    isForeground: () => AppState.currentState === "active",
  },
  // After the store update that asked for it has settled, not inside it.
  defer: (run) => setTimeout(run, 0),
  now: () => Date.now(),
});

// He leaves the app inside the six seconds an answer is held: it goes out now
// rather than waiting on a timer the system may never run.
AppState.addEventListener("change", (state) => {
  if (state === "background" || state === "inactive") {
    askScopes.current().asks.flushAskSends(true);
  }
});

/**
 * The store, state and server calls of the server in use. A component keeps
 * the one it rendered with, so whatever it starts (a send, an upload that
 * lands later, a secret) stays with that server; once the server changes
 * those calls do nothing. `serial` is new for every server: key a screen's
 * inner part on it so its own state starts over too.
 */
export function useAskScope(): AskScope {
  return useSyncExternalStore(askScopes.subscribe, askScopes.current);
}

/** The ask store of the server in use; see `useAskScope`. */
export function useAsks(): AskStore {
  return useAskScope().asks;
}

/** The server the asks on screen were read from: their files and threads are fetched there. */
export function useAskEnvironmentId(): EnvironmentId | null {
  return useAskScope().environmentId as EnvironmentId | null;
}

/** Reads one thing from the store; `select` must return the same value for the same state. */
export function useAsk<T>(select: (state: AskState) => T): T {
  const { cell } = useAskScope();
  return useSyncExternalStore(cell.subscribe, () => select(cell.getState()));
}

/**
 * For a screen that holds secrets in its own state: `drop` clears them. It is
 * called first of all when the server changes, before the store is emptied.
 */
export function useAskSecretsHeld(drop: () => void): void {
  useEffect(() => askScopes.holdSecrets(drop), [drop]);
}

const NO_SESSION = Atom.make(AsyncResult.initial<AuthSessionState>());

/**
 * Whether this phone's session is the owner's, from the session the app
 * already holds (`GET /api/auth/session` carries `owner`). Tells the store, so
 * a phone that is not paired as his says so before he fills anything in.
 */
export function useOwnerStanding(): void {
  const { asks, environmentId } = useAskScope();
  const result = useAtomValue(
    environmentId === null
      ? NO_SESSION
      : environmentSession.sessionStateAtom(environmentId as EnvironmentId),
  );
  const session = Option.getOrNull(AsyncResult.value(result));
  const owner = session?.authenticated ? session.owner : undefined;
  useEffect(() => asks.noteOwnerStanding(owner), [asks, owner]);
}

/** Keeps the feed current while a screen shows it. `fast`: the queue or an ask is open. */
export function useWatchAsks(fast: boolean): void {
  const asks = useAsks();
  useEffect(() => asks.watchAsks(fast), [asks, fast]);
}
