/**
 * Pure pieces of the owner's requests to the master: the request's room,
 * its title, its status moves, and the transcript the master is woken with.
 *
 * A request is one conversation between the owner and the master. The master
 * is always woken with the whole of it, so the owner never repeats context.
 */
import {
  OwnerRequestId,
  RoomId,
  type MissionActor,
  type MissionId,
  type MissionRecordRef,
  type OwnerRequest,
} from "@t3tools/contracts";

import { dedupeRefs } from "../asks/shared.ts";
import { sha256 } from "./hash.ts";

/** What a request room's id carries after the mission id. */
export const REQUEST_ROOM_MARK = ":room:request:";
export const TITLE_MAX = 120;
/** Characters of one message the wake carries before it says where the rest is. */
export const MESSAGE_CONTEXT_MAX = 4_000;
/** Characters of one request's transcript in a wake. */
export const REQUEST_CONTEXT_BUDGET = 12_000;

export const requestRoomId = (missionId: MissionId, requestId: OwnerRequestId): RoomId =>
  RoomId.make(`${missionId}${REQUEST_ROOM_MARK}${requestId}`);

/** The request a room belongs to, or null for any other room. */
export const requestIdOfRoom = (roomId: string): OwnerRequestId | null => {
  const at = roomId.indexOf(REQUEST_ROOM_MARK);
  if (at <= 0) return null;
  const rest = roomId.slice(at + REQUEST_ROOM_MARK.length);
  return rest.length === 0 ? null : OwnerRequestId.make(rest);
};

/** A keyed open always lands on the same request, so a retry cannot open a second one. */
export const keyedRequestId = (missionId: MissionId, key: string): OwnerRequestId =>
  OwnerRequestId.make(`request-${sha256(`${missionId}\n${key}`).slice(0, 24)}`);

