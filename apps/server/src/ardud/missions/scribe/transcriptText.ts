/**
 * Raw text of a lane transcript event, as the citation checker sees it.
 *
 * A transcript event is one row of `orchestration_v2_projection_turn_items`;
 * its ordinal is the event number notes cite. The scribe runner renders a
 * trimmed copy of the same fields for the model
 * (`integrations/scribe/lib/transcript.mjs`, keep the two in sync), so any
 * quote taken from the rendered slice is a substring of this raw text.
 *
 * Pure and type-import only: the scribe proof scripts import it directly.
 */

export interface TranscriptEvent {
  readonly threadId: string;
  /** Turn item ordinal; unique and increasing within a thread. */
  readonly event: number;
  readonly type: string;
  readonly at: string | null;
  /** Every quotable field joined by newlines. Empty for checkpoints. */
  readonly text: string;
  /** True for tool output the lane observed (commands, tools), not what an agent said. */
  readonly observed: boolean;
}

const OBSERVED_TYPES = new Set(["command_execution", "dynamic_tool", "file_search"]);

const str = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

const join = (...parts: ReadonlyArray<unknown>): string =>
  parts
    .map(str)
    .filter((part) => part.length > 0)
    .join("\n");

/** Quotable text of one turn item payload. */
export const eventText = (type: string, payload: Record<string, unknown>): string => {
  switch (type) {
    case "user_message":
    case "assistant_message":
      return str(payload.text);
    case "command_execution":
      return join(
        payload.input,
        payload.output,
        payload.exitCode === undefined || payload.exitCode === null
          ? ""
          : `exit ${str(payload.exitCode)}`,
      );
    case "dynamic_tool":
      return join(payload.toolName, payload.input, payload.output);
    case "file_change":
      return join(payload.fileName, payload.newStr);
    case "subagent":
      return join(payload.title, payload.prompt, payload.result);
    case "notification":
      return join(payload.summary, payload.outcome);
    case "compaction":
      return str(payload.summary);
    case "file_search":
      return join(payload.pattern, payload.results);
    case "web_search":
      return join(payload.query, payload.results, payload.output);
    case "error":
      return join(payload.message, payload.text, payload.detail);
    default:
      return join(payload.title);
  }
};

const parsePayload = (payload: unknown): Record<string, unknown> => {
  if (typeof payload === "string") {
    try {
      const parsed: unknown = JSON.parse(payload);
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
};

/** Build a transcript event from a turn item row (`payload_json` as stored). */
export const transcriptEvent = (row: {
  readonly threadId: string;
  readonly ordinal: number;
  readonly type: string;
  readonly payload: unknown;
}): TranscriptEvent => {
  const payload = parsePayload(row.payload);
  const at =
    typeof payload.completedAt === "string"
      ? payload.completedAt
      : typeof payload.startedAt === "string"
        ? payload.startedAt
        : typeof payload.updatedAt === "string"
          ? payload.updatedAt
          : null;
  return {
    threadId: row.threadId,
    event: row.ordinal,
    type: row.type,
    at,
    text: eventText(row.type, payload),
    observed: OBSERVED_TYPES.has(row.type),
  };
};
