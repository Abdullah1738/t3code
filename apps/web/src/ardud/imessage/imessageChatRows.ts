import {
  classifyIMessageUserMessage,
  imessageDayKey,
  imessageGuidanceText,
  imessageSentReply,
} from "@t3tools/client-runtime/ardud/imessage";

import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";

/** One line in an agent row's details: a tool call, or a frame nobody typed. */
export interface IMessageAgentStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly error: boolean;
}

export type IMessageAgentOutcome = "replied" | "no-reply" | "working";

export type IMessageChatRow =
  | { readonly kind: "divider"; readonly id: string; readonly createdAt: string }
  | {
      readonly kind: "incoming";
      readonly id: string;
      readonly text: string;
      readonly sender: string | null;
      /** False when the previous bubble came from the same sender, so the name shows once. */
      readonly senderChanged: boolean;
      readonly voice: boolean;
      readonly quote: string | null;
      readonly createdAt: string;
    }
  | {
      readonly kind: "event";
      readonly id: string;
      readonly source: string;
      readonly title: string;
      readonly createdAt: string;
    }
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly steps: ReadonlyArray<IMessageAgentStep>;
      readonly outcome: IMessageAgentOutcome;
      readonly startedAt: string;
      readonly endedAt: string;
    }
  | {
      readonly kind: "reply";
      readonly id: string;
      readonly text: string;
      readonly createdAt: string;
    };

export interface IMessageChatRowOptions {
  /** Day of the thread rendered just above, so a divider marks only a real day change. */
  readonly previousDayKey: string | null;
  /** Non-owner chats carry each member's name in front of their text. */
  readonly namedSenders: boolean;
  /** The run still in progress, whose last assistant text may not be final yet. */
  readonly activeRunId: string | null;
}

interface Turn {
  readonly key: string;
  readonly entries: TimelineEntry[];
}

/**
 * Turns one thread's timeline into chat rows. Each run is one agent turn: what people
 * typed becomes incoming bubbles, watcher events a centred line, and only the run's
 * final assistant message is the reply that went out. Everything else sits in the
 * agent row's details.
 */
export function buildIMessageChatRows(
  entries: ReadonlyArray<TimelineEntry>,
  options: IMessageChatRowOptions,
): IMessageChatRow[] {
  const rows: IMessageChatRow[] = [];
  let dayKey = options.previousDayKey;
  let lastSender: string | null = null;

  for (const turn of splitTurns(entries)) {
    const first = turn.entries[0]!;
    const turnDay = imessageDayKey(first.createdAt);
    if (turnDay !== dayKey) {
      rows.push({ kind: "divider", id: `day:${first.id}`, createdAt: first.createdAt });
      dayKey = turnDay;
    }

    const steps: IMessageAgentStep[] = [];
    const assistants: ChatMessage[] = [];
    let endedAt = first.createdAt;
    for (const entry of turn.entries) {
      endedAt = later(
        endedAt,
        entry.kind === "message" ? entry.message.updatedAt : entry.createdAt,
      );
      if (entry.kind === "message") {
        const { message } = entry;
        if (message.role === "assistant") {
          assistants.push(message);
        } else if (message.role === "user") {
          lastSender = addUserMessage(message, options.namedSenders, lastSender, rows, steps);
        }
        continue;
      }
      steps.push(entryStep(entry));
    }

    const final = assistants[assistants.length - 1];
    const working =
      (options.activeRunId !== null && turn.key === options.activeRunId) ||
      (final?.streaming ?? false);
    for (const draft of working ? assistants : assistants.slice(0, -1)) {
      steps.push({ id: draft.id, label: "Text not sent", detail: draft.text, error: false });
    }
    const sent = !working && final !== undefined ? imessageSentReply(final.text) : null;
    if (!working && final !== undefined && sent === null && final.text.trim() !== "NO_REPLY") {
      steps.push({ id: final.id, label: "Text not sent", detail: final.text, error: false });
    }

    const outcome: IMessageAgentOutcome = working
      ? "working"
      : sent === null
        ? "no-reply"
        : "replied";
    if (steps.length > 0 || outcome !== "replied") {
      rows.push({
        kind: "agent",
        id: `agent:${turn.key}:${first.id}`,
        steps,
        outcome,
        startedAt: first.createdAt,
        endedAt,
      });
    }
    if (sent !== null && final !== undefined) {
      rows.push({ kind: "reply", id: final.id, text: sent, createdAt: final.createdAt });
      lastSender = null;
    }
  }
  return rows;
}

