// Pure helpers for mission rooms (design v3 §5): the room list with unread
// counts and noise, the open room's timeline with read marker and folded
// status posts, broadcast receipts, and the owner composer. Shared by web and
// mobile; no React, no I/O.

import type {
  BroadcastReceipt,
  MissionActor,
  MissionId,
  MissionMessage,
  MissionMessageKind,
  PostMessageInput,
  Room,
  RoomKind,
  RoomNoise,
  RoomPage,
  Subscription,
  UpsertRuleInput,
} from "@t3tools/contracts";

import type { LoadRoomPageInput, MissionRoomEntry } from "./source.ts";
import { actorKey, actorLabel } from "./viewModel.ts";

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

/** Contract `MissionSummaryText` limit. */
export const MESSAGE_MAX_CHARS = 400;
export const ROOM_OLDER_PAGE_SIZE = 40;

// ---------------------------------------------------------------------------
// Room list

export type RoomGroupKey = "sub-mission" | "work-item" | "standing";

export const ROOM_GROUP_LABEL: Record<RoomGroupKey, string> = {
  "sub-mission": "Sub-missions",
  "work-item": "Work items",
  standing: "Control, release and arch",
};

const ROOM_GROUP_OF: Record<RoomKind, RoomGroupKey> = {
  "sub-mission": "sub-mission",
  lane: "sub-mission",
  "work-item": "work-item",
  control: "standing",
  release: "standing",
  arch: "standing",
  custom: "standing",
  // ardud missions: router (request rooms are not listed; they live under "Your requests")
  "owner-request": "standing",
};

const STANDING_ORDER: Record<RoomKind, number> = {
  control: 0,
  release: 1,
  arch: 2,
  custom: 3,
  "sub-mission": 4,
  lane: 5,
  "work-item": 6,
  // ardud missions: router
  "owner-request": 7,
};

export const ROOM_KIND_LABEL: Record<RoomKind, string> = {
  "sub-mission": "Sub-mission",
  "work-item": "Work item",
  control: "Control",
  release: "Release",
  arch: "Arch",
  lane: "Lane",
  custom: "Room",
  // ardud missions: router
  "owner-request": "Request",
};

export interface RoomGroup {
  readonly key: RoomGroupKey;
  readonly label: string;
  readonly rooms: ReadonlyArray<MissionRoomEntry>;
  readonly unread: number;
}

/**
 * Rooms grouped as the design lists them: sub-mission rooms, work-item rooms,
 * then the standing control / release / arch rooms. Within a group, newest
 * activity first, except standing rooms which keep a fixed order.
 */
export function groupRooms(entries: ReadonlyArray<MissionRoomEntry>): RoomGroup[] {
  const order: ReadonlyArray<RoomGroupKey> = ["sub-mission", "work-item", "standing"];
  return order
    .map((key) => {
      const rooms = entries
        .filter((entry) => !entry.room.archived && ROOM_GROUP_OF[entry.room.kind] === key)
        .sort((left, right) =>
          key === "standing"
            ? STANDING_ORDER[left.room.kind] - STANDING_ORDER[right.room.kind] ||
              left.room.title.localeCompare(right.room.title)
            : (right.room.lastMessageAt ?? "").localeCompare(left.room.lastMessageAt ?? "") ||
              left.room.title.localeCompare(right.room.title),
        );
      return {
        key,
        label: ROOM_GROUP_LABEL[key],
        rooms,
        unread: rooms.reduce((sum, entry) => sum + entry.unread, 0),
      };
    })
    .filter((group) => group.rooms.length > 0);
}

export function totalUnread(entries: ReadonlyArray<MissionRoomEntry>): number {
  return entries.reduce((sum, entry) => sum + (entry.room.archived ? 0 : entry.unread), 0);
}

/** Room names the way the coordinator says them: "#delivery", "#CRP-12350 · …". */
export function roomName(room: Pick<Room, "title">): string {
  return room.title.startsWith("#") ? room.title : `#${room.title}`;
}

export type NoiseTone = "calm" | "busy" | "noisy";

