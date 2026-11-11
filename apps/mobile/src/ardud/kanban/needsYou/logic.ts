/**
 * What the phone's Needs-you screens work out for themselves, kept apart from
 * the views so it can be tested: route params, whose turn an ask is on, the
 * marks a row shows, the queue as list rows, the bridge to a page inside an
 * ask, and when an answer made offline goes again. Pure.
 */
import {
  askAge,
  askOutcome,
  needsYouBatchKey,
  shortWhen,
  type AskOutcome,
  type AskSend,
  type NeedsYou,
  type NeedsYouEntry,
  type NeedsYouItem,
  type NeedsYouMark,
  type NeedsYouSection,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskBlock, KanbanAskFeedItem, KanbanAskField } from "@t3tools/contracts";
import { filePreviewKind, type FilePreviewKind } from "@t3tools/shared/filePreview";
import { readHtmlRenderContentHeight } from "@t3tools/shared/htmlRender";

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

/** The site a step's link opens, without the scheme: "appstoreconnect.apple.com". */
export function linkHost(link: string): string {
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(link.trim())?.[1];
  return host ? host.replace(/^www\./, "") : "the link";
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

// A page inside an ask

/**
 * Runs inside the page before its own scripts. A page talks to its host with
 * `parent.postMessage`; in a WebView the page is its own parent, so every
 * message it posts to itself is passed on to the app. A page in a frame tells
 * its host how tall it is; here it has no frame, so this says it instead. The
 * page gets nothing back but the theme: no token, no cookie, no way to call
 * the app.
 */
export const ASK_HTML_BRIDGE = `(function(){if(window.__robobAsk)return;window.__robobAsk=true;function send(d){try{window.ReactNativeWebView.postMessage(typeof d==="string"?d:JSON.stringify(d));}catch(_){}}window.addEventListener("message",function(e){var d=e.data;if(d===undefined||d===null)return;send(d);});var last;function size(){var r=document.documentElement;if(!r)return;var v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(!v||v===last)return;last=v;send({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:v}});}document.addEventListener("DOMContentLoaded",function(){size();if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(document.documentElement);if(document.body)o.observe(document.body);}});window.addEventListener("load",size);})();true;`;

export type AskHtmlMessage =
  | { readonly _tag: "value"; readonly value: unknown }
  | { readonly _tag: "height"; readonly height: number };

/**
 * What a page inside an ask told the app: a value for a custom field
 * (`{ type: "robob.ask.value", value }`, or the older `{ robobPick }`), or how
 * tall it is. Anything else is ignored.
 */
export function readAskHtmlMessage(raw: string): AskHtmlMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const message = data as { type?: unknown; value?: unknown; robobPick?: unknown };
  if (message.type === "robob.ask.value" && "value" in message) {
    return { _tag: "value", value: message.value };
  }
  if (typeof message.robobPick === "number") return { _tag: "value", value: message.robobPick };
  const height = readHtmlRenderContentHeight(data);
  return height === undefined ? null : { _tag: "height", height };
}

/** Whether a page may load `url` in place: only itself. Everything else opens outside the app. */
export const askHtmlStaysInFrame = (url: string): boolean =>
  url === "about:blank" || url === "about:srcdoc" || url.startsWith("data:");

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

/** At most this many automatic tries of an answer that never reached the server. */
export const UNREACHED_RETRY_ROUNDS = 3;

/**
 * Decides when answers that never reached the server go again by themselves:
 * once each time the feed goes from failing to reading, and at most a few
 * rounds, so a server that takes reads and drops writes is not hammered. Retry
 * by hand always stays. The count starts over once nothing is left unsent.
 */
export function unreachedRetryGate(maxRounds: number = UNREACHED_RETRY_ROUNDS): {
  readonly next: (state: { readonly reading: boolean; readonly unreached: boolean }) => boolean;
} {
  let wasReading = true;
  let rounds = 0;
  return {
    next: ({ reading, unreached }) => {
      const cameBack = reading && !wasReading;
      wasReading = reading;
      if (!unreached) {
        rounds = 0;
        return false;
      }
      if (!cameBack || rounds >= maxRounds) return false;
      rounds += 1;
      return true;
    },
  };
}
