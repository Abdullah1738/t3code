/**
 * What reaches the master besides messages addressed to it: one digest per
 * editor pass, and the approvals and drafts routed to the master. Each one
 * is a message in the mission's control room addressed to the master role,
 * so it rings the doorbell like every other delivery. Keys come from the
 * event id, so a replayed event posts nothing new.
 *
 * Events committed while the server is down are not replayed; the master
 * still sees those records in mission_approvals / mission_drafts.
 */
import {
  approverOf,
  type MissionEvent,
  type MissionMessageKind,
  type MissionProvenance,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../../../serverActivation.ts";
import { clipSummary } from "../asks/shared.ts";
import { castOf } from "../core/master.ts";
import * as ScribeService from "../scribe/ScribeService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { masterRoleOf } from "./cast.ts";
import { controlRoomId, MissionRouter } from "./MissionRouter.ts";

export const MASTER_FEED_COMPONENT = "master-inbox";
const FEED_PROVENANCE: MissionProvenance = { _tag: "system", component: MASTER_FEED_COMPONENT };
const DIGEST_FEED_MAX = 8;

const ROUTED_KINDS = new Set([
  "approval.opened",
  "approval.routed",
  "draft.opened",
  "draft.routed",
]);

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
  /** The digest body for a mission's latest editor pass. */
  readonly digest: (event: MissionEvent) => Effect.Effect<string | null>;
}

/** Handles one committed mission event; everything it does not concern is ignored. */
export const makeMasterFeed = ({ router, store, digest }: MasterFeedDeps) => {
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
      return null;
    });

  const handle = (event: MissionEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (event.kind !== "editor.updated" && !ROUTED_KINDS.has(event.kind)) return;
      const notice = yield* noticeFor(event);
      if (notice === null) return;
      const cast = yield* castOf(store, event.missionId);
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
          key: `master-inbox:${event.id}`,
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

  return { handle };
};

/** Follows the mission store and feeds the master's inbox for the life of the server. */
export const masterFeedLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* MissionRouter;
    const store = yield* MissionStore.MissionStore;
    const scribe = yield* ScribeService.ScribeService;
    const feed = makeMasterFeed({
      router,
      store,
      digest: (event) =>
        scribe.editorView(event.missionId).pipe(
          Effect.map(digestText),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
    });
    const subscription = yield* store.subscribe;
    yield* forkParked(
      Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((item) =>
          item._tag === "upsert" && item.record._tag === "event"
            ? feed.handle(item.record.record)
            : Effect.void,
        ),
      ),
    );
  }),
);
