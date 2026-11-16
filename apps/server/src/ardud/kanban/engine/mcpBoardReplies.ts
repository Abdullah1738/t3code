import type { KanbanThreadState, ModelSelection } from "@t3tools/contracts";

import { COMPACT_READ_CHARS } from "../../compactRead.ts";
import * as Activity from "./activity.ts";
import { compactBoard } from "./boardReplies.ts";

const short = (text: string) => (text.length > 512 ? `${text.slice(0, 512)}…` : text);
const size = (value: unknown) => JSON.stringify(value).length;
const model = (selection: ModelSelection) => ({
  model: selection.model,
  variant:
    selection.options?.find((option) =>
      ["variant", "reasoningEffort", "effort"].includes(option.id),
    )?.value ?? null,
});

/** HTTP and the clients retain compactBoard's original row shape. */
export const cardRow = (card: ReturnType<typeof compactBoard>["cards"][number]) => ({
  ...card,
  model: model(card.model),
  question: card.question === null ? null : short(card.question),
  stalled: card.stalled === null ? null : { ...card.stalled, reason: short(card.stalled.reason) },
  asks: card.asks
    .filter((ask) => ask.closedAt === null)
    .map((ask) => ({
      id: ask.id,
      text: short(ask.text),
      blocking: ask.blocking,
      by: ask.by,
      at: ask.at,
      seq: ask.seq,
      closedAt: ask.closedAt,
    })),
  models: card.models.map((entry) => ({ ...model(entry.model), weight: entry.weight })),
});

const identityKey = (key: string) =>
  key === "id" ||
  key === "ids" ||
  key.endsWith("Id") ||
  key.endsWith("Ids") ||
  [
    "owner",
    "blockedBy",
    "keep",
    "card",
    "pr",
    "script",
    "activePool",
    "stage",
    "activeRole",
    "on",
  ].includes(key);

const textKeys = new Set([
  "title",
  "text",
  "reason",
  "question",
  "summary",
  "description",
  "name",
  "quote",
  "prompt",
  "note",
  "instructions",
  "modelRouting",
  "reviewerRouting",
  "escalation",
]);

// Exceptional rows can contain thousands of asks/models; bound breadth as well as text.
// Identity strings stay intact so the returned card and its threads remain actionable.
const preview = <T>(value: T, width: number, key = ""): T => {
  if (typeof value === "string")
    return (
      !textKeys.has(key) ? value : value.length > width ? `${value.slice(0, width)}…` : value
    ) as T;
  if (Array.isArray(value))
    return value.slice(0, width).map((entry) => preview(entry, width, key)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, Math.max(width, 32))
        .map(([key, entry]) => [key, preview(entry, width, key)]),
    ) as T;
  return value;
};

const identity = (value: unknown) =>
  value !== null && typeof value === "object"
    ? {
        ...("id" in value ? { id: value.id } : {}),
        ...("name" in value && typeof value.name === "string" ? { name: short(value.name) } : {}),
      }
    : {};

const fitPreview = <T>(value: T, maxChars: number, fallback: T): T => {
  for (let width = 512; width >= 1; width = Math.floor(width / 2)) {
    const candidate = preview(value, width);
    if (size(candidate) <= maxChars) return candidate;
  }
  // A malformed identity cannot be shortened without pointing at another card/thread.
  if (size(fallback) > maxChars) throw new RangeError("Compact read identity exceeds its budget");
  return fallback;
};

export const page = <
  R extends {
    readonly number: number;
    readonly activeThreadId?: string | null;
    readonly workThreadId?: string | null;
    readonly reviewThreadId?: string | null;
  },
>(
  metadata: Record<string, unknown>,
  rows: ReadonlyArray<R>,
  after: number,
  limit: number,
  threads?: ReadonlyArray<KanbanThreadState>,
) => {
  let header = metadata;
  let note = "omitted; card_get returns a card's prompt";
  const minimal =
    "board" in metadata
      ? { board: identity(metadata.board) }
      : {
          ...identity(metadata),
          window: metadata.window,
          legend: metadata.legend,
          activeCards: metadata.activeCards,
        };
  if (after > 0 && size(header) > COMPACT_READ_CHARS / 4) {
    header = minimal;
    note += "; board settings and inventories are on the first page";
  }
  // Leave room for a card even when board instructions or inventories fill the wrapper.
  if (size(header) > COMPACT_READ_CHARS / 2) {
    header = fitPreview(header, COMPACT_READ_CHARS / 2, minimal);
    note += "; oversized board metadata shortened";
  }
  const byThread = new Map(
    threads?.map((thread) => [
      thread.threadId as string,
      { ...thread, title: short(thread.title) },
    ]),
  );
  // Keep each card's live states with its row while budgeting. The envelope costs
  // more than the flattened reply, so states never hide outside the row budget.
  const entries = rows.map((card) => ({
    number: card.number,
    card,
    threads: [...new Set([card.activeThreadId, card.workThreadId, card.reviewThreadId])].flatMap(
      (id) => (id && byThread.has(id) ? [byThread.get(id)!] : []),
    ),
  }));
  return Activity.pageRowsInReply(
    entries,
    after,
    limit,
    (page, cursor) => ({
      board: {
        ...header,
        ...(threads === undefined
          ? {}
          : {
              threads: [
                ...new Map(
                  page.flatMap((entry) =>
                    entry.threads.map((thread) => [thread.threadId, thread] as const),
                  ),
                ).values(),
              ],
            }),
        cards: page.map((entry) => entry.card),
        page: { limit, ...cursor },
      },
      prompts: note,
    }),
    (entry, maxChars) => {
      const shell = { ...entry, card: {}, truncated: true };
      const available = maxChars - size(shell) - 1;
      const fallback = {
        ...Object.fromEntries(
          Object.entries(entry.card)
            .filter(([key]) => identityKey(key) || key === "priority")
            .map(([key, value]) => [key, Array.isArray(value) ? value.slice(0, 32) : value]),
        ),
        ...("wait" in entry.card ? { wait: preview(entry.card.wait, 32) } : {}),
        number: entry.number,
        truncated: true,
      };
      const card = fitPreview(
        { ...entry.card, truncated: true },
        available,
        fallback as R & { truncated: boolean },
      );
      return { ...entry, card };
    },
  );
};
