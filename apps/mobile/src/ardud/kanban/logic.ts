import type {
  ChatFileAttachment,
  ChatImageAttachment,
  KanbanAnswer,
  KanbanBlock,
  KanbanLink,
  KanbanMessage,
  KanbanParticipant,
  KanbanStage,
} from "@t3tools/contracts";
import {
  BOARD_COLUMNS,
  clampColumnWidth,
  EMPTY_BOARD_COLUMN_PREFS,
  ownerChoiceAnswer,
  resetColumnWidths,
  showAllColumns,
  toggleColumn,
  type BoardColumnKey,
  type BoardColumnPrefs,
  type StageBoard,
} from "@t3tools/client-runtime/ardud/kanban";

/** Completed, Deployed and Verified share one Shipped tab. */
export type BoardTab = "todo" | "working" | "needs_review" | "in_review" | "shipped";

export const BOARD_TABS: ReadonlyArray<{ readonly value: BoardTab; readonly label: string }> = [
  { value: "todo", label: "To-Do" },
  { value: "working", label: "Working" },
  { value: "needs_review", label: "Needs Review" },
  { value: "in_review", label: "In Review" },
  { value: "shipped", label: "Shipped" },
];

export interface BoardTabView {
  readonly value: BoardTab;
  readonly label: string;
  readonly count: number;
}

export function boardTabs(board: Pick<StageBoard, "active" | "shipped">): BoardTabView[] {
  const count = (tab: BoardTab) =>
    tab === "shipped"
      ? board.shipped.reduce((total, column) => total + column.cards.length, 0)
      : (board.active.find((column) => column.stage === tab)?.cards.length ?? 0);
  return BOARD_TABS.map((tab) => ({ ...tab, count: count(tab.value) }));
}

/** Working when it has cards, else the first tab that has any. */
export function defaultBoardTab(tabs: ReadonlyArray<BoardTabView>): BoardTab {
  if ((tabs.find((tab) => tab.value === "working")?.count ?? 0) > 0) return "working";
  return tabs.find((tab) => tab.count > 0)?.value ?? "todo";
}

/** From this width the board shows its stages side by side instead of tabs. */
export const COLUMNS_MIN_WIDTH = 900;
export const BOARD_PAD = 16;
export const COLUMN_GAP = 10;
export const OWNER_WIDTH = 264;
/** A hidden column or Needs Owner folds to a rail this wide. */
export const COLUMN_RAIL_WIDTH = 36;
const MIN_COLUMN = 196;
const MAX_COLUMN = 280;
/** Four active stages and the folded Shipped column. */
const SCROLLED_COLUMNS = 5;

/** The stage columns in display order, Shipped last. Needs Owner is handled apart. */
export const STAGE_COLUMN_KEYS: ReadonlyArray<BoardColumnKey> = [
  "todo",
  "working",
  "needs_review",
  "in_review",
  "shipped",
];

export type BoardLayout =
  | { readonly kind: "tabs" }
  | {
      readonly kind: "columns";
      /** Width of each visible stage column (Shipped included). Hidden columns are absent. */
      readonly columns: Partial<Record<BoardColumnKey, number>>;
      /** Stage columns the owner has hidden, in display order. */
      readonly hidden: ReadonlyArray<BoardColumnKey>;
      /** Needs Owner pane width, or the rail width when it is hidden. */
      readonly owner: number;
      readonly ownerHidden: boolean;
      /** The visible stage row is wider than the room left of Needs Owner, so it scrolls sideways. */
      readonly scrolls: boolean;
    };

/** Short labels for a hidden column's rail, which is only 36px wide. */
export const COLUMN_RAIL_LABELS: Record<BoardColumnKey, string> = {
  todo: "To-Do",
  working: "Work",
  needs_review: "Review",
  in_review: "In rev.",
  shipped: "Shipped",
  needs_owner: "Owner",
};

/**
 * True when the stage items don't fit the room. Every item (column or rail)
 * carries one trailing gap, which is also the gap before Needs Owner.
 */
