import * as DateTime from "effect/DateTime";

import {
  classifyIMessageUserMessage,
  imessageGuidanceText,
  imessageSentReply,
} from "./messageKinds.ts";
import { IMESSAGE_TOOL_MODE_MARKER, imessageSendOf, type IMessageSend } from "./sends.ts";
import { imessageDayKey } from "./threadWindow.ts";

/**
 * The slice of a timeline message the rows read. Web's chat message and mobile's feed message
 * both satisfy it, so each client keeps its own timeline builder.
 */
export interface IMessageTimelineMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly runId: string | null;
  readonly streaming: boolean;
  readonly createdBy?: "user" | "agent" | "system" | undefined;
  readonly context?: { readonly records: ReadonlyArray<{ readonly kind: string }> } | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IMessageTimelineWork {
  readonly id: string;
  readonly runId?: string | null | undefined;
  readonly label: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string | undefined;
  readonly detail?: string | undefined;
  /** The turn item behind the step; a send tool call is read from its name and input. */
  readonly structuredPayload?:
    | {
        readonly startedAt: DateTime.Utc | null;
        readonly completedAt: DateTime.Utc | null;
      }
    | undefined;
}

interface IMessageTimelineBase {
  readonly id: string;
  readonly createdAt: string;
}

export type IMessageTimelineEntry =
  | (IMessageTimelineBase & { readonly kind: "message"; readonly message: IMessageTimelineMessage })
  | (IMessageTimelineBase & { readonly kind: "work"; readonly entry: IMessageTimelineWork })
  | (IMessageTimelineBase & {
      readonly kind: "proposed-plan";
      readonly proposedPlan: { readonly runId: string | null; readonly planMarkdown: string };
    })
  | (IMessageTimelineBase & {
      readonly kind: "html-render" | "mcp-app";
      readonly runId: string | null;
    })
  | (IMessageTimelineBase & {
      readonly kind: "event";
      readonly projectedItem: {
        readonly item: { readonly runId: string | null; readonly type: string };
      };
    });

/**
 * Where a step sits in a turn's details: what came in with the turn (bridge
 * guidance, frames, other agents' prompts), the work and sends in time order,
 * and the agent's own closing note.
 */
export type IMessageStepGroup = "in" | "work" | "note";

/** One line in a turn's details: a tool call, a send, a frame nobody typed, a note. */
export interface IMessageAgentStep {
  readonly id: string;
  readonly group: IMessageStepGroup;
  /** The short kind column: "Ran", "Watcher event", "Channel guidance", "Sent". */
  readonly label: string;
  /** The one-line summary next to it. */
  readonly text: string;
  /** The full text behind the summary, when there is more to read. */
  readonly detail: string | null;
  /** A shell command, set in the code face. */
  readonly code: boolean;
  readonly seconds: number | null;
  readonly error: boolean;
  /** When it happened, if known. */
  readonly at: string | null;
  /** Set on the step that texted the chat. */
  readonly send?: IMessageSend | undefined;
}

/** A turn that texted, one that chose to stay quiet, or one still running. */
export type IMessageAgentOutcome = "replied" | "no-reply" | "working";

/** One agent turn, as the chip summarises it and the inspector opens it. */
export interface IMessageTurn {
  readonly id: string;
  readonly steps: ReadonlyArray<IMessageAgentStep>;
  readonly outcome: IMessageAgentOutcome;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly sentCount: number;
  readonly errorCount: number;
  /** True once the chat sends by tool: the final message is the agent's note, not a text. */
  readonly toolMode: boolean;
}

/**
 * How much of a chat a row belongs to. The page's filter shows the conversation
 * alone, adds what the system and other agents put in, or shows everything,
 * the agents' own notes included.
 */
export type IMessageRowLevel = "conversation" | "system" | "everything";

export const IMESSAGE_ROW_LEVELS: ReadonlyArray<IMessageRowLevel> = [
  "conversation",
  "system",
  "everything",
];

