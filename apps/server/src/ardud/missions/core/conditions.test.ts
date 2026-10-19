import {
  ApprovalId,
  MissionError,
  OwnerRequestId,
  type MissionProvenance,
  type MissionRecordRef,
  type OpenApprovalInput,
  type OwnerCondition,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AsksService from "../asks/AsksService.ts";
import {
  agent,
  failureCode,
  harness,
  laneThread,
  masterThread,
  missionId,
  ownerApp,
  seed,
} from "../asks/AsksService.testkit.ts";
import { OwnerConditions } from "../discuss/OwnerConditions.ts";
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";

const crw: MissionProvenance = { _tag: "system", component: "crw" };
const master = agent(masterThread);
const laneAgent = agent(laneThread);

const condition: OwnerCondition = {
  requestId: OwnerRequestId.make("req-1"),
  quote: "fine if it stays online",
};

/** Verifies only `condition` about the subjects it was told about; records every call. */
const withConditions = (subjects: Array<MissionRecordRef>) => {
  const verified: Array<string> = [];
  const settled: Array<{ readonly subject: string; readonly note: string | null }> = [];
  const fake = Layer.succeed(
    OwnerConditions,
    OwnerConditions.of({
      verify: ({ subject, condition: given }) =>
        subjects.some((known) => known.kind === subject.kind && known.id === subject.id) &&
        given.requestId === condition.requestId &&
        given.quote === condition.quote
          ? Effect.sync(() => {
              verified.push(`${subject.kind}:${subject.id}`);
            })
          : Effect.fail(new MissionError({ code: "forbidden", detail: "Not what he said." })),
      settleFor: ({ subject, note }) =>
        Effect.sync(() => {
          settled.push({ subject: `${subject.kind}:${subject.id}`, note });
        }),
    }),
  );
  return { verified, settled, layer: harness().layer.pipe(Layer.provideMerge(fake)) };
};

const ownerRouted = (pr: string): OpenApprovalInput => ({
  missionId,
  approvalId: ApprovalId.make(`m-1:approval:crw:acme/api#${pr}@aaaaaaaaaaaa`),
  kind: "merge",
  title: `Good to merge: acme/api#${pr}`,
  detail: "Decide in the review thread.",
  requestedBy: "crw",
  links: [
    {
      kind: "pull-request",
      label: `acme/api#${pr}`,
      url: `https://github.com/acme/api/pull/${pr}`,
      ref: "aaaaaaaaaaaa",
    },
  ],
});

describe("deciding on the owner's condition", () => {
  it.effect("the master decides an owner-routed approval only on his verified condition", () => {
    const approval = ownerRouted("7");
    const subject = { kind: "approval" as const, id: approval.approvalId, label: approval.title };
    const { verified, settled, layer } = withConditions([subject]);
    return Effect.gen(function* () {
      yield* seed;
      const missions = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;
      yield* missions.openApproval(crw, approval);
      const decide = (provenance: MissionProvenance, onOwnerCondition?: OwnerCondition) =>
        missions.decideApproval(provenance, {
          approvalId: approval.approvalId,
          action: "approve",
          ...(onOwnerCondition === undefined ? {} : { onOwnerCondition }),
        });

      assert.equal(yield* failureCode(decide(master)), "provenance-required");
      assert.equal(
        yield* failureCode(decide(master, { ...condition, quote: "maybe later" })),
        "forbidden",
      );
      assert.equal(yield* failureCode(decide(laneAgent, condition)), "forbidden");
      assert.equal(yield* failureCode(decide(ownerApp, condition)), "invalid");
      assert.deepStrictEqual(verified, []);

      const result = yield* decide(master, condition);
      const decided = Option.getOrThrow(yield* store.get("approval", approval.approvalId));
      assert.equal(decided.status, "approved");
      assert.deepStrictEqual(decided.decidedBy, master);
      assert.deepStrictEqual(decided.onOwnerCondition, condition);
      const [event] = yield* missions.eventsSince(missionId, result.seq - 1);
      assert.equal(event?.summary, `Approved on the owner's condition: ${approval.title}`);
      assert.deepStrictEqual(verified, [`approval:${approval.approvalId}`]);
      assert.deepStrictEqual(settled, [
        { subject: `approval:${approval.approvalId}`, note: "Approved on your condition." },
      ]);

      // The owner's own decision settles his conversation about it too.
      const other = ownerRouted("8");
      yield* missions.openApproval(crw, other);
      yield* missions.decideApproval(ownerApp, {
        approvalId: other.approvalId,
        action: "reject",
        note: "too risky",
      });
      assert.deepStrictEqual(settled.at(-1), {
        subject: `approval:${other.approvalId}`,
        note: "Rejected: too risky",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("without the Discuss port nothing verifies, so only the owner decides", () => {
    const approval = ownerRouted("9");
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const missions = yield* MissionService.MissionService;
      yield* missions.openApproval(crw, approval);
      assert.equal(
        yield* failureCode(
          missions.decideApproval(master, {
            approvalId: approval.approvalId,
            action: "approve",
            onOwnerCondition: condition,
          }),
        ),
        "forbidden",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("the master revises a call only on the owner's verified condition", () => {
    const subjects: Array<MissionRecordRef> = [];
    const { verified, settled, layer } = withConditions(subjects);
    return Effect.gen(function* () {
      yield* seed;
      const missions = yield* MissionService.MissionService;
      const asks = yield* AsksService.AsksService;
      const store = yield* MissionStore.MissionStore;
      const call = yield* asks.makeCall(
        {
          missionId,
          title: "Postgres over SQLite",
          decision: "Use Postgres for the ledger.",
          reason: "Concurrent writers.",
        },
        master,
      );
      yield* asks.reactToCall({ callId: call.id, reaction: "discuss" }, ownerApp);
      subjects.push({ kind: "call", id: call.id, label: call.title });
      const revise = (provenance: MissionProvenance, given: OwnerCondition) =>
        missions.reviseCall(provenance, {
          callId: call.id,
          decision: "Use Postgres, with a nightly SQLite export.",
          onOwnerCondition: given,
        });

      assert.equal(yield* failureCode(revise(ownerApp, condition)), "invalid");
      assert.equal(yield* failureCode(revise(laneAgent, condition)), "forbidden");
      assert.equal(
        yield* failureCode(revise(master, { ...condition, quote: "whatever" })),
        "forbidden",
      );

      const result = yield* revise(master, condition);
      const revised = Option.getOrThrow(yield* store.get("call", call.id));
      assert.equal(revised.decision, "Use Postgres, with a nightly SQLite export.");
      assert.equal(revised.reason, "Concurrent writers.");
      assert.equal(revised.ownerReaction, null);
      assert.deepStrictEqual(revised.onOwnerCondition, condition);
      const [event] = yield* missions.eventsSince(missionId, result.seq - 1);
      assert.equal(event?.kind, "call.revised");
      assert.deepStrictEqual(event?.payload, {
        previousDecision: "Use Postgres for the ledger.",
        previousReason: "Concurrent writers.",
      });
      assert.deepStrictEqual(verified, [`call:${call.id}`]);
      assert.deepStrictEqual(settled, [
        { subject: `call:${call.id}`, note: "Revised on your condition." },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
