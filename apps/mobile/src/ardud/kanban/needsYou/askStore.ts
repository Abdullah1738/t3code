/**
 * The phone's Needs-you store: the same store the web page runs
 * (`createAskStore` in the shared runtime), given the phone's paired server,
 * the app's foreground signal and the board list feed. Nothing here is written
 * to disk: forms, held answers and failed sends live in memory only, and a
 * secret never enters the store at all.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AskApiError,
  createAskApi,
  createAskStateCell,
  createAskStore,
  type AskSecretSendResult,
  type AskState,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AuthSessionState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../../state/atom-registry";
import { serverEnvironment } from "../../../state/server";
import { environmentSession } from "../../../state/session";
import { pairedEnvironmentIdAtom, usePairedEnvironmentId } from "../../common/environment";
import { kanbanClient } from "../kanbanStore";
import { unreachedRetryGate } from "./logic";

export const askApi = createAskApi({
  target: () => {
    const environmentId = appAtomRegistry.get(pairedEnvironmentIdAtom);
    const connection =
      environmentId === null
        ? null
        : Option.getOrNull(
            appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
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
  answerSecrets: async (input): Promise<AskSecretSendResult> => {
    const environmentId = appAtomRegistry.get(pairedEnvironmentIdAtom);
    if (environmentId === null) return { _tag: "offline" };
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.answerAskSecrets,
      { environmentId, input },
      // The failure cause holds the request; keep it out of the console and reports.
      { label: "answer ask secrets", reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Success") return { _tag: "sent" };
    if (isAtomCommandInterrupted(result)) return { _tag: "interrupted" };
    return { _tag: "failed", failure: squashAtomCommandFailure(result) };
  },
});

const cell = createAskStateCell();

export const asks = createAskStore({
  api: askApi,
  cell,
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
});

export const askState = cell.getState;

/** Reads one thing from the store; `select` must return the same value for the same state. */
export function useAsk<T>(select: (state: AskState) => T): T {
  return useSyncExternalStore(cell.subscribe, () => select(cell.getState()));
}

// He leaves the app inside the six seconds an answer is held: it goes out now
// rather than waiting on a timer the system may never run.
AppState.addEventListener("change", (state) => {
  if (state === "background" || state === "inactive") asks.flushAskSends(true);
});

// An answer made offline is kept in memory as "not sent". When the feed reads
// again after failing, the server is back: such answers go once more, by
// themselves. Answers the server refused never do.
const gate = unreachedRetryGate();
cell.subscribe(() => {
  const state = cell.getState();
  const unreached = Object.values(state.failed).some((failed) => failed.unreached === true);
  if (!gate.next({ reading: state.status === "ready" && state.error === null, unreached })) return;
  // After this store update has settled, not inside it.
  setTimeout(() => asks.retryUnreachedAskSends(), 0);
});

const NO_SESSION = Atom.make(AsyncResult.initial<AuthSessionState>());

/**
 * Whether this phone's session is the owner's, from the session the app
 * already holds (`GET /api/auth/session` carries `owner`). Tells the store, so
 * a phone that is not paired as his says so before he fills anything in.
 */
export function useOwnerStanding(): void {
  const environmentId = usePairedEnvironmentId();
  const result = useAtomValue(
    environmentId === null ? NO_SESSION : environmentSession.sessionStateAtom(environmentId),
  );
  const session = Option.getOrNull(AsyncResult.value(result));
  const owner = session?.authenticated ? session.owner : undefined;
  useEffect(() => asks.noteOwnerStanding(owner), [owner]);
}

/** Keeps the feed current while a screen shows it. `fast`: the queue or an ask is open. */
export function useWatchAsks(fast: boolean): void {
  useEffect(() => asks.watchAsks(fast), [fast]);
}