export type IMessageChatRow = { readonly level: IMessageRowLevel } & (
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
  /** A watcher event or a bridge request: a centred line naming its source. */
  | {
      readonly kind: "event";
      readonly id: string;
      readonly source: string;
      readonly title: string;
      readonly detail: string | null;
      readonly createdAt: string;
    }
  /** A prompt another agent put into the chat thread. */
  | {
      readonly kind: "injected";
      readonly id: string;
      readonly title: string;
      readonly text: string;
      readonly createdAt: string;
    }
  /** The chip above a turn's texts; it opens the turn in the inspector. */
  | { readonly kind: "agent"; readonly id: string; readonly turn: IMessageTurn }
  /** A text that really went out over iMessage. */
  | {
      readonly kind: "reply";
      readonly id: string;
      readonly turnId: string;
      readonly send: IMessageSend;
      readonly createdAt: string;
    }
  /** The agent's closing message in tool mode: its own note, never texted. */
  | {
      readonly kind: "note";
      readonly id: string;
      readonly turnId: string;
      readonly text: string;
      readonly createdAt: string;
    }
);

export interface IMessageChatRowOptions {
  /** Day of the thread rendered just above, so a divider marks only a real day change. */
  readonly previousDayKey: string | null;
  /** Non-owner chats carry each member's name in front of their text. */
  readonly namedSenders: boolean;
  /** The run still in progress, whose last assistant text may not be final yet. */
  readonly activeRunId: string | null;
  /** The thread above was already in tool mode, so this one starts in it. */
  readonly toolMode?: boolean | undefined;
}

export interface IMessageChatRowsResult {
  readonly rows: IMessageChatRow[];
  /** Turns by id, for the inspector. */
  readonly turns: ReadonlyMap<string, IMessageTurn>;
  /** Whether the thread ended in tool mode, for the thread rendered below it. */
  readonly toolMode: boolean;
}

interface Turn {
  readonly key: string;
  readonly entries: IMessageTimelineEntry[];
}

/**
 * Turns one thread's timeline into chat rows. Each run is one agent turn: what
 * people typed becomes incoming bubbles, watcher events and bridge requests a
 * centred line, other agents' prompts a card of their own, and what the agent
 * texted a sent bubble. Before tool mode the final assistant message was the
 * text; in tool mode only send calls are, and the final message is a note.
 */