export interface NoiseView {
  readonly rate: string;
  readonly actionable: string;
  readonly wastedWakes: string;
  readonly tone: NoiseTone;
  /** One line for the room header and list: "48.8/h · 53% actionable · 588 wasted wakes". */
  readonly line: string;
}

/** A room is noisy when most posts need nobody, or wakes are mostly wasted. */
export const NOISY_ACTIONABLE_SHARE = 0.35;
export const BUSY_MESSAGES_PER_HOUR = 20;

function formatRate(perHour: number): string {
  if (perHour >= 10) return `${Math.round(perHour)}/h`;
  return `${(Math.round(perHour * 10) / 10).toFixed(1)}/h`;
}

export function noiseView(noise: RoomNoise | null): NoiseView | null {
  if (noise === null) return null;
  const rate = formatRate(noise.messagesPerHour);
  const actionable = `${Math.round(noise.actionableShare * 100)}% actionable`;
  const wastedWakes = `${noise.wastedWakes} wasted ${noise.wastedWakes === 1 ? "wake" : "wakes"}`;
  const tone: NoiseTone =
    noise.actionableShare < NOISY_ACTIONABLE_SHARE
      ? "noisy"
      : noise.messagesPerHour >= BUSY_MESSAGES_PER_HOUR || noise.wastedWakes > 100
        ? "busy"
        : "calm";
  return { rate, actionable, wastedWakes, tone, line: `${rate} · ${actionable} · ${wastedWakes}` };
}

// ---------------------------------------------------------------------------
// Timeline

export const MESSAGE_KIND_LABEL: Record<MissionMessageKind, string> = {
  request: "Request",
  decision: "Decision",
  status: "Status",
  evidence: "Evidence",
  blocker: "Blocker",
  control: "Control",
};

/** Merges a page of older messages into what is loaded; seq order, no duplicates. */
export function mergeMessages(
  loaded: ReadonlyArray<MissionMessage>,
  incoming: ReadonlyArray<MissionMessage>,
): MissionMessage[] {
  const bySeq = new Map<number, MissionMessage>();
  for (const message of loaded) bySeq.set(message.seq, message);
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

/** The next older page to ask for, or `null` when the start of the room is loaded. */
export function olderPageRequest(
  roomId: Room["id"],
  loaded: ReadonlyArray<MissionMessage>,
  hasOlder: boolean,
  limit = ROOM_OLDER_PAGE_SIZE,
): LoadRoomPageInput | null {
  const first = loaded[0];
  if (!hasOlder || first === undefined) return null;
  return { roomId, beforeSeq: first.seq, limit };
}

export type TimelineRow =
  | { readonly kind: "message"; readonly key: string; readonly message: MissionMessage }
  | {
      readonly kind: "status-run";
      readonly key: string;
      readonly messages: ReadonlyArray<MissionMessage>;
      readonly expanded: boolean;
    }
  | { readonly kind: "read-marker"; readonly key: string; readonly unread: number }
  | { readonly kind: "day"; readonly key: string; readonly day: string };

export interface TimelineOptions {
  /** Status runs the owner opened, by run key. */
  readonly expandedRuns?: ReadonlySet<string>;
  /** Shortest run of status posts that folds. Single ones stay inline but compact. */
  readonly minRun?: number;
  /** Day label for a message, e.g. "Sat 17 Oct"; no day rows when omitted. */
  readonly dayOf?: (iso: string) => string;
}

/**
 * Rows for the open room, oldest first (newest at the bottom). Runs of
 * consecutive status posts fold into one row, collapsed unless the owner
 * opened it; the read marker sits before the first message past the owner's
 * read position that someone else wrote.
 */
export function roomTimeline(
  messages: ReadonlyArray<MissionMessage>,
  ownerReadSeq: number,
  options: TimelineOptions = {},
): TimelineRow[] {
  const minRun = options.minRun ?? 2;
  const expanded = options.expandedRuns ?? new Set<string>();
  const rows: TimelineRow[] = [];
  const unread = messages.filter(
    (message) => message.seq > ownerReadSeq && message.author._tag !== "owner",
  );
  const markerSeq = unread[0]?.seq ?? null;
  let run: MissionMessage[] = [];
  let lastDay: string | null = null;

  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length < minRun) {
      for (const message of run) rows.push({ kind: "message", key: message.id, message });
    } else {
      const key = `status:${run[0]!.seq}`;
      rows.push({ kind: "status-run", key, messages: run, expanded: expanded.has(key) });
    }
    run = [];
  };

  for (const message of messages) {
    const day = options.dayOf?.(message.createdAt) ?? null;
    const startsDay = day !== null && day !== lastDay;
    if (message.seq === markerSeq || startsDay) flushRun();
    if (startsDay) {
      rows.push({ kind: "day", key: `day:${day}`, day });
      lastDay = day;
    }
    if (message.seq === markerSeq) {
      rows.push({ kind: "read-marker", key: "read-marker", unread: unread.length });
    }
    if (message.kind === "status") {
      run.push(message);
      continue;
    }
    flushRun();
    rows.push({ kind: "message", key: message.id, message });
  }
  flushRun();
  return rows;
}

