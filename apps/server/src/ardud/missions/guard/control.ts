/**
 * The control API (HTTP bearer tokens: the CLI, bridges, coord) is not the
 * owner. Its writes are stamped `system`, the authenticated session is kept
 * beside them, and an answer to a pending request is judged like any other
 * send before the request changes state. The exceptions are the iMessage
 * bridge relaying an inbound that verifies as the owner's or Moni's
 * (`imessage.ts`), and the Telegram bridge answering a pending request: it
 * takes updates from his own chat only, so that answer is his.
 */
import type { MissionProvenance, ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import { guardSender, type SendGuardFailed, type SendRefused } from "../router/guardPaths.ts";
import type { AuthorityKind, AuthorityStore } from "./authority.ts";
import { sessionPrincipal, type GuardPrincipal, type WsSession } from "./principal.ts";
import { requestAnswerText } from "./requests.ts";

type ControlSession = WsSession;

/** The component credential the Telegram bridge runs as (`auth/components.ts`). */
const TELEGRAM_BRIDGE = "telegram-bridge";

/**
 * The owner, when the Telegram bridge answers a pending request. The bridge
 * only accepts updates from his bound chat, and only Robob issues its
 * credential, so the answer is his, typed on his phone. `sessionId` keeps
 * which credential carried it.
 */
export const telegramAnswerOwner = (session: ControlSession): MissionProvenance | null =>
  session.origin?._tag === "component" && session.origin.component === TELEGRAM_BRIDGE
    ? { _tag: "owner-app", surface: "mobile", sessionId: session.sessionId }
    : null;

/** What the control API writes as. Named component identities come from core. */
export const CONTROL_ACTOR = "system" as const;

/** How a control write is stamped: `user` only for words of his a bridge carried. */
export const controlActor = (owner: MissionProvenance | null): "user" | typeof CONTROL_ACTOR =>
  owner === null ? CONTROL_ACTOR : "user";

/**
 * Who a control write is from: the session, or the owner when a bridge
 * carried words of his (see `imessage.ts`, `telegramAnswerOwner`).
 */
export const controlPrincipal = (
  session: ControlSession,
  owner?: MissionProvenance | null,
): GuardPrincipal =>
  owner == null ? sessionPrincipal(session) : { _tag: "owner", provenance: owner };

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
