/**
 * The control API (HTTP bearer tokens: the CLI, bridges, coord) is not the
 * owner. Its writes are stamped `system`, the authenticated session is kept
 * beside them, and an answer to a pending request is judged like any other
 * send before the request changes state. The one exception is the iMessage
 * bridge relaying an inbound that verifies as the owner's or Moni's
 * (`imessage.ts`): that write is his.
 */
import type { MissionProvenance, ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import { guardSender, type SendGuardFailed, type SendRefused } from "../router/guardPaths.ts";
import type { AuthorityKind, AuthorityStore } from "./authority.ts";
import type { GuardPrincipal } from "./principal.ts";
import { requestAnswerText } from "./requests.ts";

interface ControlSession {
  readonly sessionId: string;
  readonly subject: string;
  readonly clientLabel?: string;
}

/** What the control API writes as. Named component identities come from core. */
export const CONTROL_ACTOR = "system" as const;

/** How a control write is stamped: `user` only for a verified iMessage of his. */
export const controlActor = (owner: MissionProvenance | null): "user" | typeof CONTROL_ACTOR =>
  owner === null ? CONTROL_ACTOR : "user";

/**
 * Who a control write is from: the session, or the owner when the iMessage
 * bridge relayed a verified inbound of his (see `imessage.ts`).
 */
export const controlPrincipal = (
  session: ControlSession,
  owner?: MissionProvenance | null,
): GuardPrincipal =>
  owner == null
    ? {
        _tag: "session",
        sessionId: session.sessionId,
        subject: session.subject,
        ...(session.clientLabel ? { label: session.clientLabel } : {}),
      }
    : { _tag: "owner", provenance: owner };

/**
 * An answer from a control session reaches the agent as provider input or as
 * a message, so the guard sees it before the request is resolved. A routed or
 * knocked answer leaves the request pending.
 */
export const guardControlRespond = (input: {
  readonly session: ControlSession;
  readonly owner?: MissionProvenance | null | undefined;
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
    from: controlPrincipal(input.session, input.owner),
    text: requestAnswerText(input),
    requestKey: input.commandId,
  });

/** Keeps the session that wrote a control-API message or thread. */
export const recordControlWrite = (
  store: AuthorityStore,
  kind: Extract<AuthorityKind, "message" | "thread">,
  subjectId: string,
  session: ControlSession,
  owner?: MissionProvenance | null,
): Effect.Effect<void> => store.record(kind, subjectId, controlPrincipal(session, owner));
