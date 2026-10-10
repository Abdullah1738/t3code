/**
 * Maps OpenCode 2 sessions and messages onto T3 threads and runless history
 * items. Pure, so the importer and its tests share one mapping.
 */
import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  type ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { openCodeToolTurnItem } from "@t3tools/provider-opencode/server/toolItems";
import { subagentThreadTitle } from "@t3tools/provider-core/server/subagentProjection";
import type { OpenCodeMessage, OpenCodePart, OpenCodeSession } from "./OpenCodeHttp.ts";

export const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
export const IMPORT_PREFIX = "ardud-opencode-import";
/**
 * Robob's iMessage sessions live here (moved out of `chats/` on 2026-10-02);
 * `chats/` now only holds desktop chats.
 */
export const IMESSAGE_ROOT = "/Users/ardud/.config/openchamber/imessage/";
const MAX_TOOL_OUTPUT_CHARS = 4_000;

/** One stable thread per native session, so a re-run lands on the same thread. */
export const importedThreadId = (sessionId: string) =>
  ThreadId.make(`${IMPORT_PREFIX}:thread:${sessionId}`);

/**
 * Per-session scratch folders group under one project each, instead of one
 * project per folder: OpenChamber's dated chat and iMessage folders.
 */
const GROUPED_ROOTS: ReadonlyArray<{ readonly prefix: string; readonly title: string }> = [
  { prefix: "/Users/ardud/.config/openchamber/chats", title: "Chats" },
  { prefix: "/Users/ardud/.config/openchamber/imessage", title: "iMessage" },
];

/**
 * The T3 project a session belongs to: a grouped scratch root, else its
 * OpenCode project's root (a repo's subfolders and worktrees stay with the
 * repo), else its own directory. The thread then runs in the session's own
 * directory as its worktree path.
 */
export function projectRootFor(
  session: OpenCodeSession,
  canonical: string | undefined,
): { readonly path: string; readonly title: string } {
  const directory = session.location.directory.replace(/\/+$/, "") || "/";
  for (const root of GROUPED_ROOTS) {
    if (directory === root.prefix || directory.startsWith(`${root.prefix}/`)) {
      return { path: root.prefix, title: root.title };
    }
  }
  const root = canonical !== undefined && canonical !== "/" ? canonical : directory;
  return { path: root, title: root.split("/").findLast(Boolean) ?? root };
}

/** 'imessage' for iMessage sessions, else the OpenChamber origin tag, else none. */
export function sessionOrigin(session: OpenCodeSession): string | null {
  const openchamber = session.metadata?.["openchamber"];
  const origin =
    typeof openchamber === "object" && openchamber !== null
      ? (openchamber as Record<string, unknown>)["origin"]
      : undefined;
  if (typeof origin === "string" && origin.trim().length > 0) return origin.trim();
  if (session.location.directory.startsWith(IMESSAGE_ROOT)) return "imessage";
  return null;
}

export function sessionTitle(session: OpenCodeSession): string {
  const title = session.title?.trim() ?? "";
  return title.length === 0 ? "Untitled session" : title.slice(0, 500);
}

/**
 * The session's last model as a T3 selection on `instanceId`, keeping its
 * variant. A model OpenCode no longer offers falls back to the default.
 */
export function sessionModelSelection(
  session: OpenCodeSession,
  instanceId: ProviderInstanceId,
  fallback: ModelSelection,
  available?: ReadonlySet<string>,
): ModelSelection {
  const model = session.model;
  if (
    model === undefined ||
    !model.providerID ||
    !model.id ||
    (available !== undefined &&
      available.size > 0 &&
      !available.has(`${model.providerID}/${model.id}`))
  ) {
    return fallback.instanceId === instanceId ? fallback : { instanceId, model: fallback.model };
  }
  return {
    instanceId,
    model: `${model.providerID}/${model.id}`,
    ...(model.variant === undefined || model.variant === "default"
      ? {}
      : { options: [{ id: "variant", value: model.variant }] }),
  };
}

export const millis = (value: number) => DateTime.makeUnsafe(value);

