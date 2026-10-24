/**
 * What reaches the master besides messages addressed to it: one digest per
 * editor pass, the approvals and drafts routed to the master, the notes
 * the owner leaves when deciding an approval, and every owner decision on an
 * approval the master opened itself. Each one
 * is a message in the mission's control room addressed to the master role,
 * so it rings the doorbell like every other delivery. Keys come from the
 * event id, so a replayed event posts nothing new.
 *
 * The feed keeps a cursor per mission. After downtime it replays what it
 * missed once, as one summary message per mission (bounded to the newest
 * events), then follows live. Its first ever run starts at the present.
 */
import {
  approverOf,
  isOwnerProvenance,
  type MissionEvent,
  type MissionId,
  type MissionMessageKind,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../../../serverActivation.ts";
import { clipSummary } from "../asks/shared.ts";
import { commentLines, commentsOn } from "../asks/inboxMarks.ts"; // ardud missions: r22 comments
import * as ScribeService from "../scribe/ScribeService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { masterRoleOf, readCast } from "./cast.ts";
import { controlRoomId, MissionRouter } from "./MissionRouter.ts";
import { RouterStore } from "./RouterStore.ts";

export const MASTER_FEED_COMPONENT = "master-inbox";
const FEED_PROVENANCE: MissionProvenance = { _tag: "system", component: MASTER_FEED_COMPONENT };
const DIGEST_FEED_MAX = 8;
const BACKFILL_PAGE = 500;
const LIVE_MISSIONS = ["active", "paused", "draining"];

const ROUTED_KINDS = new Set([
  "approval.opened",
  "approval.routed",
  "draft.opened",
  "draft.routed",
]);

// ardud missions: crw-threads
/**
 * The owner's note on a decision is direction for next time; nothing else carries it to the master.
 * His app or his own iMessage chat only: a decision from Moni's chat is not his direction.
 */
const ownerNote = (event: MissionEvent): string | null => {
  const own =
    event.provenance._tag === "owner-app" ||
    (event.provenance._tag === "owner-imessage" && event.provenance.chat === "owner");
  if (event.kind !== "approval.decided" || !own) return null;
  const note =
    typeof event.payload === "object" && event.payload !== null && "note" in event.payload
      ? event.payload.note
      : null;
  return typeof note === "string" && note.trim().length > 0 ? note.trim() : null;
};

/** An owner decision on an approval that carries his comments (a note or earlier ones). */
const ownerCommented = (event: MissionEvent) =>
  ownerNote(event) !== null ||
  (event.kind === "approval.decided" &&
    (event.provenance._tag === "owner-app" ||
      (event.provenance._tag === "owner-imessage" && event.provenance.chat === "owner")) &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "commented" in event.payload &&
    event.payload.commented === true);

/** The owner decided an approval the master opened (a release): the master waits on it either way. */
const ownerDecidedMasterAsk = (event: MissionEvent) =>
  event.kind === "approval.decided" &&
  isOwnerProvenance(event.provenance) &&
  typeof event.payload === "object" &&
  event.payload !== null &&
  "masterAsked" in event.payload &&
  event.payload.masterAsked === true;

const feedRelevant = (event: MissionEvent) =>
  event.kind === "editor.updated" ||
  ROUTED_KINDS.has(event.kind) ||
  ownerCommented(event) ||
  ownerDecidedMasterAsk(event);

interface Notice {
  readonly kind: MissionMessageKind;
  readonly summary: string;
  readonly body: string;
}

/** The editor's current view as plain text for the master, or null without one. */
export const digestText = (view: ScribeService.EditorView | null): string | null => {
  if (view === null) return null;
  const lines = view.feed
    .slice(0, DIGEST_FEED_MAX)
    .map((item) => `- ${item.kind}: ${item.summary}`);
  const head = view.bottomLine === null ? [] : [`Bottom line: ${view.bottomLine}`];
  const all = [...head, ...lines];
  return all.length === 0 ? null : all.join("\n");
};

export interface MasterFeedDeps {
  readonly router: MissionRouter["Service"];
  readonly store: MissionStore.MissionStore["Service"];
  readonly rooms: RouterStore["Service"];
  /** The digest body for a mission's latest editor pass. */
  readonly digest: (event: MissionEvent) => Effect.Effect<string | null>;
}

/** Handles one committed mission event; everything it does not concern is ignored. */
export const makeMasterFeed = ({ router, store, rooms, digest }: MasterFeedDeps) => {
  const routedNotice = (event: MissionEvent) =>
    Effect.gen(function* () {
      const subject = event.subject;
      if (subject === null) return null;
      if (subject.kind === "approval") {
        const approval = Option.getOrNull(yield* store.get("approval", subject.id));
        if (approval === null || approval.status !== "pending") return null;
        if (approverOf(approval) !== "master") return null;
        const notice: Notice = {
          kind: "request",
          summary: event.summary,
          body: [
            approval.title,
            approval.detail,
            "Decide it with mission_approval_decide, or re-route it with mission_approval_route.",
          ]
            .filter((line) => line.trim().length > 0)
            .join("\n"),
        };
        return notice;
      }
      if (subject.kind === "draft") {
        const draft = Option.getOrNull(yield* store.get("draft", subject.id));
        if (draft === null || draft.status !== "pending") return null;
        if (approverOf(draft) !== "master") return null;
        const notice: Notice = {
          kind: "request",
          summary: event.summary,
          body: [
            `Draft ${draft.id} for ${draft.audience} on ${draft.channel}.`,
            "Read it with mission_draft, approve it with mission_draft_approve, or re-route it with mission_draft_route.",
          ].join("\n"),
        };
        return notice;
      }
      return null;
    });

  const noticeFor = (event: MissionEvent) =>
    Effect.gen(function* () {
      if (event.kind === "editor.updated") {
        const text = yield* digest(event);
        const notice: Notice = {
          kind: "evidence",
          summary: `Editor digest: ${event.summary}`,
          body: text ?? event.summary,
        };
        return notice;
      }
      if (ROUTED_KINDS.has(event.kind)) return yield* routedNotice(event);
      if (ownerDecidedMasterAsk(event) && event.subject?.kind === "approval") {
        const subject = { kind: "approval" as const, id: event.subject.id };
        const approval = Option.getOrNull(yield* store.get("approval", subject.id));
        const approved = approval?.status === "approved";
        const comments = yield* commentsOn(store, subject);
        const links = (approval?.links ?? []).flatMap((link) =>
          link.url === null ? [] : [`${link.label}: ${link.url}`],
        );
        const notice: Notice = {
          kind: "decision",
          summary: `Owner's decision: ${event.summary}`,
          body: [
            `The owner ${approved ? "approved" : "rejected"} ${approval?.title ?? event.subject.label}.`,
            ...(comments.length > 0 ? ["His comments:", commentLines(comments)] : []),
            ...links,
            approved
              ? "Go ahead as the approval describes, with his comments applied."
              : "Don't go ahead. If you redo it, open a new approval with his comments addressed.",
          ].join("\n"),
        };
        return notice;
      }
      // ardud missions: crw-threads
      const note = ownerNote(event);
      if (ownerCommented(event)) {
        const approval =
          event.subject?.kind === "approval"
            ? Option.getOrNull(yield* store.get("approval", event.subject.id))
            : null;
        const links = (approval?.links ?? []).flatMap((link) =>
          link.url === null ? [] : [`${link.label}: ${link.url}`],
        );
        // Every comment he left on the approval, the note with the decision included.
        const comments =
          event.subject?.kind === "approval"
            ? yield* commentsOn(store, { kind: "approval", id: event.subject.id })
            : [];
        const said = comments.length > 0 ? commentLines(comments) : (note ?? "");
        if (said === "") return null;
        const notice: Notice = {
          kind: "decision",
          summary: `Owner's note: ${event.summary}`,
          body: [
            `The owner decided ${approval?.title ?? event.subject?.label ?? "an approval"} and left ${comments.length > 1 ? "these comments" : "this note"}:`,
            said,
            ...links,
            "Take it as direction for this kind of work, not only this item.",
          ].join("\n"),
        };
        return notice;
      }
      return null;
    });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const liveKey = (event: MissionEvent) => `master-inbox:${event.id}`;

  const cursorWrite = (missionId: MissionId, seq: number) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      yield* rooms.advanceFeedCursor({ component: MASTER_FEED_COMPONENT, missionId, seq, at });
    });

  /**
   * Missions whose cursor stays put for this run because their backfill did
   * not finish; the next start replays them again. `blind` holds every
   * mission (the backfill could not even list them).
   */
  const holds = new Set<MissionId>();
  let blind = false;

  /** Moves a cursor forward. A failed write is logged; the feed keeps going. */
  const advance = (missionId: MissionId, seq: number): Effect.Effect<void> =>
    blind || holds.has(missionId)
      ? Effect.void
      : cursorWrite(missionId, seq).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("missions router: master inbox cursor failed", {
              missionId,
              seq,
              cause: Cause.pretty(cause),
            }),
          ),
        );

  const deliver = (event: MissionEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!feedRelevant(event)) return;
      const notice = yield* noticeFor(event);
      if (notice === null) return;
      const cast = yield* readCast(store, event.missionId);
      const master = masterRoleOf(cast);
      if (cast.mission === null || master === null) return;
      if (cast.mission.status === "archived") return;
      yield* router.relay({
        input: {
          missionId: event.missionId,
          roomId: controlRoomId(event.missionId),
          kind: notice.kind,
          summary: clipSummary(notice.summary),
          body: notice.body,
          to: [{ _tag: "role", roleId: master.id }],
          key: liveKey(event),
        },
        provenance: FEED_PROVENANCE,
        author: event.actor,
        // The master's own routing never wakes the master.
        authorThread: event.provenance._tag === "agent" ? event.provenance.threadId : null,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("missions router: master inbox notice failed", {
          eventId: event.id,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** One live event: deliver it, then move the mission's cursor past it. Never fails. */
  const handle = (event: MissionEvent): Effect.Effect<void> =>
    deliver(event).pipe(Effect.andThen(advance(event.missionId, event.seq)));

  /** Every feed-relevant event after `fromSeq` up to `toSeq`, however long the downtime. */
  const missedEvents = (missionId: MissionId, fromSeq: number, toSeq: number) =>
    Effect.gen(function* () {
      const relevant: MissionEvent[] = [];
      let after = fromSeq;
      while (after < toSeq) {
        const page = yield* store.eventsSince(missionId, after, BACKFILL_PAGE);
        if (page.length === 0) break;
        for (const event of page) {
          if (event.seq > toSeq) continue;
          if (feedRelevant(event)) relevant.push(event);
        }
        after = page[page.length - 1]!.seq;
      }
      return relevant;
    });

  /** What the master missed in one mission, as one notice; null when nothing is still open. */
  const missedNotice = (missionId: MissionId, fromSeq: number, toSeq: number) =>
    Effect.gen(function* () {
      const relevant = yield* missedEvents(missionId, fromSeq, toSeq);
      // The digest is the editor's current view, so only the newest pass matters;
      // an approval or draft routed twice is one item.
      const latestDigest = relevant.findLast((event) => event.kind === "editor.updated");
      const seen = new Set<string>();
      const picked: MissionEvent[] = [];
      for (const event of relevant.toReversed()) {
        if (event.kind === "editor.updated") {
          if (event === latestDigest) picked.push(event);
          continue;
        }
        const key = event.subject === null ? event.id : `${event.subject.kind}:${event.subject.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(event);
      }
      const notices: Notice[] = [];
      for (const event of picked.toReversed()) {
        // Delivered live before a crash, ahead of its cursor: not missed.
        if ((yield* rooms.messageByKey(missionId, liveKey(event))) !== null) continue;
        const notice = yield* noticeFor(event);
        if (notice !== null) notices.push(notice);
      }
      if (notices.length === 0) return null;
      const lines = [
        `While the server was down, ${notices.length} item(s) reached this mission for the master:`,
        ...notices.map((notice) => `\n## ${notice.summary}\n${notice.body}`),
      ];
      const missed: Notice = {
        kind: notices.some((notice) => notice.kind === "request") ? "request" : "evidence",
        summary: `Missed while the server was down: ${notices.length} item(s)`,
        body: lines.join("\n"),
      };
      return missed;
    });

  /** One mission's missed range as one message; its cursor moves in the same commit. */
  const replayMission = (missionId: MissionId, fromSeq: number) =>
    Effect.gen(function* () {
      const toSeq = yield* store.latestSeq(missionId);
      if (toSeq <= fromSeq) return toSeq;
      const notice = yield* missedNotice(missionId, fromSeq, toSeq);
      const master = notice === null ? null : masterRoleOf(yield* readCast(store, missionId));
      if (notice !== null && master !== null) {
        yield* router.relay({
          input: {
            missionId,
            roomId: controlRoomId(missionId),
            kind: notice.kind,
            summary: clipSummary(notice.summary),
            body: notice.body,
            to: [{ _tag: "role", roleId: master.id }],
            key: `master-inbox:backfill:${missionId}:${toSeq}`,
          },
          provenance: FEED_PROVENANCE,
          author: { _tag: "system", component: MASTER_FEED_COMPONENT },
          authorThread: null,
          alongside: cursorWrite(missionId, toSeq),
        });
      }
      yield* cursorWrite(missionId, toSeq);
      return toSeq;
    });

  /**
   * Replays what the master missed since each mission's cursor, once: one
   * summary message per mission, then the cursor moves to `latestSeq`. The
   * first ever run only records cursors. Returns the seq each mission was
   * replayed up to, so the live stream skips events already covered.
   *
   * A mission whose replay fails keeps its cursor for the whole run (live
   * events still reach the master, they just do not move it), so the next
   * start replays the range again; events delivered live are skipped then.
   */
  const backfill: Effect.Effect<ReadonlyMap<MissionId, number>> = Effect.suspend(() => {
    const covered = new Map<MissionId, number>();
    return Effect.gen(function* () {
      const missions = yield* store.listAll("mission", LIVE_MISSIONS);
      const started = yield* rooms.feedStarted(MASTER_FEED_COMPONENT);
      const cursors = yield* rooms.feedCursors(MASTER_FEED_COMPONENT);
      let complete = true;
      for (const mission of missions) {
        const known = cursors.get(mission.id);
        // A mission with a cursor always replays; one without replays from the
        // start, unless this is the feed's first run, which starts at the present.
        const replays = started || known !== undefined;
        const replay = replays
          ? replayMission(mission.id, known ?? 0)
          : store.latestSeq(mission.id).pipe(Effect.tap((seq) => cursorWrite(mission.id, seq)));
        const outcome = yield* replay.pipe(
          Effect.map((seq): number | null => seq),
          Effect.catchCause((cause) =>
            Effect.logWarning("missions router: master inbox backfill failed", {
              missionId: mission.id,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
          ),
        );
        if (outcome === null) {
          holds.add(mission.id);
          complete = false;
        } else if (replays) {
          covered.set(mission.id, outcome);
        }
      }
      // A first run that missed a cursor runs as a first run again next time.
      if (!started && complete) {
        yield* rooms.markFeedStarted(MASTER_FEED_COMPONENT, yield* nowIso);
      }
      return covered;
    }).pipe(
      Effect.catchCause((cause) => {
        // Could not even read the missions: hold every cursor this run.
        blind = true;
        return Effect.logWarning("missions router: master inbox backfill failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(covered));
      }),
    );
  });

  return { handle, backfill };
};

/** Follows the mission store and feeds the master's inbox for the life of the server. */
export const masterFeedLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* MissionRouter;
    const store = yield* MissionStore.MissionStore;
    const rooms = yield* RouterStore;
    const scribe = yield* ScribeService.ScribeService;
    const feed = makeMasterFeed({
      router,
      store,
      rooms,
      digest: (event) =>
        scribe.editorView(event.missionId).pipe(
          Effect.map(digestText),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
    });
    // Subscribe before the backfill reads its snapshot, so no commit falls
    // between them; events the backfill covered are skipped live.
    const subscription = yield* store.subscribe;
    yield* forkParked(
      Effect.gen(function* () {
        const covered = yield* feed.backfill;
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((item) => {
            if (item._tag !== "upsert" || item.record._tag !== "event") return Effect.void;
            const event = item.record.record;
            if (event.seq <= (covered.get(event.missionId) ?? 0)) return Effect.void;
            return feed.handle(event);
          }),
        );
      }),
    );
  }),
);