export function columnsOverflow(
  room: number,
  widths: ReadonlyArray<number>,
  railCount: number,
): boolean {
  const items = widths.length + railCount;
  const used = widths.reduce((total, width) => total + width, 0) + railCount * COLUMN_RAIL_WIDTH;
  return used + items * COLUMN_GAP > room;
}

export function boardLayout(
  width: number,
  prefs: BoardColumnPrefs = EMPTY_BOARD_COLUMN_PREFS,
): BoardLayout {
  if (width < COLUMNS_MIN_WIDTH) return { kind: "tabs" };
  const ownerHidden = prefs.hidden.includes("needs_owner");
  const owner = ownerHidden
    ? COLUMN_RAIL_WIDTH
    : clampColumnWidth("needs_owner", prefs.widths.needs_owner ?? OWNER_WIDTH);
  const room = width - owner - BOARD_PAD;
  // Today's default: five columns, each with its trailing gap.
  const defaultColumn = Math.min(
    MAX_COLUMN,
    Math.max(MIN_COLUMN, Math.floor((room - SCROLLED_COLUMNS * COLUMN_GAP) / SCROLLED_COLUMNS)),
  );
  const hidden = STAGE_COLUMN_KEYS.filter((key) => prefs.hidden.includes(key));
  const shown = STAGE_COLUMN_KEYS.filter((key) => !prefs.hidden.includes(key));
  const columns: Partial<Record<BoardColumnKey, number>> = {};
  for (const key of shown) {
    columns[key] = clampColumnWidth(key, prefs.widths[key] ?? defaultColumn);
  }
  return {
    kind: "columns",
    columns,
    hidden,
    owner,
    ownerHidden,
    scrolls: columnsOverflow(
      room,
      shown.map((key) => columns[key] ?? 0),
      hidden.length,
    ),
  };
}

/** A column-menu pick: show or hide one stage or Needs Owner, show all, or reset widths. */
export type ColumnAction =
  | { readonly kind: "toggle"; readonly key: BoardColumnKey }
  | { readonly kind: "show-all" }
  | { readonly kind: "reset" };

export function columnActionId(action: ColumnAction): string {
  if (action.kind === "show-all") return "columns:show-all";
  if (action.kind === "reset") return "columns:reset";
  return `column:${action.key}`;
}

export function parseColumnAction(id: string): ColumnAction | null {
  if (id === "columns:show-all") return { kind: "show-all" };
  if (id === "columns:reset") return { kind: "reset" };
  if (!id.startsWith("column:")) return null;
  const key = id.slice("column:".length);
  return (BOARD_COLUMNS as ReadonlyArray<string>).includes(key)
    ? { kind: "toggle", key: key as BoardColumnKey }
    : null;
}

export function applyColumnAction(prefs: BoardColumnPrefs, action: ColumnAction): BoardColumnPrefs {
  if (action.kind === "show-all") return showAllColumns(prefs);
  if (action.kind === "reset") return resetColumnWidths(prefs);
  return toggleColumn(prefs, action.key);
}

/** The card opens in a pane over the columns, never wider than this. */
export function cardPaneWidth(width: number): number {
  return Math.min(460, Math.round(width * 0.46));
}

export type GlyphKind = "ok" | "done" | "risk" | "stuck" | "wait" | "ask" | "idle";

export function stageGlyph(stage: KanbanStage): GlyphKind {
  switch (stage) {
    case "working":
    case "in_review":
      return "ok";
    case "completed":
    case "deployed":
    case "verified":
      return "done";
    case "needs_owner":
      return "wait";
    case "todo":
    case "needs_review":
      return "idle";
  }
}

export function cardGlyph(card: { readonly stage: KanbanStage; readonly stalled: unknown }) {
  return card.stalled !== null ? "stuck" : stageGlyph(card.stage);
}

export function prGlyph(state: KanbanLink["state"] | string): GlyphKind {
  if (state === "open") return "ok";
  if (state === "merged") return "done";
  if (state === "closed") return "stuck";
  return "idle";
}

/** Filled bars out of three: P1 fills all, P4 none. */
export function priorityFill(priority: number): number {
  return Math.max(0, Math.min(3, 4 - Math.round(priority)));
}

type ChoiceBlock = Extract<KanbanBlock, { _tag: "choice" }>;