function toolOutput(state: OpenCodePart["state"]): string | undefined {
  if (state === undefined) return undefined;
  if (state.status === "error") {
    const error = state.error;
    if (typeof error === "string") return error;
    const message =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)["message"]
        : undefined;
    return typeof message === "string" ? message : "Tool failed.";
  }
  const text = (state.content ?? [])
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
  if (text.length === 0) return undefined;
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[output truncated]`
    : text;
}

function partText(part: OpenCodePart): string {
  return part.text ?? "";
}

function toolInput(part: OpenCodePart): Record<string, unknown> {
  const input = part.state?.input;
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

interface Draft {
  readonly key: string;
  readonly at: DateTime.Utc;
  readonly message?: OrchestrationV2ConversationMessage;
  readonly item: (base: ItemBase) => OrchestrationV2TurnItem;
}

type ItemBase = {
  readonly id: TurnItemId;
  readonly threadId: ThreadId;
  readonly runId: null;
  readonly nodeId: null;
  readonly providerThreadId: null;
  readonly providerTurnId: null;
  readonly nativeItemRef: null;
  readonly parentItemId: null;
  readonly ordinal: number;
  readonly status: "completed";
  readonly title: string | null;
  readonly startedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
};

/** A `subagent` call's child session, from the call's metadata or its reply. */
export function subagentSessionId(part: OpenCodePart): string | undefined {
  if (part.type !== "tool") return undefined;
  if (part.name !== "subagent" && part.name !== "task") return undefined;
  const metadata = part.state?.metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const id = (metadata as Record<string, unknown>)["sessionID"];
    if (typeof id === "string" && id.startsWith("ses_")) return id;
  }
  const text = (part.state?.content ?? []).map((entry) => entry.text ?? "").join("\n");
  return /\bsessionID[:=]?\s*"?(ses_[A-Za-z0-9]+)/.exec(text)?.[1];
}

export interface HistoryContext {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly childThreadId: (sessionId: string) => ThreadId;
}

/** The subagent sessions a transcript started, one entry per child session. */
export function subagentCalls(
  context: HistoryContext & { readonly messages: ReadonlyArray<OpenCodeMessage> },
): ReadonlyArray<{
  readonly sessionId: string;
  readonly childThreadId: ThreadId;
  readonly title: string;
  readonly at: DateTime.Utc;
}> {
  const calls = new Map<
    string,
    { sessionId: string; childThreadId: ThreadId; title: string; at: DateTime.Utc }
  >();
  for (const message of context.messages) {
    if (message.type !== "assistant") continue;
    for (const part of message.content ?? []) {
      const sessionId = subagentSessionId(part);
      if (sessionId === undefined || calls.has(sessionId)) continue;
      const input = toolInput(part);
      const description = input["description"];
      const prompt = input["prompt"];
      calls.set(sessionId, {
        sessionId,
        childThreadId: context.childThreadId(sessionId),
        title: subagentThreadTitle({
          parentTitle: "Subagent",
          title: typeof description === "string" ? description : null,
          prompt: typeof prompt === "string" ? prompt : "",
          ordinal: calls.size + 1,
        }),
        at: millis(message.time.created),
      });
    }
  }
  return [...calls.values()];
}

/** The history rows one OpenCode message becomes, before ordinals are assigned. */
function draftsFor(context: HistoryContext, message: OpenCodeMessage): Array<Draft> {
  const { threadId } = context;
  const at = millis(message.time.created);
  const conversation = (
    key: string,
    role: "user" | "assistant",
    text: string,
  ): OrchestrationV2ConversationMessage => ({
    createdBy: role === "user" ? "user" : "agent",
    creationSource: "provider",
    id: MessageId.make(`${IMPORT_PREFIX}:message:${threadId}:${key}`),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  });

  switch (message.type) {
    case "user": {
      const text = message.text ?? "";
      if (text.trim().length === 0) return [];
      const conv = conversation(message.id, "user", text);
      return [
        {
          key: message.id,
          at,
          message: conv,
          item: (base) => ({
            ...base,
            createdBy: "user",
            creationSource: "provider",
            type: "user_message",
            messageId: conv.id,
            inputIntent: "turn_start",
            text,
            attachments: [],
          }),
        },
      ];
    }
    case "assistant": {
      const drafts: Array<Draft> = [];
      (message.content ?? []).forEach((part, index) => {
        const key = `${message.id}:${index}`;
        if (part.type === "text") {
          const text = partText(part);
          if (text.trim().length === 0) return;
          const conv = conversation(key, "assistant", text);
          drafts.push({
            key,
            at,
            message: conv,
            item: (base) => ({
              ...base,
              type: "assistant_message",
              messageId: conv.id,
              text,
              streaming: false,
            }),
          });
        } else if (part.type === "reasoning") {
          const text = partText(part);
          if (text.trim().length === 0) return;
          drafts.push({
            key,
            at,
            item: (base) => ({ ...base, type: "reasoning", text, streaming: false }),
          });
        } else if (part.type === "tool") {
          const tool = part;
          const name = tool.name ?? "tool";
          const input = toolInput(tool);
          const output = toolOutput(tool.state);
          const childSession = subagentSessionId(part);
          if (childSession !== undefined) {
            const description = input["description"];
            const prompt = input["prompt"];
            drafts.push({
              key,
              at,
              item: (base) => ({
                ...base,
                title: typeof description === "string" ? description : "Subagent",
                status: tool.state?.status === "error" ? "failed" : "completed",
                type: "subagent",
                subagentId: NodeId.make(`${IMPORT_PREFIX}:subagent:${threadId}:${key}`),
                origin: "provider_native",
                driver: OPENCODE_DRIVER,
                providerInstanceId: context.instanceId,
                childThreadId: context.childThreadId(childSession),
                prompt: typeof prompt === "string" ? prompt : "",
                result: output ?? null,
              }),
            });
            return;
          }
          drafts.push({
            key,
            at,
            item: (base) =>
              openCodeToolTurnItem(
                { ...base, title: name },
                {
                  name,
                  input,
                  output,
                  completedMetadata:
                    tool.state?.status === "completed" ? tool.state.metadata : undefined,
                },
              ),
          });
        }
      });
      if (message.error?.message && message.error.message.trim().length > 0) {
        const text = message.error.message;
        drafts.push({
          key: `${message.id}:error`,
          at,
          item: (base) => ({ ...base, type: "system_notice", message: text }),
        });
      }
      return drafts;
    }
    case "synthetic": {
      const text = message.text ?? "";
      if (text.trim().length === 0) return [];
      return [
        {
          key: message.id,
          at,
          item: (base) => ({
            ...base,
            title: "Notification",
            type: "system_notice",
            message:
              text.length > MAX_TOOL_OUTPUT_CHARS
                ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…`
                : text,
          }),
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * `message.updated` and `turn-item.updated` events for the messages, as
 * runless items at `firstOrdinal` onwards. Event ids derive from native ids,
 * so writing the same message twice is rejected by the event store.
 */
