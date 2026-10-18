/**
 * The control API (HTTP bearer tokens: the CLI, bridges, coord) is never the
 * owner. Its writes are stamped `system`, the authenticated session is kept
 * beside them, and an answer to a pending request is judged like any other
 * send before the request changes state.
 */
import type { ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import { guardSender, type SendGuardFailed, type SendRefused } from "../router/guardPaths.ts";
import type { AuthorityKind, AuthorityStore } from "./authority.ts";
import type { GuardPrincipal } from "./principal.ts";
import { requestAnswerText } from "./requests.ts";

interface ControlSession {
  readonly sessionId: string;
  readonly subject: string;
}

/** What the control API writes as. Named component identities come from core. */
export const CONTROL_ACTOR = "system" as const;

export const controlPrincipal = (session: ControlSession): GuardPrincipal => ({
  _tag: "session",
  sessionId: session.sessionId,
  subject: session.subject,
});

/**
 * An answer from a control session reaches the agent as provider input or as
 * a message, so the guard sees it before the request is resolved. A routed or
 * knocked answer leaves the request pending.
 */
export const guardControlRespond = (input: {
  readonly session: ControlSession;
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly decision?: string | undefined;
  readonly answers?: Readonly<Record<string, unknown>> | undefined;
  readonly dismissed?: boolean | undefined;
  readonly commandId: string;
}): Effect.Effect<void, SendRefused | SendGuardFailed> =>
  guardSender({
    path: "request-respond",
    targetThreadId: input.threadId,
    from: controlPrincipal(input.session),
    text: requestAnswerText(input),
    requestKey: input.commandId,
  });

/** Keeps the session that wrote a control-API message or thread. */
export const recordControlWrite = (
  store: AuthorityStore,
  kind: Extract<AuthorityKind, "message" | "thread">,
  subjectId: string,
  session: ControlSession,
): Effect.Effect<void> => store.record(kind, subjectId, controlPrincipal(session));