export interface ChoiceOptionView {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  /** Share of the people who answered, 0-100. */
  readonly percent: number;
  readonly mine: boolean;
}

export function choiceView(
  block: ChoiceBlock,
  answers: ReadonlyArray<KanbanAnswer>,
): {
  readonly options: ChoiceOptionView[];
  readonly answered: number;
  readonly mine: string[];
  /** The owner's own words on this block, or null when he wrote none. */
  readonly mineText: string | null;
} {
  const own = answers.filter((answer) => answer.blockId === block.id);
  const ownerAnswer = ownerChoiceAnswer(block, answers);
  const mine = ownerAnswer?.choice ?? [];
  return {
    answered: own.length,
    mine: [...mine],
    mineText: ownerAnswer?.text ?? null,
    options: block.options.map((option) => {
      const count = own.filter((answer) => answer.choice.includes(option.id)).length;
      return {
        id: option.id,
        label: option.label,
        count,
        percent: own.length === 0 ? 0 : Math.round((count / own.length) * 100),
        mine: mine.includes(option.id),
      };
    }),
  };
}

/** The owner's next answer after tapping an option; empty means nothing to send. */
export function toggleChoice(
  mine: ReadonlyArray<string>,
  optionId: string,
  multi: boolean,
): string[] {
  if (!multi) return mine.length === 1 && mine[0] === optionId ? [] : [optionId];
  return mine.includes(optionId) ? mine.filter((id) => id !== optionId) : [...mine, optionId];
}

/** Milliseconds until the first typing marker runs out, or null when nobody types. */
export function nextTypingExpiry(
  participants: ReadonlyArray<Pick<KanbanParticipant, "typingUntil">>,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const participant of participants) {
    if (participant.typingUntil === null) continue;
    const left = Date.parse(participant.typingUntil) - nowMs;
    if (left > 0 && (next === null || left < next)) next = left;
  }
  return next;
}

/** A new discussion's title: the first line of what the owner wrote. */
export function requestTitle(text: string): string {
  const first =
    text
      .split("\n")
      .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
      .find((line) => line !== "") ?? "";
  const line = first.replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line || "Request";
}

/** Images load straight from the block's URL; other schemes have nothing to load. */
export const isLoadableImageUrl = (url: string) => /^(https?:|data:image\/)/i.test(url.trim());

export type KanbanBoardParams = { readonly boardId?: string | undefined };

/** A pushed board record: a card, one discussion (none yet for a new one), the list, a goal. */
export type KanbanRecordKind = "card" | "discussion" | "discussions" | "goal";

export type KanbanRecordParams = {
  readonly kind?: string | undefined;
  readonly boardId?: string | undefined;
  readonly id?: string | undefined;
};

export interface KanbanRecordState {
  readonly kind: KanbanRecordKind;
  readonly boardId: string;
  readonly id: string | null;
}

const RECORD_KINDS: ReadonlyArray<KanbanRecordKind> = ["card", "discussion", "discussions", "goal"];

export function kanbanRecordState(
  params: KanbanRecordParams | undefined,
): KanbanRecordState | null {
  const kind = RECORD_KINDS.find((entry) => entry === params?.kind);
  const boardId = params?.boardId?.trim();
  if (kind === undefined || !boardId) return null;
  const id = params?.id?.trim() || null;
  if (id === null && (kind === "card" || kind === "goal")) return null;
  return { kind, boardId, id };
}

/**
 * Where a board link opens, as the record params the pushed screen reads: the
 * card or discussion on this board. A link to another board, or to a record
 * that isn't on this board, opens nothing (null).
 */
export function kanbanLinkTarget(
  link: { readonly kind: string; readonly id: string },
  boardId: string,
  board: {
    readonly cards: ReadonlyMap<string, unknown>;
    readonly discussions: ReadonlyMap<string, unknown>;
  },
): { readonly kind: "card" | "discussion"; readonly boardId: string; readonly id: string } | null {
  if (link.kind === "kanban-card") {
    return board.cards.has(link.id) ? { kind: "card", boardId, id: link.id } : null;
  }
  if (link.kind === "kanban-discussion") {
    return board.discussions.has(link.id) ? { kind: "discussion", boardId, id: link.id } : null;
  }
  return null;
}

