/**
 * Who is asking, as the guard sees it. Every entry point that can put text into
 * a thread or change something that later will (a schedule, a pull request
 * watch, a fork) names its caller here from the authenticated transport only,
 * never from the request body.
 */
import type { ClientSurface, OrchestrationV2Actor, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

import { ownerAppProvenance } from "../core/provenance.ts";
import type { ScheduleCreator, SendSender } from "../router/model.ts";

/** A sender that is a party, not a schedule firing on someone's behalf. */
export type GuardPrincipal = Exclude<SendSender, { readonly _tag: "schedule" }>;

/**
 * The principal behind the current request. Transports provide it around the
 * service calls they make (WS scheduled task RPCs, MCP schedule tools, the
 * schedule import route). Unset means an in-process caller, such as master
 * succession moving schedules, which the guard trusts.
 */
export const CurrentPrincipal = Context.Reference<GuardPrincipal | undefined>(
  "t3/ardud/missions/guard/CurrentPrincipal",
  { defaultValue: () => undefined },
);

/** The authenticated session, typed as core's owner check reads it. */
export type WsSession = Parameters<typeof ownerAppProvenance>[0]["session"];

/**
 * Classifies a WS session once. Only a paired Robob client (see
 * `ownerAppProvenance`, which core r3 moves to the origin claim) is the owner;
 * every other bearer, such as the CLI or a control token, is a session.
 */
export const wsPrincipal = (input: {
  readonly surface: ClientSurface | undefined;
  readonly session: WsSession;
}): GuardPrincipal => {
  const provenance = ownerAppProvenance(input);
  return provenance === null
    ? { _tag: "session", sessionId: input.session.sessionId, subject: input.session.subject }
    : { _tag: "owner", provenance };
};

/** How a write by this principal is stamped on the thread timeline. */
export const principalActor = (principal: GuardPrincipal): OrchestrationV2Actor => {
  switch (principal._tag) {
    case "owner":
      return "user";
    case "thread":
      return "agent";
    case "session":
    case "mcp-client":
      return "system";
  }
};

/** A stable identity string, for idempotency keys. */
export const principalKey = (principal: GuardPrincipal): string => {
  switch (principal._tag) {
    case "owner":
      return "owner";
    case "thread":
      return `thread:${principal.threadId}`;
    case "session":
    case "mcp-client":
      return `${principal._tag}:${principal.sessionId}`;
  }
};

/** The same party, compared by identity rather than label. */
export const samePrincipal = (left: GuardPrincipal, right: GuardPrincipal): boolean => {
  switch (left._tag) {
    case "owner":
      return right._tag === "owner";
    case "thread":
      return right._tag === "thread" && right.threadId === left.threadId;
    case "session":
      return right._tag === "session" && right.sessionId === left.sessionId;
    case "mcp-client":
      return right._tag === "mcp-client" && right.sessionId === left.sessionId;
  }
};

/**
 * The sender a schedule run (or a pull request watch wake) speaks as. The
 * owner's and the target's own records pass as schedule senders; any other
 * thread is that thread speaking, so the router checks its membership; a
 * session or client speaks as itself; nothing recorded is never self.
 */
export const recordedSender = (input: {
  readonly authority: GuardPrincipal | null;
  readonly targetThreadId: ThreadId;
  readonly scheduledTaskId: string;
  readonly title: string;
}): SendSender => {
  const { authority } = input;
  const schedule = (creator: ScheduleCreator | null): SendSender => ({
    _tag: "schedule",
    scheduledTaskId: input.scheduledTaskId,
    title: input.title,
    creator,
  });
  if (authority === null) return schedule(null);
  switch (authority._tag) {
    case "owner":
      return schedule({ _tag: "owner" });
    case "thread":
      return authority.threadId === input.targetThreadId
        ? schedule({ _tag: "thread", threadId: authority.threadId })
        : authority;
    case "session":
    case "mcp-client":
      return authority;
  }
};
