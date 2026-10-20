import {
  ApprovalId,
  AskId,
  CallId,
  LaneId,
  MilestoneId,
  MissionId,
  NoteId,
  RoleId,
  SubMissionId,
  ThreadId,
  WorkItemId,
  type Approval,
  type Ask,
  type Call,
  type Lane,
  type Milestone,
  type MissionEventKind,
  type MissionProvenance,
  type MissionRecordRef,
  type MissionSubscribeItem,
  type Note,
  UpdateMissionInput,
  type UpsertSubMissionInput,
  type WorkItem,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import type * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { MissionOwnerName } from "./core/ownerName.ts";
import * as MissionService from "./MissionService.ts";
import * as MissionStore from "./store/MissionStore.ts";

const TestLayer = MissionService.layer.pipe(
  Layer.provideMerge(MissionStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const decodeUpdateMission = Schema.decodeUnknownEffect(UpdateMissionInput);

const at = "2026-10-17T08:00:00.000Z";
const later = "2026-10-17T09:00:00.000Z";

const owner: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "session-1" };
const master: MissionProvenance = {
  _tag: "agent",
  threadId: ThreadId.make("thread-master"),
  roleId: null,
};
const system: MissionProvenance = { _tag: "system", component: "test" };
const masterRole = RoleId.make("role-master");

const seedEvent = (
  missionId: MissionId,
  kind: MissionEventKind,
  subject: MissionRecordRef | null,
  summary: string,
) => ({
  missionId,
  kind,
  actor: { _tag: "system", component: "test" } as const,
  provenance: system,
  summary,
  subject,
});

const lane = (
  missionId: MissionId,
  id: string,
  subMissionId: SubMissionId | null,
  status: Lane["status"],
): Lane => ({
  id: LaneId.make(id),
  missionId,
  subMissionId,
  name: `Lane ${id}`,
  purpose: "",
  status,
  statusReason: null,
  leadRoleId: null,
  threadId: null,
  currentItemId: null,
  lastEvidence: null,
  context: null,
  lastActiveAt: null,
  createdAt: at,
  updatedAt: at,
});

const ask = (missionId: MissionId, id: string, subMissionId: SubMissionId | null): Ask => ({
  id: AskId.make(id),
  missionId,
  subMissionId,
  askedBy: { _tag: "role", roleId: masterRole },
  question: "Ship behind a flag?",
  context: "",
  options: [],
  recommendation: null,
  blocks: [],
  costOfWaiting: "",
  urgency: "normal",
  status: "open",
  answer: null,
  createdAt: at,
  updatedAt: at,
});

const approval = (missionId: MissionId, id: string): Approval => ({
  id: ApprovalId.make(id),
  missionId,
  kind: "merge",
  title: "Merge PR 12",
  detail: "",
  requestedBy: "crw",
  links: [],
  status: "pending",
  staleReason: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: at,
});

const milestone = (
  missionId: MissionId,
  id: string,
  subMissionId: SubMissionId,
  itemIds: ReadonlyArray<string>,
): Milestone => ({
  id: MilestoneId.make(id),
  missionId,
  subMissionId,
  title: `Milestone ${id}`,
  targetAt: null,
  status: "on-track",
  statusNote: null,
  itemIds: itemIds.map((itemId) => WorkItemId.make(itemId)),
  createdAt: at,
  updatedAt: at,
});

const workItem = (
  missionId: MissionId,
  id: string,
  overrides: Partial<WorkItem> = {},
): WorkItem => ({
  id: WorkItemId.make(id),
  missionId,
  subMissionId: null,
  laneId: null,
  milestoneId: null,
  title: `Item ${id}`,
  kind: "ticket",
  stage: "pr",
  heldBy: null,
  blockedBy: [],
  dependsOn: [],
  pullRequest: null,
  links: [],
  facts: { mergedAtHead: null, deployedReadback: null, exercised: null },
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

const call = (missionId: MissionId, id: string): Call => ({
  id: CallId.make(id),
  missionId,
  subMissionId: null,
  decidedBy: { _tag: "role", roleId: masterRole },
  title: "Split the API lane",
  decision: "Split it in two",
  reason: "Too much in one context",
  alternatives: [],
  reversible: true,
  subject: null,
  ownerReaction: null,
  createdAt: later,
});

const note = (missionId: MissionId, id: string): Note => ({
  id: NoteId.make(id),
  missionId,
  subMissionId: null,
  laneId: null,
  type: "owner-must-know",
  summary: "The prod deploy needs a new signing key",
  sources: [],
  basis: "observed",
  severity: "high",
  confidence: 0.9,
  author: "scribe",
  citation: "verified",
  evidence: "not-applicable",
  evidenceLinks: [],
  replacesNoteId: null,
  ackedBy: [],
  createdAt: later,
});

/** Pulls until at least `count` items arrived; stream batches can hold several. */
const take = <A, E>(pull: Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E>, count: number) =>
  Effect.gen(function* () {
    const items: Array<A> = [];
    while (items.length < count) items.push(...(yield* pull));
    return items;
  });

const seqOf = (item: MissionSubscribeItem) => (item._tag === "list" ? null : item.seq);

const createMission = (id: string) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    yield* service.createMission(owner, { missionId: MissionId.make(id), slug: id, title: id });
    return MissionId.make(id);
  });

const addSubMission = (
  provenance: MissionProvenance,
  missionId: MissionId,
  title: string,
  extra: Partial<UpsertSubMissionInput> = {},
) =>
  Effect.gen(function* () {
    const service = yield* MissionService.MissionService;
    const result = yield* service.upsertSubMission(provenance, { missionId, title, ...extra });
    return SubMissionId.make(result.ref.id);
  });

it.layer(TestLayer)("MissionService", (it) => {
  it.effect("the master changes anything the owner can, and the timeline says who", () =>
    Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;
      const created = yield* service.createMission(master, {
        missionId: MissionId.make("m-master"),
        slug: "master-made",
        title: "Master made",
      });
      const missionId = MissionId.make(created.ref.id);
      const a = yield* addSubMission(master, missionId, "A");
      const b = yield* addSubMission(master, missionId, "B");
      const laneResult = yield* service.upsertLane(master, {
        missionId,
        name: "api",
        subMissionId: a,
      });
      const laneId = LaneId.make(laneResult.ref.id);

      // Former owner-only fields, a reorder after the owner's, a lane move and a close.
      yield* service.updateMission(master, { missionId, tier: "P0", guaranteedShare: 0.5 });
      yield* service.reorderSubMissions(owner, { missionId, order: [b, a] });
      yield* service.reorderSubMissions(master, { missionId, order: [a, b] });
      yield* service.upsertSubMission(master, { missionId, subMissionId: b, title: "Renamed" });
      yield* service.upsertLane(master, { missionId, laneId, subMissionId: b });
      yield* service.setMissionFocus(master, { missionId, subMissionId: b });
      yield* service.upsertSubMission(master, { missionId, subMissionId: a, status: "closed" });
      for (const status of ["paused", "active", "archived", "active"] as const) {
        yield* service.setMissionStatus(master, { missionId, status });
      }

      const events = yield* service.eventsSince(missionId, 0);
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        [
          "mission.created",
          "sub-mission.created",
          "sub-mission.created",
          "lane.created",
          "mission.updated",
          "sub-mission.reordered",
          "sub-mission.reordered",
          "sub-mission.updated",
          "lane.moved",
          "mission.updated",
          "sub-mission.closed",
          "mission.paused",
          "mission.resumed",
          "mission.archived",
          "mission.unarchived",
        ],
      );
      // A lane move keeps where the lane was, so a client can move it back.
      assert.deepStrictEqual(events.find((event) => event.kind === "lane.moved")?.payload, {
        changed: ["subMissionId"],
        status: "idle",
        subMissionId: b,
        before: { subMissionId: a },
      });
      for (const event of events.filter((event) => event.kind !== "sub-mission.reordered")) {
        assert.deepStrictEqual(event.provenance, master);
        assert.deepStrictEqual(event.actor, { _tag: "thread", threadId: master.threadId });
      }
      assert.deepStrictEqual(
        events.filter((event) => event.kind === "sub-mission.reordered").map((e) => e.actor),
        [{ _tag: "owner" }, { _tag: "thread", threadId: master.threadId }],
      );
      const mission = Option.getOrThrow(yield* store.get("mission", missionId));
      assert.equal(mission.tier, "P0");
      assert.equal(mission.focusSubMissionId, b);
      assert.deepStrictEqual(mission.lockedFields, []);

      // Marking the mission seen is the owner's own look, not a control.
      assert.equal((yield* Effect.flip(service.markSeen(master, { missionId }))).code, "forbidden");
    }),
  );

  it.effect("records provenance from the caller and ignores any in the input", () =>
    Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const missionId = yield* createMission("m-provenance");

      // A provenance smuggled into a request body is not part of the input; decoding drops it.
      const smuggled = yield* decodeUpdateMission({ missionId, tier: "P0", provenance: owner });
      assert.isFalse("provenance" in smuggled);

      const body = yield* decodeUpdateMission({ missionId, goal: "Agent goal", provenance: owner });
      const result = yield* service.updateMission(master, body);
      const [event] = yield* service.eventsSince(missionId, result.seq - 1);
      assert.deepStrictEqual(event?.provenance, master);
      assert.deepStrictEqual(event?.actor, { _tag: "thread", threadId: master.threadId });
    }),
  );

  it.effect("a reorder writes one event and bumps seq; nothing locks the order", () =>
    Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;
      const missionId = yield* createMission("m-reorder");
      const a = yield* addSubMission(master, missionId, "A");
      const b = yield* addSubMission(master, missionId, "B");
      const c = yield* addSubMission(master, missionId, "C");

      // The master sets the first order itself.
      yield* service.reorderSubMissions(master, { missionId, order: [b, a, c] });

      const before = yield* store.latestSeq(missionId);
      const result = yield* service.reorderSubMissions(owner, { missionId, order: [c, b, a] });
      assert.equal(result.seq, before + 1);
      const events = yield* service.eventsSince(missionId, before);
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.seq]),
        [["sub-mission.reordered", before + 1]],
      );

      const overview = yield* service.overview(missionId);
      assert.deepStrictEqual(
        overview.subMissions.map((subMission) => [subMission.id, subMission.order]),
        [
          [c, 0],
          [b, 1],
          [a, 2],
        ],
      );
      assert.deepStrictEqual(overview.mission.lockedFields, []);

      const incomplete = yield* Effect.flip(
        service.reorderSubMissions(owner, { missionId, order: [a, b] }),
      );
      assert.equal(incomplete.code, "invalid");
      assert.equal(yield* store.latestSeq(missionId), before + 1);
      // The master can reorder again after the owner.
      yield* service.reorderSubMissions(master, { missionId, order: [a, b, c] });
      assert.equal(yield* store.latestSeq(missionId), before + 2);
    }),
  );

  it.effect("assembles list, overview and inbox snapshots from the store", () =>
    Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;
      const missionId = yield* createMission("m-snapshot");
      const subA = yield* addSubMission(owner, missionId, "A");
      const subB = yield* addSubMission(owner, missionId, "B");

      yield* store.commit({
        event: seedEvent(missionId, "lane.updated", null, "seed"),
        upserts: [
          { _tag: "lane", record: lane(missionId, "lane-working", subA, "working") },
          { _tag: "lane", record: lane(missionId, "lane-stuck", subB, "stuck") },
          { _tag: "lane", record: lane(missionId, "lane-retired", subB, "retired") },
          { _tag: "ask", record: ask(missionId, "ask-1", subA) },
          { _tag: "approval", record: approval(missionId, "approval-1") },
          {
            _tag: "milestone",
            record: milestone(missionId, "milestone-1", subA, ["item-2", "item-1"]),
          },
          { _tag: "work-item", record: workItem(missionId, "item-1") },
          {
            _tag: "work-item",
            record: workItem(missionId, "item-2", {
              dependsOn: [WorkItemId.make("item-3")],
            }),
          },
          { _tag: "work-item", record: workItem(missionId, "item-3") },
          { _tag: "work-item", record: workItem(missionId, "item-done", { stage: "done" }) },
          { _tag: "note", record: note(missionId, "note-1") },
        ],
      });
      yield* store.commit({
        event: seedEvent(
          missionId,
          "call.made",
          { kind: "call", id: "call-1" },
          "Split the API lane",
        ),
        upserts: [{ _tag: "call", record: call(missionId, "call-1") }],
      });

      const list = yield* service.listSnapshot;
      const item = list.missions.find((entry) => entry.id === missionId);
      assert.isDefined(item);
      assert.equal(item?.needsYou, 2);
      assert.equal(item?.health, "red");
      assert.deepStrictEqual(item?.lanes, { working: 1, stuck: 1, waiting: 0, idle: 0, parked: 0 });
      assert.deepStrictEqual(
        item?.subMissions.map((entry) => [entry.id, entry.order, entry.health, entry.needsYou]),
        [
          [subA, 0, "amber", 1],
          [subB, 1, "red", 0],
        ],
      );

      const overview = yield* service.overview(missionId);
      assert.equal(overview.mission.health, "red");
      assert.equal(overview.bottomLine, "");
      assert.isNull(overview.usageShare);
      assert.isNull(overview.ownerLastLookedAt);
      assert.deepStrictEqual(
        overview.criticalPath.map((ref) => ref.id),
        ["item-3", "item-2", "item-1"],
      );
      assert.deepStrictEqual(
        overview.blockers.map((group) => [group.holderLabel, group.items.map((ref) => ref.id)]),
        [
          ["You", ["ask-1", "approval-1"]],
          ["Lane lane-stuck", ["lane-stuck"]],
        ],
      );
      assert.isTrue(overview.directionCheck.some((entry) => entry.ref.id === "call-1"));
      assert.deepStrictEqual(overview.feed.map((entry) => entry.kind).toSorted(), [
        "decided",
        "note",
      ]);

      const inbox = yield* service.inbox(missionId);
      assert.deepStrictEqual(inbox.counts, {
        decide: 1,
        approve: 1,
        knocks: 0,
        suggestions: 0,
        fyi: 1,
      });
      assert.deepStrictEqual(
        inbox.fyi.map((entry) => entry.id),
        ["note-1"],
      );

      yield* service.markSeen(owner, { missionId });
      assert.isNotNull((yield* service.overview(missionId)).ownerLastLookedAt);
    }),
  );

  it.effect("recomputes health at most every 15 seconds", () =>
    Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const missionId = yield* createMission("m-health");
      const created = yield* service.upsertLane(master, {
        missionId,
        name: "api",
        status: "working",
      });
      const healthOf = Effect.map(
        service.listSnapshot,
        (list) => list.missions.find((entry) => entry.id === missionId)?.health,
      );
      assert.equal(yield* healthOf, "green");

      yield* service.upsertLane(master, {
        missionId,
        laneId: LaneId.make(created.ref.id),
        status: "stuck",
      });
      assert.equal(yield* healthOf, "green");
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* healthOf, "red");
    }),
  );

  it.effect("subscribeList sends the snapshot, then a new one per change", () =>
    Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const pull = yield* Stream.toPull(service.subscribeList);
      const [first] = yield* take(pull, 1);
      assert.equal(first?._tag, "list");
      if (first?._tag !== "list") return;

      const missionId = yield* createMission("m-stream-list");
      const [next] = yield* take(pull, 1);
      assert.equal(next?._tag, "list");
      if (next?._tag !== "list") return;
      assert.isTrue(next.snapshot.revision > first.snapshot.revision);
      assert.isTrue(next.snapshot.missions.some((entry) => entry.id === missionId));
      assert.isFalse(first.snapshot.missions.some((entry) => entry.id === missionId));
    }).pipe(Effect.scoped),
  );

  it.effect("subscribe sends the overview, then deltas in seq order", () =>
    Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const missionId = yield* createMission("m-stream");
      const subMissionId = yield* addSubMission(master, missionId, "Import");
      const pull = yield* Stream.toPull(service.subscribe(missionId));

      const [first] = yield* take(pull, 1);
      assert.deepStrictEqual(first && [first._tag, seqOf(first)], ["overview", 2]);

      const created = yield* service.upsertLane(master, { missionId, name: "api", subMissionId });
      const afterCreate = yield* take(pull, 3);
      assert.deepStrictEqual(
        afterCreate.map((item) => [item._tag, seqOf(item)]),
        [
          ["upsert", 3],
          ["upsert", 3],
          ["overview", 3],
        ],
      );
      const laneDelta = afterCreate[0];
      assert.isTrue(laneDelta?._tag === "upsert" && laneDelta.record._tag === "lane");

      yield* service.upsertLane(master, {
        missionId,
        laneId: LaneId.make(created.ref.id),
        status: "working",
      });
      const afterUpdate = yield* take(pull, 3);
      assert.deepStrictEqual(
        afterUpdate.map((item) => [item._tag, seqOf(item)]),
        [
          ["upsert", 4],
          ["upsert", 4],
          ["overview", 4],
        ],
      );
      const lastOverview = afterUpdate[2];
      assert.isTrue(lastOverview?._tag === "overview" && lastOverview.overview.lanes.working === 1);
    }).pipe(Effect.scoped),
  );

  it.effect("digest pages events after a seq", () =>
    Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const missionId = yield* createMission("m-digest");
      yield* addSubMission(master, missionId, "A");
      yield* addSubMission(master, missionId, "B");
      const digest = yield* service.digest(missionId, { _tag: "seq", seq: 1 });
      assert.equal(digest.latestSeq, 3);
      assert.deepStrictEqual(
        digest.events.map((event) => [event.seq, event.kind]),
        [
          [2, "sub-mission.created"],
          [3, "sub-mission.created"],
        ],
      );
      assert.isFalse(digest.truncated);
      assert.equal(digest.mission?.id, missionId);
      const missing = yield* Effect.flip(
        service.digest(MissionId.make("m-missing"), { _tag: "recent" }),
      );
      assert.equal(missing.code, "not-found");
    }),
  );

  // ardud missions: core - the owner's device formats every time in its own zone
  it.effect("text the owner reads carries instants, never a baked clock time", () =>
    Effect.gen(function* () {
      const service = yield* MissionService.MissionService;
      const missionId = yield* createMission("m-clock");
      const sub = yield* addSubMission(master, missionId, "A");
      yield* service.upsertLane(master, { missionId, name: "api", subMissionId: sub });
      yield* service.upsertWorkItem(master, {
        missionId,
        workItemId: WorkItemId.make("wi-clock"),
        subMissionId: sub,
        title: "Ship it",
        kind: "ticket",
      });
      yield* service.updateMission(master, { missionId, tier: "P0" });
      yield* service.setMissionStatus(owner, { missionId, status: "paused" });
      yield* service.setMissionStatus(owner, { missionId, status: "active" });
      yield* service.setPortfolioOrder(owner, { order: [missionId] });

      const instants = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?/g;
      const clock = /\b\d{1,2}:\d{2}\b/;
      const texts = [
        ...(yield* service.eventsSince(missionId, 0)).map((event) => event.summary),
        ...(yield* service.eventsSince(MissionId.make("missions-global"), 0)).map((e) => e.summary),
        JSON.stringify(yield* service.overview(missionId)),
        JSON.stringify(yield* service.inbox(missionId)),
        JSON.stringify(yield* service.digest(missionId, { _tag: "recent" })),
        JSON.stringify(yield* service.portfolio(null)),
      ];
      assert.isAtLeast(texts.length, 10);
      for (const text of texts) {
        assert.notMatch(text.replace(instants, "<instant>"), clock, text);
      }
    }),
  );
});

it.effect(
  "the overview carries the server account's name for the greeting, null when unknown",
  () =>
    Effect.gen(function* () {
      const named = TestLayer.pipe(
        Layer.provide(Layer.succeed(MissionOwnerName, { name: "Abdullah Dudhwala" })),
      );
      const read = Effect.gen(function* () {
        const missionId = yield* createMission("m-owner-name");
        return (yield* (yield* MissionService.MissionService).overview(missionId)).ownerName;
      });
      assert.equal(yield* read.pipe(Effect.provide(named)), "Abdullah Dudhwala");
      assert.isNull(yield* read.pipe(Effect.provide(TestLayer)));
    }),
);