/** The request's first non-empty line, at most 120 characters. */
export const requestTitleOf = (text: string): string => {
  const line =
    text
      .split(/\r?\n/)
      .map((each) => each.trim())
      .find((each) => each.length > 0) ?? text.trim();
  const flat = line.replace(/\s+/g, " ");
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…`;
};

/** Characters of the newest message kept on the request for cards and lists. */
export const LAST_REPLY_MAX = 280;

/** The request with its newest message noted, flattened to one short line. */
export const withLastReply = (
  request: OwnerRequest,
  text: string,
  author: MissionActor,
  at: string,
): OwnerRequest => {
  const flat = text.replace(/\s+/g, " ").trim();
  const short =
    flat.length <= LAST_REPLY_MAX ? flat : `${flat.slice(0, LAST_REPLY_MAX - 1).trimEnd()}…`;
  return { ...request, lastReply: short, lastReplyBy: author, lastReplyAt: at };
};

// ---------------------------------------------------------------------------
// Status moves

/** The owner spoke (opened, replied or reopened): the master owes the next word. */
export const afterOwnerSpoke = (request: OwnerRequest, at: string): OwnerRequest => ({
  ...request,
  status: "waiting-on-master",
  lastOwnerAt: at,
  unreadForOwner: false,
  settledBy: null,
  settledAt: null,
  updatedAt: at,
});

/** The master replied: answered unless it says it is still working. */
export const afterMasterSpoke = (
  request: OwnerRequest,
  at: string,
  status: "answered" | "waiting-on-master",
  links: ReadonlyArray<MissionRecordRef>,
): OwnerRequest => ({
  ...request,
  status,
  lastMasterAt: at,
  links: dedupeRefs([...request.links, ...links]),
  unreadForOwner: true,
  updatedAt: at,
});

export const settledBy = (
  request: OwnerRequest,
  actor: MissionActor,
  at: string,
  masterNote: boolean,
): OwnerRequest => ({
  ...request,
  status: "settled",
  settledBy: actor,
  settledAt: at,
  // A note from the master is news for the owner; the owner's own settle is not.
  unreadForOwner: masterNote ? true : actor._tag === "owner" ? false : request.unreadForOwner,
  ...(masterNote ? { lastMasterAt: at } : {}),
  updatedAt: at,
});

/** The master reopened it: back on the master's desk, the owner told when there is a note. */
export const reopenedByMaster = (
  request: OwnerRequest,
  at: string,
  withNote: boolean,
): OwnerRequest => ({
  ...request,
  status: "waiting-on-master",
  settledBy: null,
  settledAt: null,
  ...(withNote ? { lastMasterAt: at, unreadForOwner: true } : {}),
  updatedAt: at,
});

// ---------------------------------------------------------------------------
// The master's transcript

export interface TranscriptMessage {
  readonly seq: number;
  readonly author: string;
  readonly at: string;
  readonly text: string;
}

const clipText = (text: string) =>
  text.length <= MESSAGE_CONTEXT_MAX
    ? text
    : `${text.slice(0, MESSAGE_CONTEXT_MAX)}\n[cut: ${text.length - MESSAGE_CONTEXT_MAX} more characters; mission_requests has the whole message]`;

const blockOf = (message: TranscriptMessage) =>
  `#${message.seq} ${message.author} at ${message.at}:\n${clipText(message.text)}\n`;

const refLine = (ref: MissionRecordRef) =>
  ref.label === undefined || ref.label.length === 0
    ? `${ref.kind} ${ref.id}`
    : `${ref.kind} ${ref.id} (${ref.label})`;

/**
 * Everything the master needs to answer a request: its header, the whole
 * conversation (the first message and as many of the newest as fit, with the
 * gap said out loud), what it has linked so far, and how to reply.
 *
 * `messages` are oldest first: the room's first message, then its newest.
 * `total` is how many the room holds, so a gap is counted even when the
 * caller did not load it.
 */
export const renderRequestContext = (input: {
  readonly request: OwnerRequest;
  readonly openedBy: string;
  readonly messages: ReadonlyArray<TranscriptMessage>;
  readonly total: number;
  readonly budget?: number;
  /** Discuss: the record the request is about and its current status line. */
  readonly subject?: { readonly ref: MissionRecordRef; readonly status: string } | null;
}): string => {
  const { request } = input;
  const budget = input.budget ?? REQUEST_CONTEXT_BUDGET;
  const subject = input.subject ?? null;
  // A discussion lives on its record's card, not in the owner's requests.
  const about =
    subject === null
      ? []
      : [
          `About: ${refLine(subject.ref)}. Its status now: ${subject.status}.`,
          "The owner opened this discussion from that record. It stays on the record's card, not in his requests, and your replies show there.",
          ...(request.status === "settled"
            ? []
            : [
                "Reply here, update or withdraw the record, or decide it on a condition the owner stated here (quote it verbatim).",
              ]),
        ];
  const header = [
    subject === null
      ? `Owner request ${request.id}: "${request.title}"`
      : `Owner discussion ${request.id} on ${refLine(subject.ref)}: "${request.title}"`,
    `Status: ${request.status}. Opened ${request.createdAt} by ${input.openedBy}.`,
    ...about,
    "The whole conversation follows, oldest first. Do not ask the owner to repeat any of it.",
    "",
  ].join("\n");
  const linked =
    request.links.length === 0
      ? "Linked so far: nothing."
      : `Linked so far: ${request.links.map(refLine).join("; ")}.`;
  const footer = [
    "",
    linked,
    request.status === "settled"
      ? `This request is settled; nothing to answer. mission_request_reopen (requestId ${request.id}) reopens it if there is more to do.`
      : `Answer with mission_request_reply (requestId ${request.id}): status "answered" when you have answered, or "waiting-on-master" with a progress note while you still work. Pass links for the work items, asks, forks, rules or suggestions you made from it. Never give it a default or a deadline. mission_request_settle closes it, mission_request_reopen reopens it.`,
  ].join("\n");

  const [first, ...rest] = input.messages;
  const firstBlock = first === undefined ? "" : blockOf(first);
  let used = header.length + firstBlock.length + footer.length;
  const tail: string[] = [];
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const block = blockOf(rest[index]!);
    // The newest message always goes in, whatever the budget says.
    if (tail.length > 0 && used + block.length > budget) break;
    tail.unshift(block);
    used += block.length;
  }
  const kept = (first === undefined ? 0 : 1) + tail.length;
  const elided = Math.max(0, input.total - kept);
  const gap =
    elided === 0
      ? []
      : [
          `[${elided} earlier message${elided === 1 ? "" : "s"} elided here to keep this short; mission_requests (requestId ${request.id}) has them all.]\n`,
        ];
  return [header, firstBlock, ...gap, ...tail, footer].join("\n");
};