export function buildIMessageChatRows(
  entries: ReadonlyArray<IMessageTimelineEntry>,
  options: IMessageChatRowOptions,
): IMessageChatRowsResult {
  const rows: IMessageChatRow[] = [];
  const turns = new Map<string, IMessageTurn>();
  let dayKey = options.previousDayKey;
  let toolMode = options.toolMode ?? false;
  // Bridge outbox ids already shown: a deduplicated retry is the same message.
  const shownOutbox = new Set<string>();

  for (const turn of splitTurns(entries)) {
    const first = turn.entries[0]!;
    const turnDay = imessageDayKey(first.createdAt);
    if (turnDay !== dayKey) {
      rows.push({
        kind: "divider",
        level: "conversation",
        id: `day:${first.id}`,
        createdAt: first.createdAt,
      });
      dayKey = turnDay;
    }
    rows.push({
      kind: "time",
      level: "conversation",
      id: `time:${first.id}`,
      createdAt: first.createdAt,
    });
    // Each turn opens under its own time line, so names show again from there.
    let lastSender: string | null = null;
    const turnId = `${turn.key}:${first.id}`;

    if (!toolMode && turnEntersToolMode(turn.entries)) toolMode = true;

    const steps: IMessageAgentStep[] = [];
    const assistants: IMessageTimelineMessage[] = [];
    const sendRows: IMessageChatRow[] = [];
    // The chip goes after what came in with the turn, ahead of its first output.
    let chipAt: number | null = null;
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
          chipAt ??= rows.length;
        } else if (message.role === "user") {
          lastSender = addUserMessage(message, options.namedSenders, lastSender, rows, steps);
        }
        continue;
      }
      chipAt ??= rows.length;
      const step = entryStep(entry);
      steps.push(step);
      if (step.send !== undefined) {
        const outboxId = step.send.outboxId ?? null;
        if (outboxId !== null && shownOutbox.has(outboxId)) continue;
        if (outboxId !== null) shownOutbox.add(outboxId);
        const row: IMessageChatRow = {
          kind: "reply",
          level: "conversation",
          id: `send:${step.id}`,
          turnId,
          send: step.send,
          createdAt: step.send.createdAt,
        };
        rows.push(row);
        sendRows.push(row);
      }
    }

    const final = assistants[assistants.length - 1];
    const working =
      (options.activeRunId !== null && turn.key === options.activeRunId) ||
      (final?.streaming ?? false);
    // The send tool only exists in tool mode; a CLI send before it went out beside the final text.
    const toolTurn =
      toolMode || sendRows.some((row) => row.kind === "reply" && row.send.via === "tool");
    if (toolTurn) toolMode = true;
    for (const draft of working || toolTurn ? assistants : assistants.slice(0, -1)) {
      if (toolTurn && draft === final && !working) continue;
      const label = toolTurn ? "Agent text" : "Text not sent";
      steps.push(textStep(draft.id, "work", label, draft.text, draft.createdAt));
    }

    if (!working && final !== undefined) {
      if (toolTurn) {
        const note = final.text.trim();
        if (note.length > 0 && note !== "NO_REPLY") {
          steps.push(textStep(final.id, "note", "Agent note", note, final.createdAt));
          rows.push({
            kind: "note",
            level: "everything",
            id: `note:${final.id}`,
            turnId,
            text: note,
            createdAt: final.createdAt,
          });
        }
      } else {
        const sent = imessageSentReply(final.text);
        if (sent !== null) {
          const send: IMessageSend = {
            id: final.id,
            text: sent,
            file: null,
            to: null,
            state: "sent",
            via: "final",
            createdAt: final.createdAt,
          };
          const row: IMessageChatRow = {
            kind: "reply",
            level: "conversation",
            id: final.id,
            turnId,
            send,
            createdAt: final.createdAt,
          };
          rows.push(row);
          sendRows.push(row);
          steps.push(sendStep(final.id, send));
        } else if (final.text.trim() !== "NO_REPLY") {
          steps.push(textStep(final.id, "work", "Text not sent", final.text, final.createdAt));
        }
      }
    }

    // A failed attempt that a later call in this turn sent anyway (same text, file and
    // chat, e.g. a timeout retried with its dedupe key) is not a failed message.
    for (const [index, row] of sendRows.entries()) {
      if (row.kind !== "reply" || row.send.state !== "failed") continue;
      const retried = sendRows
        .slice(index + 1)
        .some(
          (later) =>
            later.kind === "reply" &&
            later.send.state !== "failed" &&
            later.send.text === row.send.text &&
            later.send.file === row.send.file &&
            later.send.to === row.send.to,
        );
      if (retried) rows.splice(rows.indexOf(row), 1);
    }
    // Sends are counted by message: retries sharing an outbox id count once.
    const sentCount = sendRows.filter(
      (row) => row.kind === "reply" && row.send.state !== "failed" && rows.includes(row),
    ).length;
    const outcome: IMessageAgentOutcome = working
      ? "working"
      : sentCount > 0
        ? "replied"
        : "no-reply";
    const record: IMessageTurn = {
      id: turnId,
      steps,
      outcome,
      startedAt: first.createdAt,
      endedAt,
      sentCount,
      errorCount: steps.filter((step) => step.error).length,
      toolMode: toolTurn,
    };
    turns.set(turnId, record);
    // A turn whose only step is its own final text needs no chip, as before tool mode.
    if (steps.some((step) => step.send?.via !== "final") || outcome !== "replied") {
      rows.splice(chipAt ?? rows.length, 0, {
        kind: "agent",
        level: "conversation",
        id: `agent:${turnId}`,
        turn: record,
      });
    }
  }
  return { rows, turns, toolMode };
}

