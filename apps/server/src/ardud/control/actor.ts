/**
 * The control API (HTTP bearer tokens: the CLI, bridges, coord) is not the
 * owner, so its writes are stamped `system`. The one exception is the
 * Telegram bridge answering a pending request: it takes updates from his own
 * chat only, so that answer is his.
 */
import type { OriginSession, OwnerProvenance } from "../auth/provenance.ts";

/** The component credential the Telegram bridge runs as (`auth/components.ts`). */
const TELEGRAM_BRIDGE = "telegram-bridge";

/**
 * The owner, when the Telegram bridge answers a pending request. The bridge
 * only accepts updates from his bound chat, and only Robob issues its
 * credential, so the answer is his, typed on his phone. `sessionId` keeps
 * which credential carried it.
 */
export const telegramAnswerOwner = (session: OriginSession): OwnerProvenance | null =>
  session.origin?._tag === "component" && session.origin.component === TELEGRAM_BRIDGE
    ? { _tag: "owner-app", surface: "mobile", sessionId: session.sessionId }
    : null;

/** What the control API writes as. */
export const CONTROL_ACTOR = "system" as const;

/** How a control write is stamped: `user` only for words of his a bridge carried. */
export const controlActor = (owner: OwnerProvenance | null): "user" | typeof CONTROL_ACTOR =>
  owner === null ? CONTROL_ACTOR : "user";
