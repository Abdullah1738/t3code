import {
  isOwnerProvenance,
  MissionError,
  type AttachThreadInput,
  type MissionEventKind,
  type MissionProvenance,
  type MissionRecordRef,
  type SetThreadAttachmentInput,
  type ThreadAttachment,
  type ThreadAttachmentState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AttachTargets } from "./attachTargets.ts";
import type { WriteKit } from "./kit.ts";
import { isMasterOf } from "./master.ts";

const fail = (code: MissionError["code"], detail: string) =>
  Effect.fail(new MissionError({ code, detail }));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const attachmentRef = (record: ThreadAttachment): MissionRecordRef => ({
  kind: "thread",
  id: record.threadId,
  label: record.title,
});

const EVENT: Record<ThreadAttachmentState, MissionEventKind> = {
  open: "thread.attached",
  closed: "thread.closed",
  detached: "thread.detached",
};

const VERB: Record<ThreadAttachmentState, string> = {
  open: "Attached",
  closed: "Closed",
  detached: "Detached",
};

/**
 * A component (crw) keeps the threads it runs for the mission inside it.
 * Attachments carry no authority: role holders and lanes stay the only
 * threads that act for the mission. The owner and the mission's master can
 * move any attachment on, including detaching one that should not be there.
 */
export const makeAttachmentWrites = (kit: WriteKit, targets: AttachTargets["Service"]) => {
  const { store, serial, loadMission, unchanged, commit } = kit;

  /** A role holder or lane acts for a mission; hiding it as someone's review would bury it. */
  const requireNotActing = Effect.fn("MissionAttachments.requireNotActing")(function* (
    threadId: ThreadAttachment["threadId"],
  ) {
    const acting = yield* store.missionsOfThread(threadId);
    if (acting.length > 0) {
      return yield* fail(
        "conflict",
        `Thread ${threadId} acts for mission ${acting.join(", ")}; it is not attachable.`,
      );
    }
  });

  /** Only a thread the component itself created comes in; `attachedBy` alone proves nothing. */
  const requireCreatedBy = Effect.fn("MissionAttachments.requireCreatedBy")(function* (
    threadId: ThreadAttachment["threadId"],
    component: string,
  ) {
    const target = yield* targets.lookup(threadId);
    if (target === null) return yield* fail("not-found", `No thread ${threadId}.`);
    if (target.createdBy !== component) {
      return yield* fail("forbidden", `Thread ${threadId} was not created by ${component}.`);
    }
  });

  const attachThread = (provenance: MissionProvenance, input: AttachThreadInput) =>
    serial(
      Effect.gen(function* () {
        if (provenance._tag !== "system" || provenance.component !== input.attachedBy) {
          return yield* fail("forbidden", `Only ${input.attachedBy} attaches the threads it runs.`);
        }
        const mission = yield* loadMission(input.missionId);
        const state = input.state ?? "open";
        const found = yield* store.get("thread-attachment", input.threadId);
        const before = Option.getOrNull(found);
        if (before !== null && before.attachedBy !== input.attachedBy) {
          return yield* fail(
            "forbidden",
            `Thread ${input.threadId} was attached by ${before.attachedBy}.`,
          );
        }
        if (before !== null && before.missionId !== mission.id && before.state !== "detached") {
          return yield* fail(
            "conflict",
            `Thread ${input.threadId} belongs to mission ${before.missionId}; detach it there first.`,
          );
        }
        const inMission = before !== null && before.missionId === mission.id;
        // A detach by the owner or master sticks when the PR later settles; a fresh open reattaches.
        if (inMission && before.state === "detached" && state !== "open") {
          return yield* unchanged(mission.id, attachmentRef(before));
        }
        if (state === "open") yield* requireNotActing(input.threadId);
        if (!inMission || before.state === "detached") {
          yield* requireCreatedBy(input.threadId, provenance.component);
        }
        const pullRequest =
          input.pullRequest === undefined ? (before?.pullRequest ?? null) : input.pullRequest;
        // A renamed PR alone is not news; the title catches up on the next state change.
        if (
          before !== null &&
          before.missionId === mission.id &&
          before.state === state &&
          samePullRequest(before.pullRequest, pullRequest)
        ) {
          return yield* unchanged(mission.id, attachmentRef(before));
        }
        const now = yield* nowIso;
        const record: ThreadAttachment = {
          threadId: input.threadId,
          missionId: mission.id,
          attachedBy: input.attachedBy,
          title: input.title,
          pullRequest,
          state,
          createdAt: before?.missionId === mission.id ? before.createdAt : now,
          updatedAt: now,
        };
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: EVENT[state],
          summary: `${VERB[state]} ${input.title}`,
          ref: attachmentRef(record),
          upserts: [{ _tag: "thread-attachment", record }],
          payload: { state, attachedBy: input.attachedBy, pullRequest },
        });
      }),
    );

  const setThreadAttachment = (provenance: MissionProvenance, input: SetThreadAttachmentInput) =>
    serial(
      Effect.gen(function* () {
        if (
          !isOwnerProvenance(provenance) &&
          !(yield* isMasterOf(store, input.missionId, provenance))
        ) {
          return yield* fail(
            "forbidden",
            `Only the owner or mission ${input.missionId}'s master moves its attached threads.`,
          );
        }
        const mission = yield* loadMission(input.missionId);
        const before = Option.getOrNull(yield* store.get("thread-attachment", input.threadId));
        if (before === null || before.missionId !== mission.id) {
          return yield* fail(
            "not-found",
            `Thread ${input.threadId} is not attached to mission ${mission.id}.`,
          );
        }
        if (before.state === input.state)
          return yield* unchanged(mission.id, attachmentRef(before));
        if (input.state === "open") yield* requireNotActing(input.threadId);
        const record: ThreadAttachment = {
          ...before,
          state: input.state,
          updatedAt: yield* nowIso,
        };
        return yield* commit(provenance, {
          missionId: mission.id,
          kind: EVENT[input.state],
          summary: `${VERB[input.state]} ${record.title}`,
          ref: attachmentRef(record),
          upserts: [{ _tag: "thread-attachment", record }],
          payload: {
            state: input.state,
            attachedBy: record.attachedBy,
            pullRequest: record.pullRequest,
          },
        });
      }),
    );

  return { attachThread, setThreadAttachment };
};

const samePullRequest = (a: ThreadAttachment["pullRequest"], b: ThreadAttachment["pullRequest"]) =>
  a === null || b === null ? a === b : a.repository === b.repository && a.number === b.number;