/** An attachment the server has stored, as a block refers to it. */
export type StoredAttachment = ChatImageAttachment | ChatFileAttachment;

/** The blocks one send posts: the text first (when there is any), then each attachment in order. */
export function sendBlocks(
  text: string,
  attachments: ReadonlyArray<StoredAttachment>,
): KanbanBlock[] {
  const body = text.trim();
  return [
    ...(body === "" ? [] : [{ _tag: "md" as const, text: body }]),
    ...attachments.map((attachment) => ({ _tag: "attachment" as const, attachment })),
  ];
}

/** What a new discussion is titled from: the text, else the first file's name, else nothing. */
export function firstSendText(
  text: string,
  attachments: ReadonlyArray<{ readonly name: string }>,
): string {
  const body = text.trim();
  return body !== "" ? body : (attachments[0]?.name ?? "");
}

export type BlockRun =
  | { readonly kind: "block"; readonly index: number; readonly block: KanbanBlock }
  | {
      readonly kind: "attachments";
      readonly index: number;
      readonly attachments: ReadonlyArray<StoredAttachment>;
    };

/**
 * Whether a block was sent as a preview that can be read whole: a big text,
 * fold or page cut short by the feed, where there is a way to read the
 * message in full (a discussion's own feed, or a loader the screen gives).
 */
export function blockReadsWhole(block: KanbanBlock, canLoad: boolean): boolean {
  return (
    canLoad &&
    (block._tag === "md" || block._tag === "collapse" || block._tag === "html") &&
    block.truncated === true
  );
}

/**
 * A message as the feed sent it, with the blocks of the same message read
 * whole when there are any. Everything else stays the feed's: who answered,
 * and when. A whole read of another message is not used.
 */
export function messageReadWhole(message: KanbanMessage, whole: KanbanMessage | undefined) {
  return whole !== undefined &&
    whole.seq === message.seq &&
    whole.discussionId === message.discussionId
    ? { ...message, blocks: whole.blocks }
    : message;
}

/** Consecutive attachment blocks share one wrapping row; every other block stands alone. */
export function groupBlockRuns(blocks: ReadonlyArray<KanbanBlock>): BlockRun[] {
  const runs: BlockRun[] = [];
  blocks.forEach((block, index) => {
    if (block._tag !== "attachment") {
      runs.push({ kind: "block", index, block });
      return;
    }
    const last = runs.at(-1);
    if (last?.kind === "attachments") {
      runs[runs.length - 1] = { ...last, attachments: [...last.attachments, block.attachment] };
    } else {
      runs.push({ kind: "attachments", index, attachments: [block.attachment] });
    }
  });
  return runs;
}

/**
 * A native filter-menu action id. Facet values are the same strings the menu
 * was built from: priorities are numbers, the rest are goal ids, project and
 * model names; "" marks the "No ..." option.
 */
export type FilterAction =
  | { readonly kind: "toggle"; readonly facet: "priorities"; readonly value: number }
  | {
      readonly kind: "toggle";
      readonly facet: "goalIds" | "projects" | "models";
      readonly value: string;
    }
  | { readonly kind: "clear" };

export function filterActionId(action: FilterAction): string {
  if (action.kind === "clear") return "clear";
  const key = { priorities: "priority", goalIds: "goal", projects: "project", models: "model" }[
    action.facet
  ];
  return `${key}:${action.value}`;
}

export function parseFilterAction(id: string): FilterAction | null {
  if (id === "clear") return { kind: "clear" };
  const separator = id.indexOf(":");
  if (separator < 0) return null;
  const key = id.slice(0, separator);
  const value = id.slice(separator + 1);
  if (key === "priority") {
    const priority = Number(value);
    return Number.isInteger(priority) && priority >= 1 && priority <= 5
      ? { kind: "toggle", facet: "priorities", value: priority }
      : null;
  }
  if (key === "goal") return { kind: "toggle", facet: "goalIds", value };
  if (key === "project") return { kind: "toggle", facet: "projects", value };
  if (key === "model") return { kind: "toggle", facet: "models", value };
  return null;
}
