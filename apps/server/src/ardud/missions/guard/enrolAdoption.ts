/**
 * Legacy authority for threads enrolled after import. When the owner or the
 * master binds a role to a thread, points a lane at it or attaches it, the
 * master adopts that thread's schedules and watches nobody is recorded as
 * having set up (see adopt.ts), so their runs stop knocking. One `guard.adopted`
 * timeline event lists what was adopted; a thread with nothing to adopt writes
 * nothing. A recorded authority is never replaced, so this runs at most once
 * per schedule or watch.
 */
import { ThreadId, type MissionEvent, type MissionProvenance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { forkParked } from "../../../serverActivation.ts";
import { castOf } from "../core/master.ts";
import { actorOf } from "../core/provenance.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { adoptLegacyAuthority, castThreads, type LegacyAdoption } from "./adopt.ts";

const GUARD: MissionProvenance = { _tag: "system", component: "mission-guard" };

const decodeBound = Schema.decodeUnknownOption(Schema.Struct({ threadId: ThreadId }));
const decodeSuccession = Schema.decodeUnknownOption(Schema.Struct({ to: ThreadId }));
const decodeMember = Schema.decodeUnknownOption(Schema.Struct({ member: Schema.Boolean }));
const decodeLaneChange = Schema.decodeUnknownOption(
  Schema.Struct({ changed: Schema.Array(Schema.String) }),
);

/** The thread an event enrols in its mission, if it enrols one. */
const enrolledThread = (store: MissionStore.MissionStore["Service"], event: MissionEvent) =>
  Effect.gen(function* () {
    switch (event.kind) {
      case "role.bound":
        return Option.getOrNull(decodeBound(event.payload))?.threadId ?? null;
      case "role.succession":
        return Option.getOrNull(decodeSuccession(event.payload))?.to ?? null;
      case "member.changed":
        return event.subject?.kind === "thread" &&
          Option.getOrNull(decodeMember(event.payload))?.member === true
          ? ThreadId.make(event.subject.id)
          : null;
      default: {
        if (!event.kind.startsWith("lane.") || event.subject?.kind !== "lane") return null;
        const pointed =
          event.kind === "lane.created" ||
          Option.getOrNull(decodeLaneChange(event.payload))?.changed.includes("threadId") === true;
        if (!pointed) return null;
        const lane = Option.getOrNull(yield* store.get("lane", event.subject.id));
        return lane === null || lane.status === "retired" ? null : lane.threadId;
      }
    }
  });

const summaryOf = (adoption: LegacyAdoption) => {
  const items = [
    ...adoption.schedules.map(
      (schedule) => `schedule "${schedule.title}" (${schedule.id}) on ${schedule.threadId}`,
    ),
    ...adoption.watches.map((watch) => `watch ${watch.pullRequest} on ${watch.threadId}`),
  ];
  return `Legacy setups now run as the master's (${adoption.master}): ${items.join(", ")}`;
};

/** Adopts for one enrolment; returns what it adopted, nothing when there was nothing to adopt. */
export const adoptForEnrolment = (
  store: MissionStore.MissionStore["Service"],
  event: MissionEvent,
) =>
  Effect.gen(function* () {
    const thread = yield* enrolledThread(store, event);
    if (thread === null) return null;
    const cast = yield* castOf(store, event.missionId);
    const { master } = castThreads(cast);
    if (master === null) return null;
    // A thread that just became master also takes over the setups of threads
    // enrolled while the mission had no master.
    const adoption = yield* adoptLegacyAuthority(cast, {
      apply: true,
      ...(thread === master ? {} : { threads: [thread] }),
    });
    if (!adoption.applied || adoption.schedules.length + adoption.watches.length === 0) {
      return null;
    }
    yield* store.appendEvent({
      missionId: event.missionId,
      kind: "guard.adopted",
      actor: actorOf(GUARD),
      provenance: GUARD,
      summary: summaryOf(adoption),
      subject: { kind: "thread", id: thread },
      causedBy: event.id,
      payload: {
        master: adoption.master,
        schedules: adoption.schedules,
        watches: adoption.watches,
      },
    });
    return adoption;
  });

/** Watches the mission timeline for enrolments. Needs MissionStore and SqlClient. */
export const enrolAdoptionLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* MissionStore.MissionStore;
    const sql = yield* SqlClient.SqlClient;
    const subscription = yield* store.subscribe;
    yield* forkParked(
      Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((item) => {
          if (item._tag !== "upsert" || item.record._tag !== "event") return Effect.void;
          return adoptForEnrolment(store, item.record.record).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "missions guard: adopting an enrolled thread's setups failed",
                cause,
              ),
            ),
          );
        }),
      ),
    );
  }),
);
