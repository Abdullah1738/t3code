/**
 * The owner's requests to the master: "how is X going", "make Y faster",
 * "pick Z up". Each request is one conversation in its own room between the
 * owner and the master, with a status the board shows.
 *
 * The owner's words always wake the master, and the wake carries the whole
 * conversation (see `contextOf`), so the owner never restates context. The
 * master's replies wake nobody. Every write is one commit: the request
 * record, its timeline event, and the message travel together.
 */
// @effect-diagnostics nodeBuiltinImport:off - request ids use node:crypto, like the session board.
import * as NodeCrypto from "node:crypto";

import {
  isOwnerProvenance,
  MissionError,
  MissionMessageId,
  OwnerRequestId,
  RoomId,
  type Mission,
  type MissionActor,
  type MissionEventKind,
  type MissionId,
  type MissionMessage,
  type MissionMessageKind,
  type MissionProvenance,
  type MissionRecordRef,
  type OpenOwnerRequestInput,
  type OwnerCondition,
  type OwnerRequest,
  type OwnerRequests,
  type OwnerRequestsInput,
  type OwnerRequestView,
  type PostMessageInput,
  type ReopenOwnerRequestInput,
  type ReplyOwnerRequestInput,
  type Room,
  type SettleOwnerRequestInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { silencePhraseIn } from "../asks/askModel.ts";
import { clipSummary, dedupeRefs } from "../asks/shared.ts";
import { IMESSAGE_BRIDGE } from "../guard/imessage.ts";
import type * as MissionStore from "../store/MissionStore.ts";
import type { MissionStoreKind, MissionStoreRecord } from "../store/recordIndex.ts";
import { labelOf, masterRoleOf, masterThreadsOf, type RouterCast } from "./cast.ts";
import { postContentHash } from "./hash.ts";
import {
  afterMasterSpoke,
  afterOwnerSpoke,
  keyedRequestId,
  renderRequestContext,
  reopenedByMaster,
  requestIdOfRoom,
  requestRoomId,
  requestTitleOf,
  settledBy,
  withLastReply,
} from "./requestsModel.ts";
import type { RouterStore } from "./RouterStore.ts";

/** Requests one list returns, newest activity first. */
const LIST_MAX = 50;
/** Messages each request carries in a list, summaries only. */
const VIEW_MESSAGES = 6;
/** Messages a single request carries, with bodies, when asked for by id. */
const VIEW_ONE = 100;
/** Newest messages the master's transcript is built from (plus the first). */
const CONTEXT_MESSAGES = 40;

const fail = (code: MissionError["code"], detail: string) => new MissionError({ code, detail });
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** The request event and record written in the same commit as its message. */
export interface RequestCommit {
  readonly kind: MissionEventKind;
  readonly summary: string;
  readonly subject: MissionRecordRef;
  readonly payload: Record<string, unknown>;
  readonly upserts: ReadonlyArray<MissionStoreRecord>;
}

export interface RequestPost {
  readonly input: PostMessageInput;
  readonly provenance: MissionProvenance;
  readonly author: MissionActor;
  /** The request's room, written with its first message. */
  readonly newRoom?: Room;
  readonly asRequest: (message: MissionMessage, at: string) => RequestCommit;
}

export interface PostedMessage {
  readonly message: MissionMessage;
  readonly fresh: boolean;
  readonly deliveries: ReadonlyArray<ThreadId>;
}

export interface OwnerRequestDeps {
  readonly store: MissionStore.MissionStore["Service"];
  readonly rooms: RouterStore["Service"];
  readonly loadCast: (missionId: MissionId) => Effect.Effect<RouterCast, MissionError>;
  /** The router's checked post, carrying the request commit instead of `message.posted`. */
  readonly post: (plan: RequestPost) => Effect.Effect<PostedMessage, MissionError>;
  readonly afterPost: (
    speaker: ThreadId | null,
    deliveries: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<void>;
}

type RoomCount = { readonly total: number; readonly unreadForOwner: number };

type Caller =
  | { readonly _tag: "owner"; readonly actor: MissionActor }
  | { readonly _tag: "master"; readonly actor: MissionActor; readonly threadId: ThreadId }
  | { readonly _tag: "reader" };

type Writer = Exclude<Caller, { readonly _tag: "reader" }>;
/** Who settles: the owner, the master, or the record it discussed being decided. */
type Settler = Writer | { readonly _tag: "system"; readonly actor: MissionActor };

const OWNER_CALLER: Caller = { _tag: "owner", actor: { _tag: "owner" } };
const READER_CALLER: Caller = { _tag: "reader" };

/**
 * Readers who see the words of a request: the owner, the master, and the
 * iMessage bridge that carries them. Every other reader sees states and
 * times only.
 */
export const readsRequestWords = (provenance: MissionProvenance, ownerSession = false) =>
  ownerSession ||
  isOwnerProvenance(provenance) ||
  (provenance._tag === "system" && provenance.component === IMESSAGE_BRIDGE);

/** A request as a reader without its words sees it. */
const withoutWords = (view: OwnerRequestView): OwnerRequestView => ({
  ...view,
  request: {
    ...view.request,
    title: "Owner request",
    lastReply: null,
    lastReplyBy: null,
    lastReplyAt: null,
    // Labels are the master's free text and can quote the owner.
    links: view.request.links.map(({ kind, id }) => ({ kind, id })),
  },
  messages: [],
  hasOlder: false,
});

/**
 * No title: the timeline reaches agents who are not the master (the digest,
 * desk events), and the title is the owner's own words.
 */
const refOf = (request: OwnerRequest): MissionRecordRef => ({
  kind: "owner-request",
  id: request.id,
});

/**
 * One key per iMessage and request: the same inbound message can write to
 * several requests ("approve both"), once each. Retries land on what it
 * already wrote there.
 */
const inboundKeyOf = (provenance: MissionProvenance, requestId: OwnerRequestId) =>
  provenance._tag === "owner-imessage"
    ? `${inboundPrefixOf(provenance.inboundId)}${requestId}`
    : null;
const inboundPrefixOf = (inboundId: string) => `owner-imessage:${inboundId}:`;

/** Mission-scoped store records a reply may link to; each must be in the request's mission. */
const SCOPED_LINK_KINDS = [
  "sub-mission",
  "milestone",
  "lane",
  "role",
  "ask",
  "call",
  "note",
  "rule",
  "rule-change-request",
  "suggestion",
  "draft",
  "draft-note",
  "knock",
  "approval",
  "work-item",
  "owner-request",
] as const satisfies ReadonlyArray<MissionStoreKind>;
type ScopedLinkKind = (typeof SCOPED_LINK_KINDS)[number];
const isScopedLinkKind = (kind: string): kind is ScopedLinkKind =>
  (SCOPED_LINK_KINDS as ReadonlyArray<string>).includes(kind);

const upsertOf = (record: OwnerRequest): MissionStoreRecord => ({
  _tag: "owner-request",
  record,
});

const openedBy = (provenance: MissionProvenance) =>
  isOwnerProvenance(provenance) ? "the owner" : "the master, for the owner";

/** Who settles a request when the record it discussed is decided. */
const DISCUSS_ACTOR: MissionActor = { _tag: "system", component: "discuss" };
const DISCUSS_PROVENANCE: MissionProvenance = { _tag: "system", component: "discuss" };
/** Owner messages one `verify` page reads at a time. */
const VERIFY_PAGE = 200;
const SUBJECT_LABEL_MAX = 80;

const sameRef = (a: MissionRecordRef | null | undefined, b: MissionRecordRef) =>
  a !== null && a !== undefined && a.kind === b.kind && a.id === b.id;

/** Words compared the way the owner typed them, whitespace aside. */
const flatWords = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * A sentence ends at `.`, `!` or `?` and a space, or at a blank line. Not
 * after an ellipsis or a short abbreviation ("i.e.", "e.g.", "etc.", "vs.",
 * one letter): "Merge it... no wait" is one sentence.
 */
const SENTENCE_BREAK = /(?<!\.\.\.|…|\b(?:i\.e|e\.g|etc|vs|[a-z])\.)(?<=[.!?])\s+|\n\s*\n/i;

/**
 * Sentences, flattened. A closing `.` or `!` is dropped; a `?` and an
 * ellipsis stay, so a question never matches a statement. A quote must be
 * whole sentences, so cutting "not" out of "It's not fine to merge" never
 * matches.
 */
const sentencesOf = (text: string): ReadonlyArray<string> =>
  text
    .normalize("NFC")
    .split(SENTENCE_BREAK)
    .map((sentence) => {
      const flat = flatWords(sentence);
      return flat.endsWith("...") || flat.endsWith("…")
        ? flat
        : flat.replace(/[.!]+$/, "").trimEnd();
    })
    .filter((sentence) => sentence.length > 0);

/**
 * Any question mark anywhere in a sentence makes it a question: `?` before a
 * closing quote or bracket, `¿` up front, the Arabic, reversed, Armenian and
 * Ethiopic marks and the interrobang. NFKC folds the fullwidth, small and
 * vertical forms (and `⁇`, `⁈`, `⁉`) into `?`.
 */
const QUESTION_MARK = /[?\u00BF\u061F\u2E2E\u203D\u055E\u1367]/u;
const isQuestion = (sentence: string) => QUESTION_MARK.test(sentence.normalize("NFKC"));

/**
 * True when `said` holds every sentence of `quote`, in a row. A question is
 * never a condition, so a quote with one never holds.
 */
const holdsSentences = (said: ReadonlyArray<string>, quote: ReadonlyArray<string>) => {
  if (quote.some(isQuestion)) return false;
  for (let start = 0; start + quote.length <= said.length; start += 1) {
    if (quote.every((sentence, at) => said[start + at] === sentence)) return true;
  }
  return false;
};

/**
 * Words where he takes back what he said before them: "Scrap that.",
 * "Never mind,", "No wait,", "Actually, no.", "On second thought". Most need
 * a stop after them, so "Never mind the docs" and "Don't forget that." are
 * not one. A stray match only makes `verify` refuse; it never lets a
 * withdrawn word stand. "Cancel it" and "scrap it" are left out: they are
 * usually the decision itself.
 */
const RETRACTION = new RegExp(
  String.raw`(?<!\b(?:don['’]?t|do not|didn['’]?t|won['’]?t) )\b(?:(?:scrap|scratch|strike|cancel|forget|ignore|disregard) (?:that|this|all that|all of that|what i (?:just )?said|my last message)|forget it|never ?mind|nvm|(?:i )?take (?:that|it|this) back|no,? wait|wait,? no|actually,? no)(?=\s*(?:[,.;:!…]|$))|\bon second thought\b`,
  "giu",
);

/** Where the last retraction in a sentence ends, or null. */
const retractionEnd = (sentence: string) => {
  let end: number | null = null;
  for (const match of sentence.matchAll(RETRACTION)) end = match.index + match[0].length;
  return end;
};

/**
 * The sentences of one message that still stand: none before its last
 * retraction. The sentence holding it stands whole ("Rebase it... no wait,
 * leave it") only when words follow it; a message that ends by taking things
 * back stands for nothing.
 */
export const standingSentences = (sentences: ReadonlyArray<string>) => {
  for (let at = sentences.length - 1; at >= 0; at -= 1) {
    const sentence = sentences[at] ?? "";
    const end = retractionEnd(sentence);
    if (end === null) continue;
    const rest = sentence.slice(end).replace(/[\s,.;:!…-]+/gu, "");
    return sentences.slice(rest.length > 0 ? at : at + 1);
  }
  return sentences;
};

/** The owner's own words: his app, or his own iMessage chat (not Moni's). */
const ownWords = (message: MissionMessage) =>
  message.author._tag === "owner" &&
  (message.provenance._tag === "owner-app" ||
    (message.provenance._tag === "owner-imessage" && message.provenance.chat === "owner"));

/** A short label for a discussed record: its title, question or summary. */
const recordLabel = (record: object): string | null => {
  const fields = new Map<string, unknown>(Object.entries(record));
  for (const key of ["title", "question", "summary", "name", "label"]) {
    const value = fields.get(key);
    if (typeof value !== "string") continue;
    const flat = value.replace(/\s+/g, " ").trim();
    if (flat.length === 0) continue;
    return flat.length <= SUBJECT_LABEL_MAX
      ? flat
      : `${flat.slice(0, SUBJECT_LABEL_MAX - 1).trimEnd()}…`;
  }
  return null;
};

/** The status line the master reads for a discussed record. */
const recordStatus = (kind: string, record: object): string => {
  const fields = new Map<string, unknown>(Object.entries(record));
  const status = fields.get("status") ?? fields.get("stage");
  if (typeof status === "string") return status;
  if (kind === "call") {
    const reaction = fields.get("ownerReaction");
    return typeof reaction === "string" ? `decided, owner reaction ${reaction}` : "decided";
  }
  return "on record";
};

/** Defaults and deadlines turn silence into an answer; requests wait for the owner. */
const refuseSilence = (text: string) => {
  const phrase = silencePhraseIn(text);
  return phrase === null
    ? Effect.void
    : Effect.fail(
        fail(
          "invalid",
          `Requests carry no default, deadline or "unless you say otherwise"; they wait for the owner. Drop "${phrase}".`,
        ),
      );
};

export const makeOwnerRequests = (deps: OwnerRequestDeps) =>
  Effect.gen(function* () {
    const { store, rooms, loadCast, post, afterPost } = deps;
    // One request write at a time, so status moves read what the last one wrote.
    const requestLock = yield* Semaphore.make(1);

    const callerOf = (
      cast: RouterCast,
      provenance: MissionProvenance,
    ): Effect.Effect<Caller, MissionError> =>
      Effect.gen(function* () {
        if (provenance._tag === "import") {
          return yield* fail("provenance-invalid", "Imports do not touch owner requests.");
        }
        if (isOwnerProvenance(provenance)) return OWNER_CALLER;
        if (provenance._tag === "agent") {
          if (!masterThreadsOf(cast).includes(provenance.threadId)) {
            return yield* fail(
              "forbidden",
              "Owner requests are between the owner and the mission's master.",
            );
          }
          const master = masterRoleOf(cast);
          const actor: MissionActor =
            master === null
              ? { _tag: "thread", threadId: provenance.threadId }
              : { _tag: "role", roleId: master.id };
          return { _tag: "master", actor, threadId: provenance.threadId };
        }
        return READER_CALLER;
      });

    const writerOf = (
      cast: RouterCast,
      provenance: MissionProvenance,
    ): Effect.Effect<Writer, MissionError> =>
      Effect.gen(function* () {
        const caller = yield* callerOf(cast, provenance);
        if (caller._tag === "reader") {
          return yield* fail(
            "provenance-required",
            "Owner requests are written by the owner (a paired Robob session or a verified iMessage) or the mission's master.",
          );
        }
        return caller;
      });

    /**
     * A keyed post lands once: refuse the key when it already wrote a
     * different text or into another room.
     */
    const priorPost = (
      key: string | null,
      input: PostMessageInput,
    ): Effect.Effect<"fresh" | "repeat", MissionError> =>
      Effect.gen(function* () {
        if (key === null) return "fresh";
        const prior = yield* rooms.messageByKey(input.missionId, key);
        if (prior === null) return "fresh";
        if (prior.message.roomId !== input.roomId || prior.contentHash !== postContentHash(input)) {
          return yield* fail(
            "conflict",
            "That key already posted something else; a retry must repeat the same request and text.",
          );
        }
        return "repeat";
      });

    /** Links a reply carries must name records of the request's mission. */
    const checkLinks = (missionId: MissionId, links: ReadonlyArray<MissionRecordRef>) =>
      Effect.forEach(
        links,
        (link) =>
          Effect.gen(function* () {
            const kind = link.kind;
            if (kind === "mission") {
              if (link.id !== missionId) {
                return yield* fail("invalid", `Link ${link.id} is another mission.`);
              }
              return;
            }
            if (kind === "room") {
              const room = yield* rooms.room(RoomId.make(link.id));
              if (room === null) return yield* fail("not-found", `No room ${link.id}.`);
              if (room.missionId !== missionId) {
                return yield* fail("invalid", `Room ${link.id} belongs to another mission.`);
              }
              return;
            }
            if (kind === "message") {
              const message = yield* rooms.messageById(MissionMessageId.make(link.id));
              if (message === null) return yield* fail("not-found", `No message ${link.id}.`);
              if (message.missionId !== missionId) {
                return yield* fail("invalid", `Message ${link.id} belongs to another mission.`);
              }
              return;
            }
            if (!isScopedLinkKind(kind)) return;
            const record = Option.getOrNull(yield* store.get(kind, link.id));
            if (record === null) return yield* fail("not-found", `No ${kind} ${link.id}.`);
            // Global rules and draft notes carry no mission and fit any.
            if (record.missionId !== null && record.missionId !== missionId) {
              return yield* fail("invalid", `${kind} ${link.id} belongs to another mission.`);
            }
          }),
        { discard: true },
      );

    const missionOf = (missionId: MissionId) =>
      Effect.gen(function* () {
        const mission = Option.getOrNull(yield* store.get("mission", missionId));
        if (mission === null) return yield* fail("not-found", `No mission ${missionId}.`);
        return mission;
      });

    const liveMission = (missionId: MissionId) =>
      Effect.gen(function* () {
        const mission: Mission = yield* missionOf(missionId);
        if (mission.status === "archived") {
          return yield* fail("conflict", `Mission ${mission.title} is archived.`);
        }
        return mission;
      });

    const need = (requestId: OwnerRequestId) =>
      Effect.gen(function* () {
        const request = Option.getOrNull(yield* store.get("owner-request", requestId));
        if (request === null) return yield* fail("not-found", `No request ${requestId}.`);
        return request;
      });

    /** The owner's words go to the master; a mission with no master cannot take them. */
    const masterAddress = (cast: RouterCast) =>
      Effect.gen(function* () {
        const master = masterRoleOf(cast);
        if (master === null) {
          return yield* fail("conflict", "This mission has no master to take requests yet.");
        }
        return [{ _tag: "role", roleId: master.id }] as ReadonlyArray<MissionActor>;
      });

    const messageInput = (
      request: Pick<OwnerRequest, "missionId" | "roomId">,
      kind: MissionMessageKind,
      text: string,
      to: ReadonlyArray<MissionActor>,
      key: string | null,
    ): PostMessageInput => ({
      missionId: request.missionId,
      roomId: request.roomId,
      kind,
      summary: clipSummary(text),
      body: text,
      to: [...to],
      ...(key === null ? {} : { key }),
    });

    const speakerOf = (writer: Writer) => (writer._tag === "master" ? writer.threadId : null);

    /**
     * Discuss: the record a request is about, read live. Null when it is gone.
     * Only records of the mission qualify; a request is never about a request.
     */
    const subjectRecord = (
      missionId: MissionId,
      ref: MissionRecordRef,
    ): Effect.Effect<object | null, MissionError> =>
      Effect.gen(function* () {
        const kind = ref.kind;
        if (kind === "mission") {
          return ref.id === missionId ? yield* missionOf(missionId) : null;
        }
        if (kind === "room") {
          const room = yield* rooms.room(RoomId.make(ref.id));
          return room !== null && room.missionId === missionId && room.kind !== "owner-request"
            ? room
            : null;
        }
        if (kind === "message") {
          const message = yield* rooms.messageById(MissionMessageId.make(ref.id));
          if (message === null || message.missionId !== missionId) return null;
          // A message inside a request is that request's talk, not a record.
          return requestIdOfRoom(message.roomId) === null ? message : null;
        }
        if (kind === "owner-request" || !isScopedLinkKind(kind)) {
          return yield* fail("invalid", `A ${kind} cannot be discussed in a request.`);
        }
        const record = Option.getOrNull(yield* store.get(kind, ref.id));
        return record !== null && record.missionId === missionId ? record : null;
      });

    /** The subject as the request keeps it: checked against the mission, labelled. */
    const subjectOf = (missionId: MissionId, ref: MissionRecordRef) =>
      Effect.gen(function* () {
        const record = yield* subjectRecord(missionId, ref);
        if (record === null) {
          return yield* fail("not-found", `No ${ref.kind} ${ref.id} in ${missionId}.`);
        }
        // The label comes from the record; a client-sent one is ignored.
        const label = recordLabel(record);
        return {
          kind: ref.kind,
          id: ref.id,
          ...(label === null ? {} : { label }),
        } satisfies MissionRecordRef;
      });

    /** The subject's current status line for the master's transcript. */
    const subjectLine = (request: OwnerRequest) =>
      Effect.gen(function* () {
        const ref = request.subject;
        if (ref === undefined || ref === null) return null;
        const record = yield* subjectRecord(request.missionId, ref).pipe(
          Effect.catchTags({ MissionError: () => Effect.succeed(null) }),
        );
        return {
          ref,
          status: record === null ? "no longer on record" : recordStatus(ref.kind, record),
        };
      });

    /**
     * What an open about `subject` already wrote, when it is a retry: the
     * message under its own key, or for an iMessage, the one it added to a
     * request about the same record (it may have written to others too).
     */
    const appendedBefore = (
      missionId: MissionId,
      inboundId: string | null,
      openKey: string,
      subject: MissionRecordRef,
    ) =>
      Effect.gen(function* () {
        const priors =
          inboundId === null
            ? [yield* rooms.messageByKey(missionId, openKey)].filter((prior) => prior !== null)
            : yield* rooms.messagesByKeyPrefix(missionId, inboundPrefixOf(inboundId));
        for (const prior of priors) {
          const priorId = requestIdOfRoom(prior.message.roomId);
          if (priorId === null) continue;
          const request = yield* need(priorId);
          // A plain key is one action: reused about another record, it conflicts.
          if (inboundId === null || sameRef(request.subject, subject)) {
            return { request, contentHash: prior.contentHash };
          }
        }
        return null;
      });

    /** The open request about a record, if there is one. */
    const openAbout = (missionId: MissionId, ref: MissionRecordRef) =>
      Effect.map(
        store.listOwnerRequests(missionId, {
          status: ["waiting-on-master", "answered"],
          subject: ref,
        }),
        (requests) => requests.find((request) => sameRef(request.subject, ref)) ?? null,
      );

    /** Runs a request write under the lock, then rings doorbells outside it. */
    const write = <A>(
      run: Effect.Effect<
        {
          readonly result: A;
          readonly speaker: ThreadId | null;
          readonly deliveries: ReadonlyArray<ThreadId>;
        },
        MissionError
      >,
    ) =>
      Effect.gen(function* () {
        const done = yield* requestLock.withPermit(run);
        if (done.deliveries.length > 0 || done.speaker !== null) {
          yield* afterPost(done.speaker, done.deliveries);
        }
        return done.result;
      });

    /**
     * The discussion counter: unread messages, at least 1 while the request
     * is unread (a settle with no master note still marks it unread).
     */
    const unreadMessagesOf = (request: OwnerRequest, counts: ReadonlyMap<string, RoomCount>) =>
      request.unreadForOwner ? Math.max(1, counts.get(request.roomId)?.unreadForOwner ?? 0) : 0;

    const viewOf = (
      request: OwnerRequest,
      limit: number,
      withBodies: boolean,
      counts: ReadonlyMap<string, RoomCount>,
    ) =>
      Effect.gen(function* () {
        const page = yield* rooms.roomMessages(request.roomId, null, limit);
        const messages = yield* Effect.forEach(page.messages, (message) =>
          Effect.map(
            withBodies && message.hasBody ? rooms.messageBody(message.id) : Effect.succeed(null),
            (body) => ({ message, body }),
          ),
        );
        return {
          request,
          messages,
          hasOlder: page.hasOlder,
          unreadForOwner: request.unreadForOwner,
          unreadMessages: unreadMessagesOf(request, counts),
        } satisfies OwnerRequestView;
      });

    /**
     * Requests of a mission. Words only for the owner (`ownerSession` is an
     * owner-paired session reading over HTTP), the master and the bridge.
     */
    const list = (input: OwnerRequestsInput, provenance: MissionProvenance, ownerSession = false) =>
      Effect.gen(function* () {
        yield* missionOf(input.missionId);
        const caller = yield* callerOf(yield* loadCast(input.missionId), provenance);
        const words = caller._tag !== "reader" || readsRequestWords(provenance, ownerSession);
        const records = yield* store.listOwnerRequests(input.missionId, {
          ...(input.status === undefined ? {} : { status: [input.status] }),
          ...(input.requestId === undefined ? {} : { ids: [input.requestId] }),
          ...(input.discussions === undefined ? {} : { discussions: input.discussions }),
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          ...(input.unread === true ? { unread: true } : {}),
          limit: LIST_MAX,
        });
        if (input.requestId !== undefined && records.length === 0) {
          return yield* fail("not-found", `No request ${input.requestId} in ${input.missionId}.`);
        }
        const counts = yield* rooms.roomCounts(
          input.missionId,
          records.filter((request) => request.unreadForOwner).map((request) => request.roomId),
        );
        // A list carries summaries; one request asked for by id carries its bodies.
        const one = input.requestId !== undefined;
        const requests = words
          ? yield* Effect.forEach(records, (request) =>
              viewOf(request, one ? VIEW_ONE : VIEW_MESSAGES, one, counts),
            )
          : records.map((request) =>
              withoutWords({
                request,
                messages: [],
                hasOlder: false,
                unreadForOwner: request.unreadForOwner,
                unreadMessages: unreadMessagesOf(request, counts),
              }),
            );
        return { missionId: input.missionId, requests } satisfies OwnerRequests;
      });

    const open = (input: OpenOwnerRequestInput, provenance: MissionProvenance) =>
      write(
        Effect.gen(function* () {
          const mission = yield* liveMission(input.missionId);
          const cast = yield* loadCast(mission.id);
          const writer = yield* writerOf(cast, provenance);
          if (writer._tag === "owner" && input.quotedFrom !== undefined) {
            return yield* fail(
              "invalid",
              "quotedFrom is for the master opening a request on the owner's behalf.",
            );
          }
          if (writer._tag === "master") {
            if (input.quotedFrom === undefined) {
              return yield* fail(
                "invalid",
                "Say where the owner asked it (quotedFrom: his thread, iMessage) when you open a request for him.",
              );
            }
            yield* refuseSilence(input.text);
          }
          if (input.subMissionId !== undefined) {
            const sub = Option.getOrNull(yield* store.get("sub-mission", input.subMissionId));
            if (sub === null || sub.missionId !== mission.id) {
              return yield* fail(
                "not-found",
                `No sub-mission ${input.subMissionId} in ${mission.id}.`,
              );
            }
          }
          if (input.subject !== undefined && writer._tag !== "owner") {
            return yield* fail("invalid", "Only the owner opens a request about a record.");
          }
          const subject =
            input.subject === undefined ? null : yield* subjectOf(mission.id, input.subject);
          const to = writer._tag === "owner" ? yield* masterAddress(cast) : [];
          const inboundId = provenance._tag === "owner-imessage" ? provenance.inboundId : null;
          // One iMessage can discuss several records: each is its own request.
          const idKey =
            input.key ??
            (inboundId === null
              ? null
              : `owner-imessage:${inboundId}${subject === null ? "" : `:${subject.kind}:${subject.id}`}`);
          const requestId =
            idKey === null
              ? OwnerRequestId.make(`request-${NodeCrypto.randomUUID()}`)
              : keyedRequestId(mission.id, idKey);
          const inboundKey = inboundKeyOf(provenance, requestId);
          // One open conversation per record: Discuss again adds to it. The
          // added message keeps this open's own key, so a retry finds it even
          // after that request was settled.
          const appendKey = (target: OwnerRequestId) =>
            idKey === null
              ? null
              : (inboundKeyOf(provenance, target) ?? `request:${requestId}:open`);
          if (subject !== null && idKey !== null) {
            const prior = yield* appendedBefore(
              mission.id,
              inboundId,
              `request:${requestId}:open`,
              subject,
            );
            if (prior !== null) {
              const earlier = prior.request;
              const same = postContentHash(
                messageInput(
                  { missionId: mission.id, roomId: earlier.roomId },
                  "request",
                  input.text,
                  to,
                  appendKey(earlier.id),
                ),
              );
              if (prior.contentHash !== same || !sameRef(earlier.subject, subject)) {
                return yield* fail(
                  "conflict",
                  `Key ${input.key ?? appendKey(earlier.id)} already said something else in ${earlier.id}.`,
                );
              }
              return { result: earlier, speaker: null, deliveries: [] };
            }
          }
          const ongoing = subject === null ? null : yield* openAbout(mission.id, subject);
          if (ongoing !== null && ongoing.id !== requestId) {
            return yield* replyLocked(
              { requestId: ongoing.id, text: input.text },
              provenance,
              appendKey(ongoing.id),
            );
          }
          const roomId = requestRoomId(mission.id, requestId);
          const title = requestTitleOf(input.text);
          const subMissionId = input.subMissionId ?? null;
          const body =
            writer._tag === "master"
              ? `[Opened by the master for the owner, quoting what he said in ${input.quotedFrom}.]\n\n${input.text}`
              : input.text;
          const message = messageInput(
            { missionId: mission.id, roomId },
            "request",
            body,
            to,
            inboundKey ?? `request:${requestId}:open`,
          );
          if ((yield* priorPost(inboundKey, message)) === "repeat") {
            return { result: yield* need(requestId), speaker: null, deliveries: [] };
          }
          let written: OwnerRequest | null = null;
          const posted = yield* post({
            input: message,
            provenance,
            author: writer.actor,
            newRoom: {
              id: roomId,
              missionId: mission.id,
              subMissionId,
              kind: "owner-request",
              // A discussion's room names the record it is on, not his words.
              title:
                subject === null
                  ? `Request: ${title}`
                  : `Discussion: ${subject.label ?? `${subject.kind} ${subject.id}`}`,
              workItemId: null,
              archived: false,
              lastSeq: 0,
              lastMessageAt: null,
              noise: null,
              createdAt: yield* nowIso,
            },
            asRequest: (_message, at) => {
              const request: OwnerRequest = {
                id: requestId,
                missionId: mission.id,
                subMissionId,
                title,
                status: "waiting-on-master",
                roomId,
                createdBy: provenance,
                lastOwnerAt: writer._tag === "owner" ? at : null,
                lastMasterAt: writer._tag === "master" ? at : null,
                links: [],
                // The master opening one for him is news for the owner.
                unreadForOwner: writer._tag === "master",
                settledBy: null,
                settledAt: null,
                createdAt: at,
                updatedAt: at,
                ...(subject === null ? {} : { subject }),
              };
              const noted = withLastReply(request, input.text, writer.actor, at);
              written = noted;
              return {
                kind: "request.opened",
                summary: `Request opened by ${writer._tag === "owner" ? "the owner" : "the master for the owner"}`,
                subject: refOf(request),
                // Kind and id only: other agents read events, and a label is words.
                payload: {
                  requestId,
                  ...(subject === null ? {} : { about: { kind: subject.kind, id: subject.id } }),
                },
                upserts: [upsertOf(noted)],
              };
            },
          });
          const result: OwnerRequest = written ?? (yield* need(requestId));
          return {
            result,
            speaker: posted.fresh ? speakerOf(writer) : null,
            deliveries: posted.fresh ? posted.deliveries : [],
          };
        }),
      );

    const reply = (input: ReplyOwnerRequestInput, provenance: MissionProvenance) =>
      write(replyLocked(input, provenance));

    /**
     * A reply, under the request lock the caller holds. `messageKey` replaces
     * the key derived from the input when Discuss adds to an open request.
     */
    const replyLocked = (
      input: ReplyOwnerRequestInput,
      provenance: MissionProvenance,
      messageKey: string | null = null,
    ) =>
      Effect.gen(function* () {
        const request = yield* need(input.requestId);
        yield* liveMission(request.missionId);
        const cast = yield* loadCast(request.missionId);
        const writer = yield* writerOf(cast, provenance);
        if (writer._tag === "owner" && (input.status !== undefined || input.links !== undefined)) {
          return yield* fail("invalid", "Only the master sets a request's status or links.");
        }
        const owner = writer._tag === "owner";
        const key =
          messageKey ??
          inboundKeyOf(provenance, request.id) ??
          (input.key === undefined ? null : `request:${request.id}:${input.key}`);
        const to = owner ? yield* masterAddress(cast) : [];
        const message = messageInput(request, owner ? "request" : "status", input.text, to, key);
        // A retried reply lands on the message it already wrote.
        if ((yield* priorPost(key, message)) === "repeat") {
          return { result: request, speaker: null, deliveries: [] };
        }
        if (request.status === "settled") {
          return yield* fail("conflict", `Request "${request.title}" is settled; reopen it first.`);
        }
        if (!owner) yield* refuseSilence(input.text);
        const status = input.status ?? "answered";
        const links = dedupeRefs(input.links ?? []);
        yield* checkLinks(request.missionId, links);
        let written: OwnerRequest | null = null;
        const posted = yield* post({
          input: message,
          provenance,
          author: writer.actor,
          asRequest: (_message, at) => {
            const next = withLastReply(
              owner ? afterOwnerSpoke(request, at) : afterMasterSpoke(request, at, status, links),
              input.text,
              writer.actor,
              at,
            );
            written = next;
            return {
              kind: "request.replied",
              summary: owner
                ? "Owner replied on a request"
                : `Master replied (${status}) on a request`,
              subject: refOf(next),
              payload: {
                requestId: request.id,
                status: next.status,
                ...(links.length === 0 ? {} : { links }),
              },
              upserts: [upsertOf(next)],
            };
          },
        });
        const result: OwnerRequest = written ?? (yield* need(request.id));
        return {
          result,
          speaker: posted.fresh ? speakerOf(writer) : null,
          deliveries: posted.fresh ? posted.deliveries : [],
        };
      });

    const settle = (input: SettleOwnerRequestInput, provenance: MissionProvenance) =>
      write(
        Effect.gen(function* () {
          const request = yield* need(input.requestId);
          yield* liveMission(request.missionId);
          const cast = yield* loadCast(request.missionId);
          const writer = yield* writerOf(cast, provenance);
          return yield* settleLocked(request, input.note ?? null, writer, provenance, cast);
        }),
      );

    /**
     * Settles a request, under the request lock the caller holds. A note from
     * the owner wakes the master once with it; the master's note, a note from
     * the record being decided, and a bare settle wake nobody.
     */
    const settleLocked = (
      request: OwnerRequest,
      noteText: string | null,
      settler: Settler,
      provenance: MissionProvenance,
      cast: RouterCast,
    ) =>
      Effect.gen(function* () {
        const none = {
          result: request,
          speaker: null,
          deliveries: [] as ReadonlyArray<ThreadId>,
        };
        if (request.status === "settled") return none;
        const master = settler._tag === "master";
        const owner = settler._tag === "owner";
        const speaker = settler._tag === "master" ? settler.threadId : null;
        const label = master ? "the master" : owner ? "the owner" : "deciding its record";
        const event = (next: OwnerRequest): RequestCommit => ({
          kind: "request.settled",
          summary: `Request settled by ${label}`,
          subject: refOf(next),
          payload: { requestId: request.id },
          upserts: [upsertOf(next)],
        });
        if (noteText === null) {
          const at = yield* nowIso;
          const next = settledBy(request, settler.actor, at, false);
          const commit = event(next);
          yield* store.commit({
            event: {
              missionId: request.missionId,
              kind: commit.kind,
              actor: settler.actor,
              provenance,
              summary: clipSummary(commit.summary),
              subject: commit.subject,
              payload: commit.payload,
              at,
            },
            upserts: commit.upserts,
          });
          return { result: next, speaker, deliveries: [] as ReadonlyArray<ThreadId> };
        }
        if (master) yield* refuseSilence(noteText);
        // The owner's closing words are for the master: it wakes once with them.
        const to = owner && masterRoleOf(cast) !== null ? yield* masterAddress(cast) : [];
        const note = messageInput(
          request,
          owner ? "decision" : "status",
          noteText,
          to,
          inboundKeyOf(provenance, request.id),
        );
        if ((yield* priorPost(note.key ?? null, note)) === "repeat") return none;
        let written: OwnerRequest | null = null;
        const posted = yield* post({
          input: note,
          provenance,
          author: settler.actor,
          asRequest: (_message, at) => {
            const settled = settledBy(request, settler.actor, at, master);
            const next = withLastReply(
              // The note from deciding the record is news for the owner.
              settler._tag === "system" ? { ...settled, unreadForOwner: true } : settled,
              noteText,
              settler.actor,
              at,
            );
            written = next;
            return event(next);
          },
        });
        const result: OwnerRequest = written ?? (yield* need(request.id));
        return {
          result,
          speaker,
          deliveries: posted.fresh && owner ? posted.deliveries : ([] as ReadonlyArray<ThreadId>),
        };
      });

    const reopen = (input: ReopenOwnerRequestInput, provenance: MissionProvenance) =>
      write(
        Effect.gen(function* () {
          const request = yield* need(input.requestId);
          yield* liveMission(request.missionId);
          const cast = yield* loadCast(request.missionId);
          const writer = yield* writerOf(cast, provenance);
          const none = {
            result: request,
            speaker: null,
            deliveries: [] as ReadonlyArray<ThreadId>,
          };
          if (request.status !== "settled") return none;
          // One open request per record, as open keeps it.
          const subject = request.subject ?? null;
          const ongoing = subject === null ? null : yield* openAbout(request.missionId, subject);
          if (subject !== null && ongoing !== null && ongoing.id !== request.id) {
            return yield* fail(
              "conflict",
              `Request "${ongoing.title}" (${ongoing.id}) is already open about ${subject.kind} ${subject.id}; continue there.`,
            );
          }
          const owner = writer._tag === "owner";
          const event = (next: OwnerRequest): RequestCommit => ({
            kind: "request.reopened",
            summary: `Request reopened by ${owner ? "the owner" : "the master"}`,
            subject: refOf(next),
            payload: { requestId: request.id },
            upserts: [upsertOf(next)],
          });
          if (!owner && input.note === undefined) {
            const at = yield* nowIso;
            const next = {
              ...reopenedByMaster(request, at, false),
              reopenedAfterSeq: yield* rooms.lastMessageSeq(request.missionId),
            };
            const commit = event(next);
            yield* store.commit({
              event: {
                missionId: request.missionId,
                kind: commit.kind,
                actor: writer.actor,
                provenance,
                summary: clipSummary(commit.summary),
                subject: commit.subject,
                payload: commit.payload,
                at,
              },
              upserts: commit.upserts,
            });
            return { result: next, speaker: speakerOf(writer), deliveries: [] };
          }
          if (!owner && input.note !== undefined) yield* refuseSilence(input.note);
          // The owner reopening is the owner speaking: the master wakes with everything.
          const text = input.note ?? "Reopened by the owner.";
          const to = owner ? yield* masterAddress(cast) : [];
          const message = messageInput(
            request,
            owner ? "request" : "status",
            text,
            to,
            inboundKeyOf(provenance, request.id),
          );
          yield* priorPost(message.key ?? null, message);
          let written: OwnerRequest | null = null;
          const posted = yield* post({
            input: message,
            provenance,
            author: writer.actor,
            asRequest: (message, at) => {
              const next = withLastReply(
                {
                  ...(owner ? afterOwnerSpoke(request, at) : reopenedByMaster(request, at, true)),
                  // Words from before the reopen no longer stand; the owner's own note
                  // does, the stock "Reopened by the owner." does not.
                  reopenedAfterSeq:
                    owner && input.note !== undefined ? message.seq - 1 : message.seq,
                },
                text,
                writer.actor,
                at,
              );
              written = next;
              return event(next);
            },
          });
          const result: OwnerRequest = written ?? (yield* need(request.id));
          return {
            result,
            speaker: posted.fresh ? speakerOf(writer) : null,
            deliveries: posted.fresh ? posted.deliveries : [],
          };
        }),
      );

    /**
     * The owner read a request room to its end: the master's answer is no
     * longer news. The room is read again under the lock, so a reply that
     * landed after the owner's read stays unread.
     */
    const seen = (roomId: RoomId, seq: number, provenance: MissionProvenance) =>
      requestLock.withPermit(
        Effect.gen(function* () {
          if (!isOwnerProvenance(provenance)) return;
          const requestId = requestIdOfRoom(roomId);
          if (requestId === null) return;
          const room = yield* rooms.room(roomId);
          if (room === null || room.kind !== "owner-request" || seq < room.lastSeq) return;
          const request = Option.getOrNull(yield* store.get("owner-request", requestId));
          if (request === null || request.roomId !== roomId || !request.unreadForOwner) return;
          const next: OwnerRequest = { ...request, unreadForOwner: false };
          yield* store.commit({
            event: {
              missionId: request.missionId,
              kind: "request.seen",
              actor: { _tag: "owner" },
              provenance,
              summary: "Owner read the master's answer",
              subject: refOf(next),
              payload: { requestId },
            },
            upserts: [upsertOf(next)],
          });
        }),
      );

    /**
     * The whole conversation of a request room as the master reads it in a
     * wake: the first message and the newest that fit, the gap said out loud.
     * Null for any other room.
     */
    const contextOf = (roomId: RoomId) =>
      Effect.gen(function* () {
        const requestId = requestIdOfRoom(roomId);
        if (requestId === null) return null;
        const request = Option.getOrNull(yield* store.get("owner-request", requestId));
        if (request === null || request.roomId !== roomId) return null;
        const cast = yield* loadCast(request.missionId);
        const opening = yield* rooms.roomOpening(request.roomId);
        const page = yield* rooms.roomMessages(request.roomId, null, CONTEXT_MESSAGES);
        const first = opening.first;
        const messages =
          first !== null && !page.messages.some((message) => message.seq === first.seq)
            ? [first, ...page.messages]
            : page.messages;
        const transcript = yield* Effect.forEach(messages, (message) =>
          Effect.map(
            message.hasBody ? rooms.messageBody(message.id) : Effect.succeed(null),
            (body) => ({
              seq: message.seq,
              author: labelOf(cast, message.author),
              text: body ?? message.summary,
            }),
          ),
        );
        return renderRequestContext({
          request,
          openedBy: openedBy(request.createdBy),
          messages: transcript,
          total: opening.total,
          subject: yield* subjectLine(request),
        });
      });

    /**
     * Whether `quote` is in the owner's newest message of his own in the
     * request since it last reopened, after any retraction in it. A later
     * message of his replaces what he said before, so a withdrawn condition
     * never stands, and a message that only takes things back stands for nothing.
     */
    const ownerSaid = (request: OwnerRequest, quote: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const wanted = sentencesOf(quote);
        if (wanted.length === 0) return false;
        const after = request.reopenedAfterSeq ?? 0;
        let before: number | null = null;
        for (;;) {
          const page: {
            readonly messages: ReadonlyArray<MissionMessage>;
            readonly hasOlder: boolean;
          } = yield* rooms.roomMessages(request.roomId, before, VERIFY_PAGE);
          for (const message of page.messages.toReversed()) {
            if (message.seq <= after) return false;
            if (!ownWords(message)) continue;
            const body = message.hasBody ? yield* rooms.messageBody(message.id) : null;
            // His newest message replaces everything before it; within it, a
            // "scrap that" withdraws what came before, so only what follows stands.
            return holdsSentences(standingSentences(sentencesOf(body ?? message.summary)), wanted);
          }
          const oldest: MissionMessage | undefined = page.messages[0];
          if (!page.hasOlder || oldest === undefined) return false;
          before = oldest.seq;
        }
      });

    /**
     * Discuss: a master deciding a record on the owner's condition must point
     * at a request about that record holding the owner's exact words.
     */
    const verifyCondition = (input: {
      readonly subject: MissionRecordRef;
      readonly condition: OwnerCondition;
    }) =>
      Effect.gen(function* () {
        const request = Option.getOrNull(
          yield* store.get("owner-request", input.condition.requestId),
        );
        if (request === null || !sameRef(request.subject, input.subject)) {
          return yield* fail(
            "forbidden",
            `Request ${input.condition.requestId} is not the owner's conversation about ${input.subject.kind} ${input.subject.id}.`,
          );
        }
        if (request.status === "settled") {
          return yield* fail(
            "forbidden",
            `Request ${request.id} is settled; what the owner said there no longer stands.`,
          );
        }
        if (!(yield* ownerSaid(request, input.condition.quote))) {
          return yield* fail(
            "forbidden",
            "That is not in the owner's newest message in this request; quote his latest words exactly.",
          );
        }
      });

    /**
     * The record a conversation was about is decided: its open requests settle
     * with it. Nobody wakes; a note lands in the room for the owner to read.
     */
    const settleFor = (input: {
      readonly subject: MissionRecordRef;
      readonly note: string | null;
    }) =>
      requestLock.withPermit(
        Effect.gen(function* () {
          const open = (yield* store.listAll("owner-request", [
            "waiting-on-master",
            "answered",
          ])).filter((request) => sameRef(request.subject, input.subject));
          yield* Effect.forEach(
            open,
            (request) =>
              Effect.gen(function* () {
                const cast = yield* loadCast(request.missionId);
                yield* settleLocked(
                  request,
                  input.note,
                  { _tag: "system", actor: DISCUSS_ACTOR },
                  DISCUSS_PROVENANCE,
                  cast,
                );
              }),
            { discard: true },
          );
        }),
      );

    return {
      list,
      open,
      reply,
      settle,
      reopen,
      seen,
      contextOf,
      verifyCondition,
      settleFor,
    };
  });

export type OwnerRequestsService = Effect.Success<ReturnType<typeof makeOwnerRequests>>;
