/**
 * The owner's requests to the master: "how is X going", "make Y faster",
 * "pick Z up". Each request is one conversation in its own room between the
 * owner and the master, with a status the board shows.
 *
 * The owner's words always wake the master, and the wake carries the whole
 * conversation (see `contextOf`), so the owner never restates context. The
 * master's replies wake nobody. Every write is one commit: the request
 * record, its timeline event, and the message travel together.
 *
 * Forks are different: a fork is a side question that must not change the
 * master. A request is meant to.
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

type Caller =
  | { readonly _tag: "owner"; readonly actor: MissionActor }
  | { readonly _tag: "master"; readonly actor: MissionActor; readonly threadId: ThreadId }
  | { readonly _tag: "reader" };

type Writer = Exclude<Caller, { readonly _tag: "reader" }>;

const OWNER_CALLER: Caller = { _tag: "owner", actor: { _tag: "owner" } };
const READER_CALLER: Caller = { _tag: "reader" };

/**
 * No title: the timeline reaches agents who are not the master (the digest,
 * desk events), and the title is the owner's own words.
 */
const refOf = (request: OwnerRequest): MissionRecordRef => ({
  kind: "owner-request",
  id: request.id,
});

/**
 * One key per iMessage across every mission: the same inbound message can
 * open or answer one request, once. Retries land on what it already wrote.
 */
const inboundKeyOf = (provenance: MissionProvenance) =>
  provenance._tag === "owner-imessage" ? `owner-imessage:${provenance.inboundId}` : null;

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
  "fork",
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
     * A keyed post lands once: refuse the key when it already wrote in another
     * mission, or under a different request or text in this one.
     */
    const priorPost = (
      key: string | null,
      input: PostMessageInput,
    ): Effect.Effect<"fresh" | "repeat", MissionError> =>
      Effect.gen(function* () {
        if (key === null) return "fresh";
        const elsewhere = (yield* rooms.keyMissions(key)).filter(
          (missionId) => missionId !== input.missionId,
        );
        if (elsewhere.length > 0) {
          return yield* fail("conflict", "That message from the owner was already used elsewhere.");
        }
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

    const viewOf = (request: OwnerRequest, limit: number, withBodies: boolean) =>
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
        } satisfies OwnerRequestView;
      });

    const list = (input: OwnerRequestsInput, provenance: MissionProvenance) =>
      Effect.gen(function* () {
        yield* missionOf(input.missionId);
        yield* callerOf(yield* loadCast(input.missionId), provenance);
        const records = yield* store.list("owner-request", {
          missionId: input.missionId,
          ...(input.status === undefined ? {} : { status: [input.status] }),
          ...(input.requestId === undefined ? {} : { ids: [input.requestId] }),
          limit: LIST_MAX,
        });
        if (input.requestId !== undefined && records.length === 0) {
          return yield* fail("not-found", `No request ${input.requestId} in ${input.missionId}.`);
        }
        // A list carries summaries; one request asked for by id carries its bodies.
        const one = input.requestId !== undefined;
        const requests = yield* Effect.forEach(records, (request) =>
          viewOf(request, one ? VIEW_ONE : VIEW_MESSAGES, one),
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
          const to = writer._tag === "owner" ? yield* masterAddress(cast) : [];
          const inboundKey = inboundKeyOf(provenance);
          const idKey = input.key ?? inboundKey;
          const requestId =
            idKey === null
              ? OwnerRequestId.make(`request-${NodeCrypto.randomUUID()}`)
              : keyedRequestId(mission.id, idKey);
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
              title: `Request: ${title}`,
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
              };
              written = request;
              return {
                kind: "request.opened",
                summary: `Request opened by ${writer._tag === "owner" ? "the owner" : "the master for the owner"}`,
                subject: refOf(request),
                payload: { requestId },
                upserts: [upsertOf(request)],
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
      write(
        Effect.gen(function* () {
          const request = yield* need(input.requestId);
          yield* liveMission(request.missionId);
          const cast = yield* loadCast(request.missionId);
          const writer = yield* writerOf(cast, provenance);
          if (
            writer._tag === "owner" &&
            (input.status !== undefined || input.links !== undefined)
          ) {
            return yield* fail("invalid", "Only the master sets a request's status or links.");
          }
          const owner = writer._tag === "owner";
          const key =
            inboundKeyOf(provenance) ??
            (input.key === undefined ? null : `request:${request.id}:${input.key}`);
          const to = owner ? yield* masterAddress(cast) : [];
          const message = messageInput(request, owner ? "request" : "status", input.text, to, key);
          // A retried reply lands on the message it already wrote.
          if ((yield* priorPost(key, message)) === "repeat") {
            return { result: request, speaker: null, deliveries: [] };
          }
          if (request.status === "settled") {
            return yield* fail(
              "conflict",
              `Request "${request.title}" is settled; reopen it first.`,
            );
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
              const next = owner
                ? afterOwnerSpoke(request, at)
                : afterMasterSpoke(request, at, status, links);
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
        }),
      );

    const settle = (input: SettleOwnerRequestInput, provenance: MissionProvenance) =>
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
          if (request.status === "settled") return none;
          const master = writer._tag === "master";
          const label = master ? "the master" : "the owner";
          const event = (next: OwnerRequest): RequestCommit => ({
            kind: "request.settled",
            summary: `Request settled by ${label}`,
            subject: refOf(next),
            payload: { requestId: request.id },
            upserts: [upsertOf(next)],
          });
          if (input.note === undefined) {
            const at = yield* nowIso;
            const next = settledBy(request, writer.actor, at, false);
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
          if (master) yield* refuseSilence(input.note);
          const note = messageInput(
            request,
            master ? "status" : "decision",
            input.note,
            [],
            inboundKeyOf(provenance),
          );
          yield* priorPost(note.key ?? null, note);
          let written: OwnerRequest | null = null;
          yield* post({
            input: note,
            provenance,
            author: writer.actor,
            asRequest: (_message, at) => {
              const next = settledBy(request, writer.actor, at, master);
              written = next;
              return event(next);
            },
          });
          const result: OwnerRequest = written ?? (yield* need(request.id));
          return { result, speaker: speakerOf(writer), deliveries: [] };
        }),
      );

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
            const next = reopenedByMaster(request, at, false);
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
            inboundKeyOf(provenance),
          );
          yield* priorPost(message.key ?? null, message);
          let written: OwnerRequest | null = null;
          const posted = yield* post({
            input: message,
            provenance,
            author: writer.actor,
            asRequest: (_message, at) => {
              const next = owner
                ? afterOwnerSpoke(request, at)
                : reopenedByMaster(request, at, true);
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
              at: message.createdAt,
              text: body ?? message.summary,
            }),
          ),
        );
        return renderRequestContext({
          request,
          openedBy: openedBy(request.createdBy),
          messages: transcript,
          total: opening.total,
        });
      });

    return { list, open, reply, settle, reopen, seen, contextOf };
  });

export type OwnerRequestsService = Effect.Success<ReturnType<typeof makeOwnerRequests>>;