export function historyEvents(
  input: HistoryContext & {
    readonly messages: ReadonlyArray<OpenCodeMessage>;
    readonly firstOrdinal: number;
  },
): {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly positions: ReadonlyArray<{ readonly turnItemId: TurnItemId; readonly ordinal: number }>;
} {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const positions: Array<{ turnItemId: TurnItemId; ordinal: number }> = [];
  let ordinal = input.firstOrdinal;
  for (const message of input.messages) {
    for (const draft of draftsFor(input, message)) {
      const id = TurnItemId.make(`${IMPORT_PREFIX}:turn-item:${input.threadId}:${draft.key}`);
      const item = draft.item({
        id,
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: draft.at,
        completedAt: draft.at,
        updatedAt: draft.at,
      });
      if (draft.message !== undefined) {
        events.push({
          id: EventId.make(`${IMPORT_PREFIX}:message:${input.threadId}:${draft.key}`),
          type: "message.updated",
          threadId: input.threadId,
          occurredAt: draft.at,
          payload: draft.message,
        });
      }
      events.push({
        id: EventId.make(`${IMPORT_PREFIX}:turn-item:${input.threadId}:${draft.key}`),
        type: "turn-item.updated",
        threadId: input.threadId,
        occurredAt: draft.at,
        payload: item,
      });
      positions.push({ turnItemId: id, ordinal });
      ordinal += 1;
    }
  }
  return { events, positions };
}

/** A notice at the top of a long transcript that only shows its newest part. */
export function truncationNotice(input: {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly at: DateTime.Utc;
  readonly shown: number;
}): { readonly turnItemId: TurnItemId; readonly event: OrchestrationV2DomainEvent } {
  const turnItemId = TurnItemId.make(`${IMPORT_PREFIX}:turn-item:${input.threadId}:older`);
  return {
    turnItemId,
    event: {
      id: EventId.make(`${IMPORT_PREFIX}:turn-item:${input.threadId}:older`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: input.at,
      payload: {
        id: turnItemId,
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: "Earlier history",
        startedAt: input.at,
        completedAt: input.at,
        updatedAt: input.at,
        type: "system_notice",
        message: `Showing the last ${input.shown} OpenCode messages. Earlier messages stay in OpenCode session ${input.sessionId}; the agent still has the full context.`,
      },
    },
  };
}
