/**
 * What the phone's Needs-you screens work out for themselves, kept apart from
 * the views so it can be tested: route params, whose turn an ask is on, the
 * marks a row shows, the queue as list rows, the bridge to a page inside an
 * ask, and when an answer made offline goes again. Pure.
 */
import { parseWebLink, type WebLink } from "../../common/pageNavigation";
import {
  ASK_AUTO_RETRY_MAX,
  askAge,
  askOutcome,
  needsYouBatchKey,
  shortWhen,
  askFiguresAsOf,
  type AskFigures,
  type AskOutcome,
  type AskSend,
  type AskState,
  type AskToast,
  type NeedsYou,
  type NeedsYouEntry,
  type NeedsYouItem,
  type NeedsYouMark,
  type NeedsYouSection,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskBlock, KanbanAskFeedItem, KanbanAskField } from "@t3tools/contracts";
import { filePreviewKind, type FilePreviewKind } from "@t3tools/shared/filePreview";

// Routes

/** `robob://needs-you/ask/<cardId>/<askId>`: one ask, by the ids a link carries. */
export type NeedsYouAskParams = {
  readonly cardId?: string | undefined;
  readonly askId?: string | undefined;
};

/** The queue key (`<cardId>:<askId>`) a link opens, or null when it names no ask. */
export function askKeyFromParams(params: NeedsYouAskParams | undefined): string | null {
  const cardId = params?.cardId?.trim();
  const askId = params?.askId?.trim();
  return cardId && askId ? `${cardId}:${askId}` : null;
}

/** The params that open an ask from its queue key. Card ids hold no colon; ask ids are `q<n>`. */
export function askParamsFromKey(key: string): Required<NeedsYouAskParams> | null {
  const at = key.lastIndexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  return { cardId: key.slice(0, at), askId: key.slice(at + 1) };
}

export type NeedsYouBatchParams = {
  readonly boardId?: string | undefined;
  readonly batchKey?: string | undefined;
};

export type NeedsYouQueueParams = {
  /** Only this board's asks. */
  readonly board?: string | undefined;
  /** An ask to open on top, by its queue key: the form the web page's links take (`?ask=<cardId>:<askId>`). */
  readonly ask?: string | undefined;
};

// One ask

export type AskTurn = "owner" | "agent" | "evaluator" | "expired";

export const askTurn = (entry: KanbanAskFeedItem, item: NeedsYouItem): AskTurn =>
  entry.waitsOn === "evaluator"
    ? "evaluator"
    : entry.waitsOn === "owner" && item.expired
      ? "expired"
      : entry.waitsOn === "agent"
        ? "agent"
        : "owner";

export type Tone = "plain" | "accent" | "warn" | "negative";

export interface StatePill {
  readonly key: string;
  readonly label: string;
  readonly tone: Tone;
}

export const MARK_LABELS: Readonly<Record<NeedsYouMark, string>> = {
  reply: "New reply",
  updated: "Updated",
  failed: "Not sent",
  back: "Back",
};

/** The state of an ask in words, in the order the reader lists it under the title. */
export function askStatePills(input: {
  readonly entry: KanbanAskFeedItem;
  readonly item: NeedsYouItem;
  readonly turn: AskTurn;
  readonly mark: NeedsYouMark | undefined;
  readonly nowMs: number;
}): ReadonlyArray<StatePill> {
  const { entry, item, turn, mark } = input;
  const pills: Array<StatePill> = [];
  if (mark === "failed") pills.push({ key: "failed", label: "Not sent", tone: "negative" });
  if (mark === "updated") pills.push({ key: "updated", label: "Updated", tone: "accent" });
  if (mark === "reply") pills.push({ key: "reply", label: "New reply", tone: "accent" });
  if (turn === "agent") pills.push({ key: "agent", label: "Waiting on the agent", tone: "plain" });
  if (turn === "evaluator") {
    pills.push({ key: "evaluator", label: "With the evaluator", tone: "plain" });
  }
  if (turn === "expired") pills.push({ key: "expired", label: "Out of date", tone: "warn" });
  // The band under the title says it, with the time; the pill is only for when there is no band.
  if (mark === "back" && !item.backFromSnoozeAt) {
    pills.push({ key: "back", label: "Back from snooze", tone: "accent" });
  }
  if (item.snoozed && entry.ask.snoozedUntil) {
    pills.push({
      key: "snoozed",
      label: `Snoozed until ${shortWhen(entry.ask.snoozedUntil, input.nowMs)}`,
      tone: "plain",
    });
  }
  if (item.notice) pills.push({ key: "notice", label: "Nothing needed", tone: "plain" });
  else if (item.blocking) {
    pills.push({ key: "holds", label: `Holds #${entry.cardNumber}`, tone: "warn" });
  }
  if (item.unblocks > 0) {
    pills.push({
      key: "unblocks",
      label: `${item.unblocks} ${item.unblocks === 1 ? "card waits" : "cards wait"} behind it`,
      tone: "plain",
    });
  }
  return pills;
}