/** "Scribe folded 14 status posts. Nobody was woken by them." */
export function statusRunLine(count: number): string {
  return `${count} status ${count === 1 ? "post" : "posts"} folded. Status wakes nobody.`;
}

/** The read position to store once the owner has seen up to `seenSeq`; `null` if it would not move forward. */
export function nextReadSeq(ownerReadSeq: number, seenSeq: number | null): number | null {
  return seenSeq !== null && seenSeq > ownerReadSeq ? seenSeq : null;
}

export function newestSeq(messages: ReadonlyArray<MissionMessage>): number | null {
  return messages[messages.length - 1]?.seq ?? null;
}

// ---------------------------------------------------------------------------
// Message details

export interface ReceiptView {
  /** "reached 21 of 21" */
  readonly label: string;
  readonly complete: boolean;
  /** "waiting on cell-bal, cell-fab-tc" or null when everyone has it. */
  readonly pending: string | null;
}

export function receiptView(receipt: BroadcastReceipt | null): ReceiptView | null {
  if (receipt === null) return null;
  const complete = receipt.pending.length === 0 && receipt.reached >= receipt.total;
  return {
    label: `reached ${receipt.reached} of ${receipt.total}`,
    complete,
    pending: receipt.pending.length === 0 ? null : `waiting on ${receipt.pending.join(", ")}`,
  };
}

/** "master → cell-risk" style header; empty `to` means the room's subscribers. */
export function messageAddressLine(
  message: Pick<MissionMessage, "author" | "to" | "isCorrection">,
  masterRoleId: string | null,
): string {
  const from = actorLabel(message.author, masterRoleId);
  if (message.isCorrection) return `${from} → master (correction)`;
  if (message.to.length === 0) return from;
  return `${from} → ${message.to.map((actor) => actorLabel(actor, masterRoleId)).join(", ")}`;
}

// ---------------------------------------------------------------------------
// Members and wake rules

export interface RoomMember {
  readonly key: string;
  readonly actor: MissionActor;
  readonly label: string;
  readonly mode: Subscription["mode"];
  readonly wakeOn: ReadonlyArray<MissionMessageKind>;
}

/** Members other than the owner, waking ones first, A-Z. */
export function roomMembers(
  subscriptions: ReadonlyArray<Subscription>,
  masterRoleId: string | null,
): RoomMember[] {
  const modeRank: Record<Subscription["mode"], number> = { wake: 0, read: 1, mute: 2 };
  return subscriptions
    .filter((subscription) => subscription.subscriber._tag !== "owner")
    .map((subscription) => ({
      key: actorKey(subscription.subscriber),
      actor: subscription.subscriber,
      label: actorLabel(subscription.subscriber, masterRoleId),
      mode: subscription.mode,
      wakeOn: subscription.wakeOn,
    }))
    .sort(
      (left, right) =>
        modeRank[left.mode] - modeRank[right.mode] || left.label.localeCompare(right.label),
    );
}

