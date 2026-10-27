import type {
  ChatFileAttachment,
  ChatImageAttachment,
  KanbanAnswer,
  KanbanBlock,
  KanbanLink,
  KanbanParticipant,
  KanbanStage,
} from "@t3tools/contracts";
import { ownerChoiceAnswer, type StageBoard } from "@t3tools/client-runtime/ardud/kanban";

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
const MIN_COLUMN = 196;
const MAX_COLUMN = 280;
/** Four active stages and the folded Shipped column. */
const SCROLLED_COLUMNS = 5;

export type BoardLayout =
  | { readonly kind: "tabs" }
  | {
      readonly kind: "columns";
      readonly column: number;
      readonly owner: number;
      /** The stage columns are wider than the room left of Needs Owner. */
      readonly scrolls: boolean;
    };

export function boardLayout(width: number): BoardLayout {
  if (width < COLUMNS_MIN_WIDTH) return { kind: "tabs" };
  const room = width - OWNER_WIDTH - BOARD_PAD - COLUMN_GAP;
  const gaps = (SCROLLED_COLUMNS - 1) * COLUMN_GAP;
  const column = Math.min(
    MAX_COLUMN,
    Math.max(MIN_COLUMN, Math.floor((room - gaps) / SCROLLED_COLUMNS)),
  );
  return {
    kind: "columns",
    column,
    owner: OWNER_WIDTH,
    scrolls: column * SCROLLED_COLUMNS + gaps > room,
  };
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