/** Why the ask sits in the queue, as label and value. */
export function askFacts(
  entry: KanbanAskFeedItem,
  item: NeedsYouItem,
): ReadonlyArray<readonly [name: string, value: string]> {
  const ask = entry.ask;
  const facts: Array<readonly [string, string]> = [["Waiting", askAge(item.ageMs)]];
  if (!item.notice) facts.push(["Holds a card", item.blocking ? "Yes" : "No"]);
  if (item.unblocks > 0) facts.push(["Cards behind it", String(item.unblocks)]);
  if (ask.basis) facts.push(["Rests on", ask.basis]);
  if (ask.expiresAt) {
    const left = Date.parse(ask.expiresAt) - (Date.parse(ask.at) + item.ageMs);
    facts.push(["Good for", left > 0 ? askAge(left) : "Out of date"]);
  }
  if (entry.revision > 0) {
    facts.push(["Edited", entry.revision === 1 ? "Once" : `${entry.revision} times`]);
  }
  return facts;
}

/**
 * A step's link as something he can open: only a web address, named by the
 * site it really leads to. Anything else an agent put there (the app's own
 * scheme, a phone number, another app) is not a link here and opens nothing.
 */
export function stepWebLink(link: string | undefined): WebLink | null {
  return parseWebLink(link);
}