/** The rows a filter level shows. */
export function imessageRowsAtLevel(
  rows: ReadonlyArray<IMessageChatRow>,
  level: IMessageRowLevel,
): IMessageChatRow[] {
  const rank = IMESSAGE_ROW_LEVELS.indexOf(level);
  return rows.filter((row) => IMESSAGE_ROW_LEVELS.indexOf(row.level) <= rank);
}

/** "Agent · 3 steps · 1m 22s · 2 sent", the line on the chip above a turn's texts. */
export function imessageAgentSummary(
  turn: Pick<IMessageTurn, "steps" | "outcome" | "startedAt" | "endedAt" | "sentCount">,
): string {
  const seconds = Math.round((Date.parse(turn.endedAt) - Date.parse(turn.startedAt)) / 1000);
  const steps = turn.steps.filter((step) => step.send === undefined && step.group === "work");
  return [
    OUTCOME_LABEL[turn.outcome],
    steps.length > 0 ? `${steps.length} ${steps.length === 1 ? "step" : "steps"}` : null,
    seconds > 0 ? formatIMessageDuration(seconds) : null,
    turn.sentCount > 1 ? `${turn.sentCount} sent` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

const OUTCOME_LABEL = { replied: "Agent", "no-reply": "No text sent", working: "Working" } as const;

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

/** Whether a turn's guidance says replies go out by tool. */
function turnEntersToolMode(entries: ReadonlyArray<IMessageTimelineEntry>): boolean {
  return entries.some((entry) => {
    if (entry.kind !== "message" || entry.message.role !== "user") return false;
    const guidance = imessageGuidanceText(entry.message.text) ?? contextGuidance(entry.message);
    return guidance !== null && guidance.includes(IMESSAGE_TOOL_MODE_MARKER);
  });
}

/** Runs split turns; entries without a run stay with the turn they arrived in. */
function splitTurns(entries: ReadonlyArray<IMessageTimelineEntry>): Turn[] {
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

function entryRunId(entry: IMessageTimelineEntry): string | null {
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
  message: IMessageTimelineMessage,
  namedSenders: boolean,
  lastSender: string | null,
  rows: IMessageChatRow[],
  steps: IMessageAgentStep[],
): string | null {
  const guidance = imessageGuidanceText(message.text) ?? contextGuidance(message);
  if (guidance !== null) {
    steps.push({
      ...textStep(`${message.id}:guidance`, "in", "Channel guidance", guidance, message.createdAt),
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
        level: "system",
        id: `${message.id}:event`,
        source: kind.source,
        title: kind.title,
        detail: message.text,
        createdAt: message.createdAt,
      });
      steps.push({
        ...textStep(message.id, "in", "Watcher event", message.text, message.createdAt),
        text: kind.title.length > 0 ? `${kind.source} · ${kind.title}` : kind.source,
        detail: message.text,
      });
      return lastSender;
    case "hidden":
      if (kind.reason === "agent") {
        const title = firstLine(message.text);
        rows.push({
          kind: "injected",
          level: "system",
          id: `${message.id}:injected`,
          title,
          text: message.text.trim(),
          createdAt: message.createdAt,
        });
        steps.push(textStep(message.id, "in", "Agent prompt", message.text, message.createdAt));
      } else if (kind.reason === "bridge") {
        rows.push({
          kind: "event",
          level: "system",
          id: `${message.id}:bridge`,
          source: "Bridge",
          title: bridgeTitle(message.text),
          detail: message.text,
          createdAt: message.createdAt,
        });
        steps.push(textStep(message.id, "in", "Bridge request", message.text, message.createdAt));
      }
      return lastSender;
    case "typed": {
      let sender = lastSender;
      kind.parts.forEach((part, index) => {
        rows.push({
          kind: "incoming",
          level: "conversation",
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

/** A bridge frame's first sentence after its bracketed tag. */
function bridgeTitle(text: string): string {
  const body = (imessageGuidanceText(text) === null ? text : text.slice(text.indexOf("]") + 1))
    .trim()
    .replace(/^\[[^\]\n]*\]\s*/, "");
  const line = firstLine(body);
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** Newer bridge versions move the guidance out of the text into a context record. */
function contextGuidance(message: IMessageTimelineMessage): string | null {
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

function entryStep(entry: Exclude<IMessageTimelineEntry, { kind: "message" }>): IMessageAgentStep {
  switch (entry.kind) {
    case "work":
      return workStep(entry.entry, entry.createdAt);
    case "proposed-plan":
      return textStep(entry.id, "work", "Plan", entry.proposedPlan.planMarkdown, entry.createdAt);
    case "html-render":
      return plainStep(entry.id, "Tool", "Rendered a page", entry.createdAt);
    case "mcp-app":
      return plainStep(entry.id, "Tool", "Opened an app view", entry.createdAt);
    case "event":
      return plainStep(
        entry.id,
        "Event",
        entry.projectedItem.item.type.replaceAll("_", " "),
        entry.createdAt,
      );
  }
}

function workStep(work: IMessageTimelineWork, at: string): IMessageAgentStep {
  const seconds = workSeconds(work);
  const error = work.tone === "error";
  const send = imessageSendOf({
    id: work.id,
    createdAt: at,
    tone: work.tone,
    command: work.command,
    payload: work.structuredPayload,
  });
  if (send !== null) return { ...sendStep(work.id, send), seconds, detail: work.detail ?? null };
  if (work.command !== undefined && work.command.trim().length > 0) {
    return {
      id: work.id,
      group: "work",
      label: error ? "Failed" : "Ran",
      text: firstLine(work.command),
      detail: work.detail ?? (work.command.includes("\n") ? work.command : null),
      code: true,
      seconds,
      error,
      at,
    };
  }
  const label = error ? "Error" : work.tone === "thinking" ? "Thought" : "Tool";
  if (work.tone === "thinking" && work.detail !== undefined) {
    return { ...textStep(work.id, "work", label, work.detail, at), seconds, error };
  }
  return {
    id: work.id,
    group: "work",
    label,
    text: firstLine(work.label),
    detail: work.detail ?? null,
    code: false,
    seconds,
    error,
    at,
  };
}

function sendStep(id: string, send: IMessageSend): IMessageAgentStep {
  const label =
    send.state === "failed" ? "Send failed" : send.state === "sending" ? "Sending" : "Sent";
  const text = send.text.length > 0 ? send.text : (send.file ?? "");
  return {
    id,
    group: "work",
    label: send.to === null ? label : `${label} to ${send.to}`,
    text: firstLine(text),
    detail: null,
    code: false,
    seconds: null,
    error: send.state === "failed",
    at: send.createdAt,
    send,
  };
}

function workSeconds(work: IMessageTimelineWork): number | null {
  const item = work.structuredPayload;
  if (item?.startedAt == null || item.completedAt == null) return null;
  return (DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt)) / 1000;
}

/** A step whose summary is the first line of a longer text that expands in place. */
function textStep(
  id: string,
  group: IMessageStepGroup,
  label: string,
  full: string,
  at: string | null,
): IMessageAgentStep {
  const text = firstLine(full);
  return {
    id,
    group,
    label,
    text,
    detail: full.trim() === text ? null : full,
    code: false,
    seconds: null,
    error: false,
    at,
  };
}

function plainStep(id: string, label: string, text: string, at: string | null): IMessageAgentStep {
  return {
    id,
    group: "work",
    label,
    text,
    detail: null,
    code: false,
    seconds: null,
    error: false,
    at,
  };
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