/** Who a post of this kind would wake if sent to the whole room. */
export function wakesFor(
  members: ReadonlyArray<RoomMember>,
  kind: MissionMessageKind,
): ReadonlyArray<RoomMember> {
  return members.filter((member) => member.mode === "wake" && member.wakeOn.includes(kind));
}

// ---------------------------------------------------------------------------
// Composer

export type ComposerTarget =
  | { readonly kind: "room" }
  | { readonly kind: "lane"; readonly member: Pick<RoomMember, "actor" | "label"> }
  | { readonly kind: "correction" };

export const COMPOSER_TARGET_LABEL: Record<ComposerTarget["kind"], string> = {
  room: "Room",
  lane: "One lane",
  correction: "Correct master",
};

/**
 * Message kind for an owner post. A room-wide post is a control (it wakes the
 * named members and comes back with a receipt), a post to one lane is a
 * request to that lane, and a correction is a control to the master.
 */
export function ownerMessageKind(target: ComposerTarget): MissionMessageKind {
  return target.kind === "lane" ? "request" : "control";
}

export interface ComposerState {
  readonly remaining: number;
  readonly overLimit: boolean;
  readonly canSend: boolean;
}

export function composerState(text: string): ComposerState {
  const length = text.trim().length;
  const remaining = MESSAGE_MAX_CHARS - length;
  return { remaining, overLimit: remaining < 0, canSend: length > 0 && remaining >= 0 };
}

export function postMessageInput(
  room: Pick<Room, "id" | "missionId" | "archived">,
  target: ComposerTarget,
  text: string,
): Result<PostMessageInput> {
  const summary = text.trim();
  if (room.archived) return err("This room is archived.");
  if (summary === "") return err("Write a message first.");
  if (summary.length > MESSAGE_MAX_CHARS) {
    return err(`Keep it under ${MESSAGE_MAX_CHARS} characters (${summary.length} now).`);
  }
  const base = { missionId: room.missionId, roomId: room.id, kind: ownerMessageKind(target) };
  switch (target.kind) {
    case "room":
      return ok({ ...base, summary } as PostMessageInput);
    case "lane":
      return ok({ ...base, summary, to: [target.member.actor] } as PostMessageInput);
    case "correction":
      return ok({ ...base, summary, isCorrection: true } as PostMessageInput);
  }
}

const RULE_TITLE_MAX = 80;

/**
 * "Save as a rule?" after a correction: the owner's words stay the quote
 * verbatim; the title is the first sentence, shortened.
 */
export function ruleFromCorrection(
  missionId: MissionId,
  message: Pick<MissionMessage, "summary" | "isCorrection">,
): UpsertRuleInput | null {
  if (!message.isCorrection) return null;
  const quote = message.summary.trim();
  if (quote === "") return null;
  const firstSentence = quote.split(/(?<=[.!?])\s/)[0] ?? quote;
  const title =
    firstSentence.length <= RULE_TITLE_MAX
      ? firstSentence.replace(/[.!?]$/, "")
      : `${firstSentence.slice(0, RULE_TITLE_MAX - 1).trimEnd()}…`;
  return { missionId, title, quote } as UpsertRuleInput;
}

