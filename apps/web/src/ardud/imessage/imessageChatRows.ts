import {
  classifyIMessageUserMessage,
  imessageDayKey,
  imessageGuidanceText,
  imessageSentReply,
} from "@t3tools/client-runtime/ardud/imessage";
import * as DateTime from "effect/DateTime";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";

/** One line in an agent row's details: a tool call, or a frame nobody typed. */
export interface IMessageAgentStep {
  readonly id: string;
  /** The short kind column: "Ran", "Watcher event", "Channel guidance". */
  readonly label: string;
  /** The one-line summary next to it. */
  readonly text: string;
  /** The full text behind the summary, when there is more to read. */
  readonly detail: string | null;
  /** A shell command, set in the code face. */
  readonly code: boolean;
  readonly seconds: number | null;
  readonly error: boolean;
}

export type IMessageAgentOutcome = "replied" | "no-reply" | "working";

export type IMessageChatRow =
  | { readonly kind: "divider"; readonly id: string; readonly createdAt: string }
  /** The time each turn started, set as a centred line like Messages does. */
  | { readonly kind: "time"; readonly id: string; readonly createdAt: string }
  | {
      readonly kind: "incoming";
      readonly id: string;
      readonly text: string;
      readonly sender: string | null;
      /** False when the previous bubble in this turn came from the same sender. */
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

  for (const turn of splitTurns(entries)) {
    const first = turn.entries[0]!;
    const turnDay = imessageDayKey(first.createdAt);
    if (turnDay !== dayKey) {
      rows.push({ kind: "divider", id: `day:${first.id}`, createdAt: first.createdAt });
      dayKey = turnDay;
    }
    rows.push({ kind: "time", id: `time:${first.id}`, createdAt: first.createdAt });
    // Each turn opens under its own time line, so names show again from there.
    let lastSender: string | null = null;

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
      steps.push(textStep(draft.id, "Text not sent", draft.text));
    }
    const sent = !working && final !== undefined ? imessageSentReply(final.text) : null;
    if (!working && final !== undefined && sent === null && final.text.trim() !== "NO_REPLY") {
      steps.push(textStep(final.id, "Text not sent", final.text));
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
    }
  }
  return rows;
}

/** "Agent · 3 steps · 1m 22s", the line on the chip above a reply. */
export function imessageAgentSummary(
  row: Pick<
    Extract<IMessageChatRow, { kind: "agent" }>,
    "steps" | "outcome" | "startedAt" | "endedAt"
  >,
): string {
  const seconds = Math.round((Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000);
  const steps = row.steps.length;
  return [
    OUTCOME_LABEL[row.outcome],
    steps > 0 ? `${steps} ${steps === 1 ? "step" : "steps"}` : null,
    seconds > 0 ? formatIMessageDuration(seconds) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

const OUTCOME_LABEL = { replied: "Agent", "no-reply": "No reply", working: "Working" } as const;

export function formatIMessageDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 1) return "<1s";
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return whole % 60 === 0 ? `${minutes}m` : `${minutes}m ${whole % 60}s`;
  return minutes % 60 === 0
    ? `${Math.floor(minutes / 60)}h`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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
      ...textStep(`${message.id}:guidance`, "Channel guidance", guidance),
      text: `iMessage bridge rules, ${formatCharacters(guidance.length)}`,
      detail: guidance,
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
        ...textStep(message.id, "Watcher event", message.text),
        text: kind.title.length > 0 ? `${kind.source} · ${kind.title}` : kind.source,
        detail: message.text,
      });
      return lastSender;
    case "hidden":
      if (kind.reason !== "guidance") {
        steps.push(
          textStep(
            message.id,
            kind.reason === "agent" ? "Agent prompt" : "Bridge request",
            message.text,
          ),
        );
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
      return workStep(entry.entry);
    case "proposed-plan":
      return textStep(entry.id, "Plan", entry.proposedPlan.planMarkdown);
    case "html-render":
      return plainStep(entry.id, "Tool", "Rendered a page");
    case "mcp-app":
      return plainStep(entry.id, "Tool", "Opened an app view");
    case "event":
      return plainStep(entry.id, "Event", entry.projectedItem.item.type.replaceAll("_", " "));
  }
}

function workStep(work: WorkLogEntry): IMessageAgentStep {
  const seconds = workSeconds(work);
  const error = work.tone === "error";
  if (work.command !== undefined && work.command.trim().length > 0) {
    return {
      id: work.id,
      label: error ? "Failed" : "Ran",
      text: firstLine(work.command),
      detail: work.detail ?? (work.command.includes("\n") ? work.command : null),
      code: true,
      seconds,
      error,
    };
  }
  const label = error ? "Error" : work.tone === "thinking" ? "Thought" : "Tool";
  if (work.tone === "thinking" && work.detail !== undefined) {
    return { ...textStep(work.id, label, work.detail), seconds, error };
  }
  return {
    id: work.id,
    label,
    text: firstLine(work.label),
    detail: work.detail ?? null,
    code: false,
    seconds,
    error,
  };
}

function workSeconds(work: WorkLogEntry): number | null {
  const item = work.structuredPayload;
  if (item?.startedAt == null || item.completedAt == null) return null;
  return (DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt)) / 1000;
}

/** A step whose summary is the first line of a longer text that expands in place. */
function textStep(id: string, label: string, full: string): IMessageAgentStep {
  const text = firstLine(full);
  return {
    id,
    label,
    text,
    detail: full.trim() === text ? null : full,
    code: false,
    seconds: null,
    error: false,
  };
}

function plainStep(id: string, label: string, text: string): IMessageAgentStep {
  return { id, label, text, detail: null, code: false, seconds: null, error: false };
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0]!.trim();
}

function formatCharacters(count: number): string {
  return count < 1000 ? `${count} characters` : `${(count / 1000).toFixed(1)}k characters`;
}

function later(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}
