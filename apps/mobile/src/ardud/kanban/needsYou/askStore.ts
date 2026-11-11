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
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../../state/atom-registry";
import { serverEnvironment } from "../../../state/server";
import { environmentSession } from "../../../state/session";
import { pairedEnvironmentIdAtom } from "../../common/environment";
import { kanbanClient } from "../kanbanStore";
import { createAskScopes, type AskScope } from "./askScope";
import {
  lateStanding,
  ownerStanding,
  type LateStanding,
  type OwnerStanding,
  type SessionRead,
} from "./logic";

/** What the app holds of a server's session, as `ownerStanding` reads it. */
const sessionRead = (result: AsyncResult.AsyncResult<AuthSessionState, unknown>): SessionRead => {
  const session = Option.getOrNull(AsyncResult.value(result));
  return session !== null
    ? { state: "read", authenticated: session.authenticated, owner: session.owner }
    : result._tag === "Failure" && !result.waiting
      ? { state: "failed" }
      : { state: "reading" };
};

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
  // The session as the app holds it at this moment: the owner's, and read. A
  // refusal the store met since is the scope's own to check.
  owner: (environmentId) =>
    ownerStanding(
      sessionRead(
        appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId as EnvironmentId)),
      ),
      false,
    ) === "owner",
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

/**
 * For a screen that waits on a call: read it when the call comes back, before
 * anything is done with the result. It answers for the server and the screen
 * that started the call, not for whatever is in use or in front by then.
 */
export function useLateStanding(): () => LateStanding {
  const scope = useAskScope();
  const navigation = useNavigation();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(
    () =>
      lateStanding({
        live: scope.live(),
        mounted: mounted.current,
        focused: navigation.isFocused(),
      }),
    [scope, navigation],
  );
}

const NO_SESSION = Atom.make(AsyncResult.initial<AuthSessionState>());

/**
 * Whether this phone may answer, from the session the app already holds
 * (`GET /api/auth/session` carries `owner`). Answering, replying, hand-over,
 * snooze and batches are on only for `owner`: while the session is still being
 * read, or could not be read, the asks can be read and nothing can be sent.
 * `recheck` reads the session again. It also tells the store, so a phone that
 * is not paired as his says so before he fills anything in.
 */
export function useOwnerStanding(): {
  readonly standing: OwnerStanding;
  readonly recheck: () => void;
} {
  const { asks, environmentId } = useAskScope();
  const atom =
    environmentId === null
      ? NO_SESSION
      : environmentSession.sessionStateAtom(environmentId as EnvironmentId);
  const result = useAtomValue(atom);
  const refused = useAsk((state) => state.notOwner !== null);
  const read = sessionRead(result);
  const owner = read.state === "read" && read.authenticated ? read.owner : undefined;
  useEffect(() => asks.noteOwnerStanding(owner), [asks, owner]);
  const recheck = useCallback(() => appAtomRegistry.refresh(atom), [atom]);
  return { standing: ownerStanding(read, refused), recheck };
}

/** Keeps the feed current while a screen shows it. `fast`: the queue or an ask is open. */
export function useWatchAsks(fast: boolean): void {
  const asks = useAsks();
  useEffect(() => asks.watchAsks(fast), [asks, fast]);
}