/** The newest owner correction in a room that has not been offered as a rule yet. */
export function pendingRuleOffer(
  page: Pick<RoomPage, "messages">,
  offered: ReadonlySet<string>,
): MissionMessage | null {
  for (let index = page.messages.length - 1; index >= 0; index--) {
    const message = page.messages[index];
    if (message && message.isCorrection && message.author._tag === "owner") {
      return offered.has(message.id) ? null : message;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Open room screen state

/**
 * What the open-room screen remembers between renders. Shared by web and
 * mobile. The read marker is pinned to where the owner was when the room
 * opened, so marking the room read on open does not make it vanish.
 */
export interface RoomUiState {
  readonly roomId: string | null;
  /** Owner read position when the room opened; the marker stays here. */
  readonly markerSeq: number | null;
  /** Older pages loaded on scroll, oldest first. */
  readonly older: ReadonlyArray<MissionMessage>;
  /** An older page came back with nothing before it. */
  readonly olderExhausted: boolean;
  readonly loadingOlder: boolean;
  readonly expandedRuns: ReadonlySet<string>;
  readonly target: ComposerTarget;
  readonly text: string;
  /** Corrections already offered as a rule (saved or waved off). */
  readonly offeredRuleIds: ReadonlySet<string>;
}

export const INITIAL_ROOM_UI: RoomUiState = {
  roomId: null,
  markerSeq: null,
  older: [],
  olderExhausted: false,
  loadingOlder: false,
  expandedRuns: new Set(),
  target: { kind: "room" },
  text: "",
  offeredRuleIds: new Set(),
};

export type RoomUiEvent =
  | { readonly type: "open"; readonly roomId: string | null }
  | { readonly type: "page"; readonly page: Pick<RoomPage, "room" | "ownerReadSeq"> }
  | { readonly type: "older-start" }
  | { readonly type: "older-done"; readonly page: Pick<RoomPage, "messages" | "hasOlder"> }
  | { readonly type: "older-failed" }
  | { readonly type: "toggle-run"; readonly key: string }
  | { readonly type: "target"; readonly target: ComposerTarget }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "sent" }
  | { readonly type: "rule-offered"; readonly messageId: string };

export function roomUiReducer(state: RoomUiState, event: RoomUiEvent): RoomUiState {
  switch (event.type) {
    case "open":
      return event.roomId === state.roomId
        ? state
        : {
            ...INITIAL_ROOM_UI,
            roomId: event.roomId,
            offeredRuleIds: state.offeredRuleIds,
          };
    case "page":
      if (event.page.room.id !== state.roomId || state.markerSeq !== null) return state;
      return { ...state, markerSeq: event.page.ownerReadSeq };
    case "older-start":
      return state.loadingOlder ? state : { ...state, loadingOlder: true };
    case "older-done":
      return {
        ...state,
        loadingOlder: false,
        older: mergeMessages(state.older, event.page.messages),
        olderExhausted: !event.page.hasOlder,
      };
    case "older-failed":
      return { ...state, loadingOlder: false };
    case "toggle-run": {
      const expandedRuns = new Set(state.expandedRuns);
      if (!expandedRuns.delete(event.key)) expandedRuns.add(event.key);
      return { ...state, expandedRuns };
    }
    case "target":
      return { ...state, target: event.target };
    case "text":
      return { ...state, text: event.text };
    case "sent":
      return { ...state, text: "", target: { kind: "room" } };
    case "rule-offered":
      return { ...state, offeredRuleIds: new Set([...state.offeredRuleIds, event.messageId]) };
  }
}

export interface RoomView {
  /** Loaded messages, oldest first. */
  readonly messages: ReadonlyArray<MissionMessage>;
  readonly hasOlder: boolean;
  readonly rows: ReadonlyArray<TimelineRow>;
  /** Next older page to load on scroll, or `null`. */
  readonly olderRequest: LoadRoomPageInput | null;
  /** Read position to store now that the newest message is on screen. */
  readonly markRead: number | null;
}

/** Everything the open room renders, from the live page plus the screen state. */
export function roomView(
  page: Pick<RoomPage, "room" | "messages" | "hasOlder" | "ownerReadSeq">,
  state: RoomUiState,
  dayOf?: (iso: string) => string,
): RoomView {
  const messages = mergeMessages(state.older, page.messages);
  const hasOlder = state.older.length > 0 ? !state.olderExhausted : page.hasOlder;
  const markerSeq =
    state.roomId === page.room.id ? (state.markerSeq ?? page.ownerReadSeq) : page.ownerReadSeq;
  return {
    messages,
    hasOlder,
    rows: roomTimeline(messages, markerSeq, {
      expandedRuns: state.expandedRuns,
      ...(dayOf ? { dayOf } : {}),
    }),
    olderRequest: state.loadingOlder ? null : olderPageRequest(page.room.id, messages, hasOlder),
    markRead: nextReadSeq(page.ownerReadSeq, newestSeq(page.messages)),
  };
}