/** Runs split turns; entries without a run stay with the turn they arrived in. */
function splitTurns(entries: ReadonlyArray<TimelineEntry>): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    const runId = entryRunId(entry);
    const current = turns[turns.length - 1];
    if (current !== undefined && (runId === null || runId === current.key)) {
      current.entries.push(entry);
    } else {
      turns.push({ key: runId ?? entry.id, entries: [entry] });
    }
  }
  return turns;
}

function entryRunId(entry: TimelineEntry): string | null {
  switch (entry.kind) {
    case "message":
      return entry.message.runId;
    case "work":
      return entry.entry.runId ?? null;
    case "proposed-plan":
      return entry.proposedPlan.runId;
    case "html-render":
    case "mcp-app":
      return entry.runId;
    case "event":
      return entry.projectedItem.item.runId;
  }
}

function addUserMessage(
  message: ChatMessage,
  namedSenders: boolean,
  lastSender: string | null,
  rows: IMessageChatRow[],
  steps: IMessageAgentStep[],
): string | null {
  const guidance = imessageGuidanceText(message.text) ?? contextGuidance(message);
  if (guidance !== null) {
    steps.push({
      id: `${message.id}:guidance`,
      label: "Channel guidance",
      detail: guidance,
      error: false,
    });
  }

  const kind = classifyIMessageUserMessage({
    text: message.text,
    createdBy: message.createdBy,
    namedSenders,
  });
  switch (kind.kind) {
    case "watcher":
      rows.push({
        kind: "event",
        id: `${message.id}:event`,
        source: kind.source,
        title: kind.title,
        createdAt: message.createdAt,
      });
      steps.push({
        id: message.id,
        label: `Watcher event from ${kind.source}`,
        detail: message.text,
        error: false,
      });
      return lastSender;
    case "hidden":
      if (kind.reason !== "guidance") {
        steps.push({
          id: message.id,
          label: kind.reason === "agent" ? "Prompt from an agent" : "Bridge request",
          detail: message.text,
          error: false,
        });
      }
      return lastSender;
    case "typed": {
      let sender = lastSender;
      kind.parts.forEach((part, index) => {
        rows.push({
          kind: "incoming",
          id: `${message.id}:${index}`,
          text: part.text,
          sender: part.sender,
          senderChanged: part.sender !== sender,
          voice: part.voice,
          quote: index === 0 ? kind.quote : null,
          createdAt: message.createdAt,
        });
        sender = part.sender;
      });
      return sender;
    }
  }
}

/** Newer bridge versions move the guidance out of the text into a context record. */
function contextGuidance(message: ChatMessage): string | null {
  for (const record of message.context?.records ?? []) {
    if (record.kind !== "ardud-guidance" || !("payload" in record)) continue;
    const payload: unknown = record.payload;
    if (typeof payload === "object" && payload !== null && "text" in payload) {
      const text: unknown = payload.text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

function entryStep(entry: Exclude<TimelineEntry, { kind: "message" }>): IMessageAgentStep {
  switch (entry.kind) {
    case "work":
      return {
        id: entry.id,
        label: entry.entry.label,
        detail: entry.entry.detail ?? entry.entry.command ?? null,
        error: entry.entry.tone === "error",
      };
    case "proposed-plan":
      return { id: entry.id, label: "Plan", detail: entry.proposedPlan.planMarkdown, error: false };
    case "html-render":
      return { id: entry.id, label: "Rendered a page", detail: null, error: false };
    case "mcp-app":
      return { id: entry.id, label: "Opened an app view", detail: null, error: false };
    case "event":
      return { id: entry.id, label: entry.projectedItem.item.type, detail: null, error: false };
  }
}

function later(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}