/** What a file field takes, in words: "PDF or images", not "application/pdf, image/*". */
export function acceptsInWords(accepts: ReadonlyArray<string>): string {
  const words = accepts.map((entry) => {
    const type = entry.trim().toLowerCase();
    if (type === "application/pdf" || type === ".pdf") return "PDF";
    if (type === "image/*") return "images";
    if (type === "video/*") return "videos";
    if (type === "audio/*") return "audio";
    if (type === "text/csv" || type === ".csv") return "CSV";
    if (type === "text/plain" || type === ".txt") return "text";
    if (type.startsWith(".")) return type.slice(1).toUpperCase();
    const [, sub = type] = type.split("/");
    return sub === "*" ? type.replace("/*", "") : sub.toUpperCase();
  });
  const unique = [...new Set(words)];
  const said =
    unique.length < 2 ? (unique[0] ?? "") : `${unique.slice(0, -1).join(", ")} or ${unique.at(-1)}`;
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/** Whether a file field takes only pictures or videos: the photo picker serves it best. */
export const acceptsOnlyMedia = (accepts: ReadonlyArray<string> | undefined): boolean =>
  accepts !== undefined &&
  accepts.length > 0 &&
  accepts.every((entry) => /^(image|video)\//i.test(entry.trim()));

/** The order a rank field shows: his order, then any item it does not hold yet. */
export function rankOrder(field: Pick<KanbanAskField, "options">, value: unknown): string[] {
  const known = (field.options ?? []).map((option) => option.id as string);
  const stored = Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && known.includes(id))
    : [];
  return [...new Set(stored), ...known.filter((id) => !stored.includes(id))];
}

/** The order with `id` moved to position `to`; the same array when nothing moves. */
export function moveRank(order: ReadonlyArray<string>, id: string, to: number): string[] {
  const from = order.indexOf(id);
  const target = Math.max(0, Math.min(order.length - 1, to));
  if (from < 0 || from === target) return [...order];
  const next = order.filter((entry) => entry !== id);
  next.splice(target, 0, id);
  return next;
}

/**
 * Whether a value a page handed back becomes the field's value. Never while
 * the answer can't be changed (not his device, expired, handed over, sending):
 * the page keeps running then, and what it posts is dropped.
 */
export const customValueTaken = (
  field: Pick<KanbanAskField, "min" | "max">,
  value: unknown,
  disabled: boolean,
): boolean => !disabled && customValueAccepted(field, value);

/** Whether a value a page handed back fits its custom field's limits. */
export function customValueAccepted(
  field: Pick<KanbanAskField, "min" | "max">,
  value: unknown,
): boolean {
  if (typeof value !== "number") return value !== undefined;
  if (!Number.isFinite(value)) return false;
  if (field.min !== undefined && value < field.min) return false;
  if (field.max !== undefined && value > field.max) return false;
  return true;
}

export const shownValue = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : (JSON.stringify(value) ?? "");

// What an ask shows

export type AskFileKind = FilePreviewKind;

type Attachment = Extract<KanbanAskBlock, { _tag: "attachment" }>["attachment"];

export const askFileKind = (attachment: Attachment): AskFileKind =>
  attachment.type === "image"
    ? "image"
    : filePreviewKind({ name: attachment.name, mimeType: attachment.mimeType });

export interface AskPicture {
  /** Index of its block in the ask. */
  readonly block: number;
  readonly name: string;
  readonly caption: string | null;
  readonly source:
    | { readonly _tag: "url"; readonly url: string }
    | { readonly _tag: "attachment"; readonly attachment: Attachment };
}

export interface AskShown {
  /** The ask's pictures in the order it shows them: one gallery for the full-size viewer. */
  readonly pictures: ReadonlyArray<AskPicture>;
  /** Where a block sits in `pictures`. */
  readonly pictureOf: ReadonlyMap<number, number>;
  /** Text blocks that are the caption of the picture or file before them. */
  readonly captions: ReadonlySet<number>;
}

const shortCaption = (block: KanbanAskBlock | undefined): string | null =>
  block?._tag === "md" && block.truncated !== true && block.text.length <= 240 ? block.text : null;

/** A picture URL the phone can load: https, or an inline raster image. */
export const isLoadablePicture = (url: string): boolean =>
  /^https:\/\//i.test(url) || /^data:image\/(png|jpe?g|gif|webp);/i.test(url);

/** The pictures an ask shows and the short texts that caption them. */
export function askShown(blocks: ReadonlyArray<KanbanAskBlock>): AskShown {
  const pictures: Array<AskPicture> = [];
  const pictureOf = new Map<number, number>();
  const captions = new Set<number>();
  blocks.forEach((block, index) => {
    const caption = shortCaption(blocks[index + 1]);
    if (block._tag === "image") {
      if (!isLoadablePicture(block.url)) return;
      if (caption !== null) captions.add(index + 1);
      pictureOf.set(index, pictures.length);
      pictures.push({
        block: index,
        name: block.alt ?? "Picture",
        caption: caption ?? block.alt ?? null,
        source: { _tag: "url", url: block.url },
      });
      return;
    }
    if (block._tag !== "attachment") return;
    const kind = askFileKind(block.attachment);
    if (kind === "image") {
      if (caption !== null) captions.add(index + 1);
      pictureOf.set(index, pictures.length);
      pictures.push({
        block: index,
        name: block.attachment.name,
        caption,
        source: { _tag: "attachment", attachment: block.attachment },
      });
    } else if (kind === "video" && caption !== null) {
      captions.add(index + 1);
    }
  });
  return { pictures, pictureOf, captions };
}

/** What a row hints at beside its title: pictures and a video to look at. */
export function askRowMedia(blocks: ReadonlyArray<KanbanAskBlock> | undefined): {
  readonly pictures: number;
  readonly video: boolean;
} {
  const list = blocks ?? [];
  return {
    pictures: list.filter(
      (block) =>
        block._tag === "image" ||
        (block._tag === "attachment" && block.attachment.type === "image"),
    ).length,
    video: list.some(
      (block) => block._tag === "attachment" && block.attachment.mimeType.startsWith("video/"),
    ),
  };
}

// The queue as a list

export type QueueRow =
  | {
      readonly _tag: "section";
      readonly key: string;
      readonly label: string;
      readonly count: number;
    }
  | {
      readonly _tag: "ask";
      readonly key: string;
      readonly item: NeedsYouItem;
      /** Inside an unfolded batch. */
      readonly nested: boolean;
      readonly last: boolean;
    }
  | {
      readonly _tag: "batch";
      readonly key: string;
      readonly entry: Extract<NeedsYouEntry, { _tag: "batch" }>;
      readonly open: boolean;
      readonly last: boolean;
    };

/** The sections flattened for a virtual list: a heading, then its rows; an open batch lists its asks. */
export function queueRows(
  sections: ReadonlyArray<NeedsYouSection>,
  openBatches: ReadonlySet<string>,
): ReadonlyArray<QueueRow> {
  const rows: Array<QueueRow> = [];
  for (const section of sections) {
    rows.push({
      _tag: "section",
      key: `section:${section.id}`,
      label: section.label,
      count: section.count,
    });
    section.entries.forEach((entry, index) => {
      const last = index === section.entries.length - 1;
      if (entry._tag === "ask") {
        rows.push({ _tag: "ask", key: entry.item.key, item: entry.item, nested: false, last });
        return;
      }
      const key = needsYouBatchKey(entry);
      const open = openBatches.has(key);
      rows.push({ _tag: "batch", key, entry, open, last: last && !open });
      if (!open) return;
      entry.items.forEach((item, at) => {
        rows.push({
          _tag: "ask",
          key: item.key,
          item,
          nested: true,
          last: last && at === entry.items.length - 1,
        });
      });
    });
  }
  return rows;
}

/** Every open ask by its key, whichever list it sits in. */
export function needsYouItemsByKey(needsYou: NeedsYou): ReadonlyMap<string, NeedsYouItem> {
  const map = new Map<string, NeedsYouItem>();
  for (const list of [
    needsYou.items,
    needsYou.expired,
    needsYou.waitingOnAgent,
    needsYou.withEvaluator,
    needsYou.snoozed,
    needsYou.notices,
  ]) {
    for (const item of list) map.set(item.key, item);
  }
  return map;
}

/** The asks before and after `key` in the order the queue lists single asks. */
export function askNeighbours(
  order: ReadonlyArray<string>,
  key: string,
): { readonly previous: string | null; readonly next: string | null } {
  const asks = order.filter((entry) => !entry.startsWith("batch:"));
  const at = asks.indexOf(key);
  if (at < 0) return { previous: null, next: asks[0] ?? null };
  return { previous: asks[at - 1] ?? null, next: asks[at + 1] ?? null };
}

/** Boards with asks to answer, most first, for the board filter. */
export function boardChips(
  open: ReadonlyArray<Pick<KanbanAskFeedItem, "boardId" | "boardName">>,
  owed: ReadonlyArray<Pick<NeedsYouItem, "boardId">>,
): ReadonlyArray<{ readonly id: string; readonly name: string; readonly count: number }> {
  const names = new Map(open.map((entry) => [entry.boardId, entry.boardName]));
  return [...names]
    .map(([id, name]) => ({
      id,
      name,
      count: owed.filter((item) => item.boardId === id).length,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Batches

/** How a batch names the asks one answer goes to: "this one", "both", "all 4", "these 3". */
export function batchAll(count: number, offered: number): string {
  if (count === 1) return "this one";
  if (count < offered) return `these ${count}`;
  return count === 2 ? "both" : `all ${count}`;
}

export const batchPrimaryLabel = (shape: string, approve: string, all: string): string =>
  shape === "ack" ? `Seen, ${all}` : shape === "verdict" ? `${approve} ${all}` : `Send to ${all}`;

// History

export interface HistoryRows {
  /** Answers of this session the closed list does not carry yet, or never will (a hand-over). */
  readonly session: ReadonlyArray<AskSend>;
  readonly today: ReadonlyArray<{
    readonly entry: KanbanAskFeedItem;
    readonly outcome: AskOutcome;
  }>;
  readonly earlier: ReadonlyArray<{
    readonly entry: KanbanAskFeedItem;
    readonly outcome: AskOutcome;
  }>;
}

const sameLocalDay = (iso: string, nowMs: number): boolean => {
  const at = new Date(iso);
  const now = new Date(nowMs);
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
};

/** What he answered, split into this session, today and earlier. */
export function historyRows(
  closed: ReadonlyArray<KanbanAskFeedItem> | null,
  sent: ReadonlyArray<AskSend>,
  nowMs: number,
): HistoryRows {
  const rows = (closed ?? []).flatMap((entry) => {
    const outcome = askOutcome(entry.ask);
    return outcome === null || entry.ask.answer === undefined ? [] : [{ entry, outcome }];
  });
  return {
    session: sent.filter((send) => send.state !== "sent" || send.kind === "hand"),
    today: rows.filter((row) => sameLocalDay(row.entry.ask.answer!.at, nowMs)),
    earlier: rows.filter((row) => !sameLocalDay(row.entry.ask.answer!.at, nowMs)),
  };
}

// Offline

/** The least time between an answer failing to reach the server and its going again by itself. */
export const ASK_AUTO_RETRY_GAP_MS = 5_000;

/**
 * Decides which answers that never reached the server go again by themselves.
 * An answer is due once the feed has been read with success after it failed:
 * that read says the server can be reached. It does not matter whether the
 * feed ever failed, or whether the answer was still on its way when the feed
 * came back, so a short outage that only hit the answer is covered too.
 *
 * Two things keep this from hammering a server that takes reads and drops
 * writes. The read has to come a while after the failure
 * (`ASK_AUTO_RETRY_GAP_MS`): the read the store makes right after a failed
 * send does not count. And each answer goes by itself a few times at most; the
 * shared store keeps that count on the answer (`ASK_AUTO_RETRY_MAX`). Retry by
 * hand always stays.
 *
 * `next` is called on every change of the store with the time now, and gives
 * the ids of the sends that are due.
 */
export function unreachedRetryTracker(
  gapMs: number = ASK_AUTO_RETRY_GAP_MS,
  max: number = ASK_AUTO_RETRY_MAX,
): {
  readonly next: (
    state: Pick<AskState, "failed" | "reads" | "status" | "error">,
    nowMs: number,
  ) => ReadonlySet<number>;
} {
  // When each unsent answer was first seen as failed, by its send id.
  const failedAt = new Map<number, number>();
  let reads = 0;
  return {
    next: (state, nowMs) => {
      const waiting = new Map<number, AskSend>();
      for (const failed of Object.values(state.failed)) {
        if (failed.unreached === true) waiting.set(failed.send.id, failed.send);
      }
      for (const id of Array.from(failedAt.keys())) if (!waiting.has(id)) failedAt.delete(id);
      for (const id of waiting.keys()) if (!failedAt.has(id)) failedAt.set(id, nowMs);
      const readAgain = state.reads > reads && state.status === "ready" && state.error === null;
      reads = state.reads;
      const due = new Set<number>();
      if (!readAgain) return due;
      for (const [id, send] of waiting) {
        if ((send.autoRetries ?? 0) >= max) continue;
        if (nowMs - (failedAt.get(id) ?? nowMs) >= gapMs) due.add(id);
      }
      return due;
    },
  };
}

/**
 * What "Needs you" on the thread list shows beside its name. A count is shown
 * only when one is known. Before the first read there is none; when the read
 * failed it says "Not loaded"; a count held from an earlier read carries the
 * time it was read. It never shows nothing as if nothing needed him.
 */
export function homeRowCount(
  figures: AskFigures,
  count: number,
  holding: boolean,
  nowMs: number,
): {
  /** The number in the pill; null when none is shown. */
  readonly count: number | null;
  /** Quiet words beside it: "Not loaded", "as of 17:42". */
  readonly note: string | null;
  readonly accessibilityLabel: string;
} {
  if (figures.state === "unknown") {
    return figures.failed
      ? { count: null, note: "Not loaded", accessibilityLabel: "Needs you, not loaded" }
      : { count: null, note: null, accessibilityLabel: "Needs you, loading" };
  }
  const said = `Needs you, ${count} to answer${holding ? ", some hold a card" : ""}`;
  const pill = count > 0 ? count : null;
  const asOf = askFiguresAsOf(figures, nowMs);
  return asOf === null
    ? { count: pill, note: null, accessibilityLabel: said }
    : { count: pill, note: asOf, accessibilityLabel: `${said}, ${asOf}, may be out of date` };
}

/**
 * The line under the queue's title: how many are his, can't be shown, wait on
 * agents, are put away. Nothing while that is not known; held figures start
 * with the time they were read.
 */
export function queueSubtitle(
  figures: AskFigures,
  counts: {
    readonly owed: number;
    readonly unreadable: number;
    readonly waiting: number;
    readonly snoozed: number;
  },
  nowMs: number,
): string | undefined {
  if (figures.state === "unknown") return undefined;
  const asOf = askFiguresAsOf(figures, nowMs);
  return [
    asOf === null ? null : `${asOf[0]!.toUpperCase()}${asOf.slice(1)}`,
    `${counts.owed} to answer`,
    counts.unreadable > 0 ? `${counts.unreadable} can't be shown` : null,
    counts.waiting > 0 ? `${counts.waiting} waiting on agents` : null,
    counts.snoozed > 0 ? `${counts.snoozed} snoozed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The Needs-you screens that draw the toast (`AskToastBar`), by route name. */
export const ASK_TOAST_ROUTES: ReadonlySet<string> = new Set([
  "NeedsYou",
  "NeedsYouAsk",
  "NeedsYouBatch",
  "NeedsYouHistory",
]);

/**
 * Where an ask's screen goes once he has answered, snoozed or handed it over.
 * What he just did shows in the toast, with Undo for the seconds an answer is
 * held, and only the Needs-you screens draw it. So it goes back only when the
 * screen underneath is one of them. An ask opened by a link sits on Home, a
 * card or a discussion, or on nothing at all when the link started the app:
 * then it goes to the queue, which shows the toast and what is left to answer.
 *
 * `routes` are the stack's route names from the bottom, `index` the screen he
 * is on. `back`: the screen underneath. `queue`: the queue already lower in
 * the stack. `newQueue`: the queue, in this screen's place.
 */
export function leaveAfterAnswer(
  routes: ReadonlyArray<string>,
  index: number,
): "back" | "queue" | "newQueue" {
  const under = routes.slice(0, Math.max(0, index));
  const previous = under.at(-1);
  if (previous !== undefined && ASK_TOAST_ROUTES.has(previous)) return "back";
  return under.includes("NeedsYou") ? "queue" : "newQueue";
}

/**
 * What the toast's Undo would do now. `held`: cancel an answer that is still
 * only held on this phone; nothing is sent, so it is always his to do.
 * `write`: bring back asks a snooze put away, which is a write to the server
 * and so only for a phone known to be his (`toastUndoAllowed`). Null: the
 * toast has nothing to undo.
 */
export function toastUndo(
  toast: Pick<AskToast, "undoSendId" | "undoSnooze"> | null,
  heldId: number | null,
): "held" | "write" | null {
  if (toast === null) return null;
  if (toast.undoSendId !== undefined && heldId === toast.undoSendId) return "held";
  if (toast.undoSnooze !== undefined) return "write";
  return null;
}

/** Whether Undo is offered: always for a held answer, for a write only to the owner. */
export const toastUndoAllowed = (undo: "held" | "write" | null, standing: OwnerStanding): boolean =>
  undo === "held" || (undo === "write" && standing === "owner");

/**
 * Where a screen stands when a call it started comes back. The server may have
 * changed and he may have left or opened something on top while it was away.
 *
 * - `here`: its own server is still in use and it is the screen in front.
 * - `away`: its own server is still in use, but the screen is closed or
 *   covered. The store may be told the result; nothing navigates, buzzes,
 *   scrolls or speaks.
 * - `gone`: its server is no longer the one in use. Nothing happens at all.
 */
export type LateStanding = "here" | "away" | "gone";

export function lateStanding(now: {
  readonly live: boolean;
  readonly mounted: boolean;
  readonly focused: boolean;
}): LateStanding {
  if (!now.live) return "gone";
  return now.mounted && now.focused ? "here" : "away";
}

/**
 * Whether this phone may answer. Only `owner` turns the controls on.
 *
 * - `checking`: the session has not been read yet.
 * - `unchecked`: the session could not be read, or does not say.
 * - `owner`: the session says it is his.
 * - `notOwner`: the session says it is not, or the server refused an answer for that reason.
 */
export type OwnerStanding = "checking" | "unchecked" | "owner" | "notOwner";

/** What is known of the session: still being read, not readable, or read. */
export type SessionRead =
  | { readonly state: "reading" }
  | { readonly state: "failed" }
  | {
      readonly state: "read";
      readonly authenticated: boolean;
      /** Absent when the server does not say. */
      readonly owner: boolean | undefined;
    };

export function ownerStanding(
  session: SessionRead,
  refused: boolean,
  /**
   * The session said owner earlier in this run of the app and nothing has said
   * otherwise since (`ownerSeen` in the store).
   */
  seen: boolean = false,
): OwnerStanding {
  // The server refused an answer as not the owner's: that beats what the session said before.
  if (refused) return "notOwner";
  // No connection, or the session is on its way: it can't say anything new. A phone that
  // was confirmed as his stays so, and what he answers waits as "Not sent"; the server
  // still refuses if that changed. A phone never confirmed stays "checking".
  if (session.state === "reading") return seen ? "owner" : "checking";
  if (session.state === "failed") return "unchecked";
  // Signed out, or a server that does not say: not known to be his, so not his to answer.
  if (!session.authenticated || session.owner === undefined) return "unchecked";
  return session.owner ? "owner" : "notOwner";
}

/** The line in place of the answer controls while they are off. */
export function ownerStandingBarText(
  standing: Exclude<OwnerStanding, "owner">,
  what: "answer" | "reply",
): string {
  if (standing === "checking") return "Checking that this phone is yours…";
  if (standing === "unchecked") return "Couldn't check that this phone is yours.";
  return what === "answer"
    ? "This phone can read asks, not answer them."
    : "This phone can read asks, not reply to them.";
}
