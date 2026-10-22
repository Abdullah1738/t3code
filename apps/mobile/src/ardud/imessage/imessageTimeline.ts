import type { IMessageTimelineEntry } from "@t3tools/client-runtime/ardud/imessage";
import { turnItemIsWorkspacePreparation } from "@t3tools/client-runtime/state/turn-item-presentation";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { mcpAppFromToolItem, threadHtmlRenders } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";

import { toFeedActivity } from "../../lib/threadActivity";

// Same split as web's timeline: these items are standalone events, not work steps.
const EVENT_ITEM_TYPES: ReadonlySet<string> = new Set([
  "fork",
  "handoff",
  "run_interrupt_request",
  "run_interrupt_result",
  "secret_request",
  "subagent",
]);

/**
 * Turn items in the shape the shared iMessage rows read. Built from the items
 * rather than mobile's thread feed: the feed drops empty drafts and folds
 * delegate calls, and an empty final draft has to stay visible so the turn
 * reads as not sent instead of promoting an earlier draft to the reply.
 */
export function imessageTimelineEntries(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<IMessageTimelineEntry> {
  const foldedAnswerMessageIds = new Set(
    visibleTurnItems.flatMap(({ item }) =>
      item.type === "user_input_request" && item.questionAnswer
        ? [`async-answer:${item.questionAnswer.requestId}`]
        : [],
    ),
  );
  const htmlRenders = threadHtmlRenders(visibleTurnItems.map(({ item }) => item));
  const entries: IMessageTimelineEntry[] = [];
  for (const row of visibleTurnItems) {
    const { item } = row;
    if (turnItemIsWorkspacePreparation(item)) continue;
    if (item.type === "todo_list" || item.type === "checkpoint") continue;
    if (item.type === "user_message" && foldedAnswerMessageIds.has(item.messageId)) continue;
    const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
    if (item.type === "user_message" || item.type === "assistant_message") {
      entries.push({
        id: item.messageId,
        kind: "message",
        createdAt,
        message: {
          id: item.messageId,
          role: item.type === "user_message" ? "user" : "assistant",
          text: item.text,
          runId: item.runId,
          streaming: item.type === "assistant_message" && item.streaming,
          ...(item.type === "user_message"
            ? { createdBy: item.createdBy, ...(item.context ? { context: item.context } : {}) }
            : {}),
          createdAt,
          updatedAt: DateTime.formatIso(item.updatedAt),
        },
      });
      continue;
    }
    if (item.type === "proposed_plan") {
      entries.push({
        id: item.id,
        kind: "proposed-plan",
        createdAt,
        proposedPlan: { runId: item.runId, planMarkdown: item.markdown },
      });
      continue;
    }
    const isMcpApp =
      item.type === "dynamic_tool" &&
      item.status === "completed" &&
      mcpAppFromToolItem(item) !== undefined;
    if (htmlRenders.has(item) || isMcpApp) {
      entries.push({
        id: item.id,
        kind: htmlRenders.has(item) ? "html-render" : "mcp-app",
        createdAt,
        runId: item.runId,
      });
      continue;
    }
    if (EVENT_ITEM_TYPES.has(item.type)) {
      entries.push({ id: item.id, kind: "event", createdAt, projectedItem: row });
      continue;
    }
    const work = workEntry(row);
    entries.push({
      id: item.id,
      kind: "work",
      createdAt,
      entry: {
        id: item.id,
        runId: item.runId,
        label: work.label,
        tone: work.tone,
        command: work.command,
        detail: stepDetail(item.type, work.label, work.detail),
        structuredPayload: item,
      },
    });
  }
  return entries;
}

// The feed's preview repeats a notice's label and shows a created thread's raw id;
// neither says more when the step is opened.
function stepDetail(type: string, label: string, detail: string | undefined) {
  if (type === "thread_created" || detail === label) return undefined;
  return detail;
}

// Rows keep their identity until the item changes, so a streamed chunk only
// re-derives the step that moved.
const workEntries = new WeakMap<
  OrchestrationV2ProjectedTurnItem,
  ReturnType<typeof toFeedActivity>["workEntry"]
>();

function workEntry(row: OrchestrationV2ProjectedTurnItem) {
  const cached = workEntries.get(row);
  if (cached !== undefined) return cached;
  const entry = toFeedActivity(row, null).workEntry;
  workEntries.set(row, entry);
  return entry;
}
