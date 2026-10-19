import {
  ApprovalId,
  LaneId,
  MilestoneId,
  PoolId,
  RoleId,
  SubMissionId,
  ThreadId,
  type Approval,
  type MissionMemberPrincipal,
  type MissionProvenance,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import { agent, failureCode } from "../asks/AsksService.testkit.ts";
import { routeApprover } from "../core/approvals.ts";
import * as MissionService from "../MissionService.ts";
import { PolicyService } from "../policy/PolicyService.ts";
import { makePorts, testLayer } from "../policy/testing.ts";
import { routerImportSink } from "../router/adapters.ts";
import * as CoordShim from "../router/coordShim.ts";
import * as MissionRouter from "../router/MissionRouter.ts";
import { fakeRouterThreads, routerOverFakes } from "../router/MissionRouter.testkit.ts";
import * as MissionStore from "../store/MissionStore.ts";
import {
  applyImport,
  applyPools,
  diffImport,
  diffPools,
  failingWrite,
  memoryRouterSink,
  readPositionId,
  type KindDiff,
} from "./apply.ts";
import { coordActorFor, HAIKU_XHIGH, OPUS_XHIGH, parseCoordBodyText } from "./coordIds.ts";
import { applyEnrolments, diffEnrolments } from "./enrol.ts";
import {
  awaitingStaleReason,
  buildImportPlan,
  crwApprovalId,
  reviewPoolId,
  workLinks,
  type ImportPlan,
} from "./mapping.ts";
import { applyPlan, diffPlan, parsePlan, type MissionPlan } from "./plan.ts";
import type { ImportSources } from "./readers.ts";
import { countChecks, renderReport } from "./report.ts";
import { parseDeferred, parseLanePulse, parseLaneRoster, parseStandingRules } from "./sources.ts";

const TestLayer = MissionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const T0 = 1_800_000_000;
const LONG = `Long status ${"x".repeat(450)}`;

const RULES = `# Crpko standing owner rules

## Authority and approvals

5. Master decides and reports ("you are the master now", 2026-10-03).

## 15. INR rails out of scope for now (owner, 2026-10-07 ~18:15Z)

"INR deposits are out of scope."
-> Park every INR ticket.
`;

const DEFERRED = `| id | what | deferred by + when | why | revisit trigger | source |
|---|---|---|---|---|---|
| DF-1 | Load testing | master 2026-10-08 | not now | after harness green | ledger |
| DF-2 | DONE 2026-10-16 shipped | master 2026-10-09 | later | n/a | ledger |
`;

const ROSTER = `## Section 1. Ticket handling per service

| Service / lane | Actor(s) | Thread | Where state lives |
| --- | --- | --- | --- |
| trading-core | cell-tc, cell-tc2 | mcp:tc | ledger |

## Section 8. Lanes recovered by the backfill

| Lane | Started / why | Owner today | State at backfill |
| --- | --- | --- | --- |
| Latency budgets | 2026-10-02 owner ask | master | parked |

## Section 9. Retired lanes

| Lane | Retired | Why |
| --- | --- | --- |
| Old QA threads | 2026-09-30 | replaced |
`;

const event = (
  seq: number,
  channel: string,
  sender: string,
  kind: string,
  summary: string,
  extra: Partial<ImportSources["coord"]["events"][number]> = {},
) => ({
  seq,
  event_key: `key-${seq}`,
  body_hash: `hash-${seq}`,
  channel_id: channel,
  kind,
  sender,
  work_id: null,
  environment: null,
  expected_revision: null,
  authority_ref: null,
  summary,
  body_json: null,
  reply_to: null,
  created_at: T0 + seq,
  ...extra,
});

const sources = (crwState: { prState?: string; ticketState?: string } = {}): ImportSources => ({
  coord: {
    actors: [
      { id: "cell-tc", kind: "thread", thread_id: "mcp:tc", updated_at: T0 },
      { id: "cell-tc2", kind: "thread", thread_id: "mcp:tc2", updated_at: T0 },
      { id: "crw", kind: "process", thread_id: null, updated_at: T0 },
      { id: "master", kind: "thread", thread_id: "ardud-control:thread:m", updated_at: T0 },
      { id: "release", kind: "thread", thread_id: "ardud-control:thread:m", updated_at: T0 },
    ],
    channels: [
      {
        id: "control",
        purpose: "owner decisions",
        owner: "master",
        status: "open",
        created_at: T0,
      },
      { id: "delivery", purpose: "cell results", owner: "master", status: "open", created_at: T0 },
    ],
    members: [
      { channel_id: "control", actor_id: "crw", wake: 1 },
      { channel_id: "control", actor_id: "master", wake: 1 },
      { channel_id: "delivery", actor_id: "cell-tc", wake: 1 },
      { channel_id: "delivery", actor_id: "master", wake: 0 },
    ],
    events: [
      event(1, "delivery", "cell-tc", "evidence", "CRP-1 merged", {
        work_id: "CRP-1",
        body_json: JSON.stringify({ run: 42 }),
      }),
      event(2, "control", "master", "control", "Pause INR work", { work_id: "DF-1" }),
      event(3, "delivery", "cell-tc2", "status", LONG, {
        work_id: "Equicom-Crypto/trading-core#7",
        reply_to: 1,
      }),
      event(4, "delivery", "cell-tc", "blocker", "Need a decision"),
    ],
    deliveries: [
      { event_seq: 1, recipient: "master", status: "acked", acked_at: T0 + 10 },
      { event_seq: 2, recipient: "cell-tc", status: "acked", acked_at: T0 + 11 },
      { event_seq: 2, recipient: "crw", status: "skipped", acked_at: null },
      { event_seq: 3, recipient: "cell-tc", status: "acked", acked_at: T0 + 12 },
      { event_seq: 3, recipient: "master", status: "acked", acked_at: T0 + 13 },
      { event_seq: 4, recipient: "master", status: "pending", acked_at: null },
    ],
  },
  crw: {
    awaiting: [
      {
        prKey: "Equicom-Crypto/edge-api#9",
        awaitingSince: T0 + 100,
        title: "Fix fees",
        url: "https://github.com/Equicom-Crypto/edge-api/pull/9",
        state: crwState.prState ?? "OPEN",
        author: "dev",
        headSha: "abc123",
        tickets: [{ id: "CRP-9", state: crwState.ticketState ?? "In Review" }],
      },
    ],
    holds: [
      {
        prKey: "Equicom-Crypto/ws-gateway#33",
        reason: "needs coordination",
        createdAt: T0 + 50,
        title: "WS limits",
        url: null,
        state: "MERGED",
      },
    ],
    config: {
      excludedRepos: ["Equicom-Crypto/Crpko-Marketing-Site"],
      activeStates: ["In Review", "Code OK - Pending"],
      maxReviewsPerTick: 6,
      maxReviewsPerDay: 200,
    },
    syncedAt: T0 + 200,
  },
  rules: parseStandingRules(RULES),
  deferred: parseDeferred(DEFERRED),
  pulse: parseLanePulse(
    JSON.stringify({
      haiku: ["cell-tc2"],
      opus: ["master", "cell-tc"],
      active: { "cell-tc2": "STANDBY: waits" },
    }),
  ),
  roster: parseLaneRoster(ROSTER),
});

const plan = (s = sources()) => buildImportPlan(s, { missionId: "crpko" });

describe("buildImportPlan", () => {
  it("passes every count check and is deterministic", () => {
    const p = plan();
    expect(countChecks(p).filter((c) => c.expected !== c.actual)).toEqual([]);
    expect(JSON.stringify(plan())).toBe(JSON.stringify(p));
  });

  it("maps actors to roles, lanes and bindings with rule 98 models", () => {
    const p = plan();
    const role = (id: string) => p.core.roles.find((r) => r.id === id)!;
    expect(role("crpko:master").kind).toBe("master");
    expect(role("crpko:custom:release").name).toBe("Release owner");
    expect(role("crpko:lane-lead:crpko:lane:cell-tc").modelSelection).toEqual(OPUS_XHIGH);
    expect(role("crpko:lane-lead:crpko:lane:cell-tc2").modelSelection).toEqual(HAIKU_XHIGH);
    const tc2 = p.core.lanes.find((l) => l.id === "crpko:lane:cell-tc2")!;
    expect(tc2).toMatchObject({
      name: "cell-tc2 (trading-core)",
      status: "waiting",
      statusReason: "STANDBY: waits",
    });
    expect(p.core.lanes.find((l) => l.id === "crpko:lane:cell-tc")!.status).toBe("idle");
    expect(p.core.lanes.filter((l) => l.status === "parked").map((l) => l.name)).toEqual([
      "Latency budgets",
    ]);
    expect(p.core.lanes.filter((l) => l.status === "retired").map((l) => l.name)).toEqual([
      "Old QA threads",
    ]);
    expect(p.core.bindings.map((b) => [b.roleId, b.threadId, b.reason])).toEqual([
      ["crpko:lane-lead:crpko:lane:cell-tc", "mcp:tc", "import"],
      ["crpko:lane-lead:crpko:lane:cell-tc2", "mcp:tc2", "import"],
      ["crpko:master", "ardud-control:thread:m", "import"],
      ["crpko:custom:release", "ardud-control:thread:m", "import"],
    ]);
    // crw is a process: it speaks as a system actor and is never rung.
    const crwSub = p.router.subscriptions.find((s) => s.id === "crpko:room:control:sub:crw")!;
    expect(crwSub).toMatchObject({
      subscriber: { _tag: "system", component: "crw" },
      mode: "read",
      wakeOn: [],
    });
  });

  it("keeps history: coord seqs, keys, recipients, links and full text", () => {
    const p = plan();
    const msg = (seq: number) => p.router.messages.find((m) => m.message.seq === seq)!;
    expect(msg(1).message).toMatchObject({
      id: "crpko:coord:1",
      roomId: "crpko:room:delivery",
      kind: "evidence",
      key: "key-1",
      author: { _tag: "role", roleId: "crpko:lane-lead:crpko:lane:cell-tc" },
      to: [{ _tag: "role", roleId: "crpko:master" }],
      links: [{ kind: "ticket", label: "CRP-1", url: null, ref: "CRP-1" }],
      provenance: { _tag: "import", source: "coord.db" },
      hasBody: true,
    });
    expect(parseCoordBodyText(msg(1).message.summary, msg(1).body)).toEqual({
      summary: "CRP-1 merged",
      body: { run: 42 },
    });
    expect(msg(2).message.workItemId).toBe("crpko:deferred:DF-1");
    expect(msg(3).message.summary.length).toBe(400);
    expect(parseCoordBodyText(msg(3).message.summary, msg(3).body).summary).toBe(LONG);
    expect(msg(3).message.coord).toMatchObject({
      channel: "delivery",
      sender: "cell-tc2",
      replyTo: 1,
    });
    expect(msg(3).message.links[0]!.url).toBe(
      "https://github.com/Equicom-Crypto/trading-core/pull/7",
    );
  });

  it("turns acks into cumulative read positions", () => {
    const p = plan();
    const positions = Object.fromEntries(
      p.router.readPositions.map((r) => [readPositionId(r), r.seq]),
    );
    // master acked 1 and 3 in delivery but not 4; cell-tc acked 2 in control; crw never acked.
    // The owner starts read up to each room's last message, so imported history is not unread.
    expect(positions).toEqual({
      "crpko:room:control|owner": 2,
      "crpko:room:delivery|owner": 4,
      "crpko:room:delivery|role:crpko:master": 3,
      "crpko:room:control|role:crpko:lane-lead:crpko:lane:cell-tc": 2,
      "crpko:room:delivery|role:crpko:lane-lead:crpko:lane:cell-tc": 3,
    });
  });

  it("imports rules verbatim with their dates", () => {
    const p = plan();
    const r15 = p.core.rules.find((r) => r.number === 15)!;
    expect(r15).toMatchObject({
      id: "crpko:rule:15",
      quote: '"INR deposits are out of scope."',
      masterReading: "-> Park every INR ticket.",
      quotedAt: "2026-10-07T18:15:00.000Z",
      provenance: { _tag: "import", source: "STANDING-RULES.md" },
    });
  });

  it("imports the deferred register as work items with triggers", () => {
    const p = plan();
    expect(
      p.core.workItems.map((w) => [w.id, w.stage, w.deferral?.status, w.deferral?.trigger]),
    ).toEqual([
      ["crpko:deferred:DF-1", "ticket", "deferred", "after harness green"],
      ["crpko:deferred:DF-2", "done", "done", "n/a"],
    ]);
  });

  it("opens approvals for review decisions still with us and closes stale ones", () => {
    const p = plan();
    const approval = (id: string) => p.core.approvals.find((a) => a.id === id)!;
    expect(approval("crpko:approval:crw:Equicom-Crypto/edge-api#9@abc123")).toMatchObject({
      status: "pending",
      requestedBy: "crw",
      staleReason: null,
    });
    expect(approval("crpko:approval:crw-hold:Equicom-Crypto/ws-gateway#33")).toMatchObject({
      status: "stale-closed",
      staleReason: "PR is merged",
      decidedBy: { _tag: "import", source: "crw.db" },
    });
    const away = plan(sources({ ticketState: "In Progress" }));
    expect(away.core.approvals[0]!.staleReason).toBe("ticket not with us: CRP-9 In Progress");
  });
});

describe("awaitingStaleReason", () => {
  const config = {
    excludedRepos: ["o/site"],
    activeStates: ["In Review"],
    maxReviewsPerTick: null,
    maxReviewsPerDay: null,
  };
  const a = (over: object) => ({
    prKey: "o/r#1",
    awaitingSince: null,
    title: "t",
    url: null,
    state: "OPEN",
    author: null,
    headSha: null,
    tickets: [{ id: "CRP-1", state: "In Review" }],
    ...over,
  });
  it("mirrors crw's ticketsAway", () => {
    expect(awaitingStaleReason(a({}), config)).toBeNull();
    expect(awaitingStaleReason(a({ state: "CLOSED" }), config)).toBe("PR is closed");
    expect(awaitingStaleReason(a({ prKey: "o/site#4" }), config)).toBe(
      "repo excluded from crw (excluded_repos)",
    );
    expect(awaitingStaleReason(a({ tickets: [] }), config)).toBe(
      "no open linked Linear ticket (closed, merged or unlinked)",
    );
    // A finished co-ticket is ignored while another is still open.
    expect(
      awaitingStaleReason(
        a({
          tickets: [
            { id: "CRP-1", state: "In Review" },
            { id: "CRP-2", state: "PR Merged" },
          ],
        }),
        config,
      ),
    ).toBeNull();
  });
});

describe("workLinks and coordActorFor", () => {
  it("links tickets and pull requests only", () => {
    expect(workLinks("crp-12")).toEqual([
      { kind: "ticket", label: "CRP-12", url: null, ref: "CRP-12" },
    ]);
    expect(workLinks("harness")).toEqual([]);
    expect(workLinks(null)).toEqual([]);
  });
  it("uses the crw adapter's approval id for review decisions", () => {
    expect(crwApprovalId("crpko", "o/r#1", "0123456789abcdef")).toBe(
      "crpko:approval:crw:o/r#1@0123456789ab",
    );
    expect(crwApprovalId("crpko", "o/r#1", null)).toBe("crpko:approval:crw:o/r#1");
  });
  it("maps mission actors back to coord actors", () => {
    expect(coordActorFor("crpko", { _tag: "role", roleId: RoleId.make("crpko:master") })).toBe(
      "master",
    );
    expect(
      coordActorFor("crpko", { _tag: "role", roleId: RoleId.make("crpko:custom:release") }),
    ).toBe("release");
    expect(
      coordActorFor("crpko", {
        _tag: "role",
        roleId: RoleId.make("crpko:lane-lead:crpko:lane:cell-tc"),
      }),
    ).toBe("cell-tc");
    expect(coordActorFor("crpko", { _tag: "system", component: "crw" })).toBe("crw");
    expect(coordActorFor("crpko", { _tag: "owner" })).toBeNull();
  });
});

it.layer(TestLayer)("applyImport", (it) => {
  it.effect("writes everything once, then a re-run creates nothing", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const router = memoryRouterSink();
      const p = plan();

      const dry = yield* diffImport(p, router.sink);
      const create = Object.fromEntries(dry.kinds.map((k) => [k.kind, k.create]));
      expect(create).toEqual({
        mission: 1,
        role: 4,
        "role-binding": 4,
        lane: 4,
        rule: 2,
        "work-item": 2,
        approval: 2,
        room: 2,
        message: 4,
        subscription: 4,
        "read-position": 5,
      });
      // The dry run wrote nothing.
      assert.strictEqual(yield* store.latestSeq(p.missionId), 0);
      assert.strictEqual(router.messages.size, 0);

      const first = yield* applyImport(p, router.sink);
      assert.strictEqual(first.created.message, 4);
      assert.strictEqual(router.rooms.size, 2);
      assert.strictEqual(router.readPositions.size, 5);
      const seq = yield* store.latestSeq(p.missionId);
      assert.isTrue(seq > 0);

      const rule = yield* store.get("rule", "crpko:rule:15");
      assert.isTrue(Option.isSome(rule));
      if (Option.isSome(rule))
        assert.strictEqual(rule.value.quote, '"INR deposits are out of scope."');
      const events = yield* store.eventsSince(p.missionId, 0);
      assert.isTrue(events.every((e) => e.kind === "import.applied"));
      assert.isTrue(events.every((e) => e.provenance._tag === "import"));

      const again = yield* applyImport(plan(), router.sink);
      assert.strictEqual(again.commits, 0);
      assert.deepStrictEqual(again.created, {});
      assert.strictEqual(yield* store.latestSeq(p.missionId), seq);
      assert.isTrue(again.diff.kinds.every((k) => k.create === 0 && k.differs === 0));
    }),
  );
});

it.layer(TestLayer)("applyImport over existing records", (it) => {
  it.effect("never overwrites owner edits and closes approvals that went stale", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      yield* applyImport(plan(), null);

      // The owner retitles a rule in Robob; a re-import must not undo it.
      const rule = yield* store.get("rule", "crpko:rule:15");
      if (Option.isNone(rule)) return assert.fail("rule missing");
      yield* store.upsert(
        { _tag: "rule", record: { ...rule.value, title: "INR is out" } },
        {
          missionId: plan().missionId,
          kind: "rule.updated",
          actor: { _tag: "owner" },
          provenance: { _tag: "owner-app", surface: "web", sessionId: "s" },
          summary: "retitled",
          subject: { kind: "rule", id: "crpko:rule:15" },
        },
      );

      // Since the first import the ticket left review: the approval is now stale.
      const later = plan(sources({ ticketState: "In Progress" }));
      const dry = yield* diffImport(later, null);
      const rules = dry.kinds.find((k) => k.kind === "rule")!;
      expect(rules.differIds).toEqual(["crpko:rule:15"]);
      expect(dry.kinds.find((k) => k.kind === "approval")!.close).toBe(1);

      const applied = yield* applyImport(later, null);
      assert.strictEqual(applied.closed, 1);
      const kept = yield* store.get("rule", "crpko:rule:15");
      if (Option.isSome(kept)) assert.strictEqual(kept.value.title, "INR is out");
      const approval = yield* store.get(
        "approval",
        ApprovalId.make("crpko:approval:crw:Equicom-Crypto/edge-api#9@abc123"),
      );
      if (Option.isNone(approval)) return assert.fail("approval missing");
      const record: Approval = approval.value;
      assert.strictEqual(record.status, "stale-closed");
      assert.strictEqual(record.staleReason, "ticket not with us: CRP-9 In Progress");
    }),
  );
});

it.layer(TestLayer)("applyImport with a failing router", (it) => {
  it.effect("leaves no event behind for a router batch that failed", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const router = memoryRouterSink();
      const exit = yield* Effect.exit(
        applyImport(plan(), {
          existing: router.sink.existing,
          write: () => failingWrite("router down"),
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      // Core records committed before the router batch stay; the failed batch left no event.
      const events = yield* store.eventsSince(plan().missionId, 0);
      assert.isTrue(events.every((e) => (e.payload as { kind?: string } | null)?.kind !== "room"));
      // A retry picks up where it stopped.
      const retry = yield* applyImport(plan(), router.sink);
      assert.strictEqual(retry.created.room, 2);
      assert.strictEqual(retry.created.mission, undefined);
    }),
  );
});

describe("approval routing and review pools", () => {
  it("routes every draft and every crw approval to the owner, as data", () => {
    const routes = plan().core.mission.approvalRouting ?? [];
    expect(routes.map((r) => [r.id, r.match._tag, r.approver])).toEqual([
      ["crpko:route:drafts", "draft", "owner"],
      ["crpko:route:approvals", "approval", "owner"],
    ]);
    const draft = {
      _tag: "draft",
      channel: "github",
      audience: "PR author",
      person: null,
    } as const;
    expect(routeApprover(routes, draft)).toEqual({
      approver: "owner",
      routeId: "crpko:route:drafts",
    });
    const approval = { _tag: "approval", kind: "merge", repository: "Equicom-Crypto/x" } as const;
    expect(routeApprover(routes, approval)).toEqual({
      approver: "owner",
      routeId: "crpko:route:approvals",
    });
  });

  it("plans no review pool unless asked, and sizes each kind from crw's caps", () => {
    expect(plan().policy.pools).toEqual([]);
    const both = buildImportPlan(sources(), {
      missionId: "crpko",
      reviewPools: ["lease", "budget"],
    });
    expect(
      both.policy.pools.map((p) => [p.poolId, p.kind, p.backend, p.capacity, p.scope]),
    ).toEqual([
      [
        "crpko:pool:review-day",
        "budget",
        "crw-config",
        200,
        { _tag: "mission", missionId: "crpko" },
      ],
      ["crpko:pool:review-slots", "lease", "native", 6, { _tag: "mission", missionId: "crpko" }],
    ]);
    const s = sources();
    const noCaps = buildImportPlan(
      { ...s, crw: { ...s.crw!, config: { ...s.crw!.config, maxReviewsPerTick: null } } },
      { missionId: "crpko", reviewPools: ["lease"] },
    );
    expect(noCaps.policy.pools).toEqual([]);
    expect(noCaps.warnings).toContain(
      "review pool (lease) not planned: crw config.json has no max_reviews_per_tick",
    );
  });
});

const policyLayer = testLayer(makePorts().layer);

it.layer(policyLayer)("applyPools", (it) => {
  it.effect("creates the review pool through policy once, never touching an existing one", () =>
    Effect.gen(function* () {
      const policy = yield* PolicyService;
      const p = buildImportPlan(sources(), { missionId: "crpko", reviewPools: ["lease"] });
      yield* applyImport(p, null);

      expect((yield* diffPools(p)).create).toBe(1);
      const first = yield* applyPools(p);
      expect(first.created).toBe(1);
      const view = (yield* policy.pools({ missionId: p.missionId })).pools.find(
        (v) => v.pool.id === reviewPoolId("crpko", "lease"),
      );
      expect(view?.pool.capacity).toBe(6);
      expect(view?.pool.enforcement).toBe("enforced");

      // The owner moves the capacity; a re-import reports it and leaves it.
      yield* policy.setPoolCapacity(
        { _tag: "owner-app", surface: "web", sessionId: "session-1" },
        { poolId: PoolId.make("crpko:pool:review-slots"), capacity: 2 },
      );
      const again = yield* applyPools(p);
      expect(again.created).toBe(0);
      expect(again.diff.differIds).toEqual(["crpko:pool:review-slots"]);
      const kept = (yield* policy.pools({ missionId: p.missionId })).pools.find(
        (v) => v.pool.id === "crpko:pool:review-slots",
      );
      expect(kept?.pool.capacity).toBe(2);
    }),
  );
});

const routerThreads = fakeRouterThreads();
const EnrolLayer = CoordShim.layer.pipe(
  Layer.provideMerge(routerOverFakes(routerThreads)),
  Layer.provideMerge(MissionStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);
const importProvenance = { _tag: "import", source: "coord.db" } as const;

it.layer(EnrolLayer)("coord enrolment", (it) => {
  it.effect("enrols every coord actor once, so the shim accepts it", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const shim = yield* CoordShim.CoordShim;
      const sink = yield* routerImportSink;
      const p = plan();
      const inbox = (as: string) =>
        shim.inbox("coord", { mission: p.missionId, as, unacked: false, after: 0, limit: 50 });

      expect(p.enrolments.enrol.map((e) => e.actor)).toEqual([
        "cell-tc",
        "cell-tc2",
        "crw",
        "master",
        "release",
      ]);
      // crw is a process actor: no thread in coord.db, enrolled all the same.
      expect(p.enrolments.enrol.find((e) => e.actor === "crw")).toEqual({
        actor: "crw",
        kind: "process",
        threadId: null,
      });

      yield* applyImport(p, sink);
      const refused = yield* Effect.flip(inbox("cell-tc"));
      expect(refused).toMatchObject({ _tag: "CoordRefusal", status: 403 });

      expect(yield* Effect.flip(inbox("crw"))).toMatchObject({ status: 403 });
      expect((yield* diffEnrolments(p)).create).toBe(5);
      const first = yield* applyEnrolments(p);
      expect(first.enrolled).toEqual(["cell-tc", "cell-tc2", "crw", "master", "release"]);
      const rows = yield* inbox("cell-tc");
      expect(rows.length).toBeGreaterThan(0);
      yield* inbox("crw");

      const events = (yield* store.eventsSince(p.missionId, 0)).filter(
        (e) => e.kind === "member.changed",
      );
      expect(events.map((e) => (e.payload as { principal: string }).principal)).toEqual([
        "coord:cell-tc",
        "coord:cell-tc2",
        "coord:crw",
        "coord:master",
        "coord:release",
      ]);
      expect(events.every((e) => e.provenance._tag === "import")).toBe(true);
      expect(events[0]?.actor).toEqual({ _tag: "system", component: "import:coord.db" });

      const seq = yield* store.latestSeq(p.missionId);
      const again = yield* applyEnrolments(plan());
      expect(again.enrolled).toEqual([]);
      expect(again.diff).toMatchObject({ create: 0, unchanged: 5, differs: 0 });
      expect(yield* store.latestSeq(p.missionId)).toBe(seq);
    }),
  );

  it.effect("keeps an actor the master removed out, and may only add coord members", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const router = yield* MissionRouter.MissionRouter;
      const p = plan();
      yield* applyImport(p, yield* routerImportSink);
      yield* applyEnrolments(p);

      for (const actor of ["cell-tc2", "crw"]) {
        yield* router.setMember(
          { missionId: p.missionId, principal: { _tag: "coord", actor }, member: false },
          agent(ThreadId.make("ardud-control:thread:m")),
        );
      }
      const seq = yield* store.latestSeq(p.missionId);
      const again = yield* applyEnrolments(plan());
      expect(again.enrolled).toEqual([]);
      expect(again.diff).toMatchObject({ create: 0, unchanged: 3, differs: 2 });
      expect(again.diff.differIds).toEqual(["cell-tc2", "crw"]);
      expect(yield* store.latestSeq(p.missionId)).toBe(seq);

      const set = (principal: MissionMemberPrincipal, member: boolean) =>
        failureCode(
          router.setMember({ missionId: p.missionId, principal, member }, importProvenance),
        );
      expect(yield* set({ _tag: "coord", actor: "cell-tc" }, false)).toBe("forbidden");
      expect(yield* set({ _tag: "thread", threadId: ThreadId.make("mcp:tc") }, true)).toBe(
        "forbidden",
      );
      expect(yield* set({ _tag: "session", sessionId: "s-9", label: "crw" }, true)).toBe(
        "forbidden",
      );
    }),
  );

  it.effect("finds a removal past the first event page and reports each actor's state", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const router = yield* MissionRouter.MissionRouter;
      const p = plan();
      yield* applyImport(p, yield* routerImportSink);
      yield* applyEnrolments(p);
      const master = agent(ThreadId.make("ardud-control:thread:m"));
      const member = (actor: string, on: boolean) =>
        router.setMember(
          { missionId: p.missionId, principal: { _tag: "coord", actor }, member: on },
          master,
        );

      // Push the removal of coord:release onto the second page of mission events.
      for (let n = 0; n < 520; n++) {
        yield* store.appendEvent({
          missionId: p.missionId,
          kind: "import.applied",
          actor: { _tag: "system", component: "coord-import" },
          provenance: importProvenance,
          summary: `filler ${n}`,
          subject: null,
        });
      }
      yield* member("release", false);
      yield* member("cell-tc2", false);
      yield* member("cell-tc2", true);
      // The layer is shared: the previous test removed crw. The master takes it back.
      yield* member("crw", true);
      expect(yield* store.latestSeq(p.missionId)).toBeGreaterThan(500);

      const diff = yield* diffEnrolments(p);
      expect(diff).toMatchObject({ create: 0, unchanged: 4, differs: 1, createIds: [] });
      expect(diff.differIds).toEqual(["release"]);

      const report = renderReport({
        plan: p,
        diff: { kinds: [diff], routerAvailable: true },
        mode: "dry-run",
        paths: {},
        against: "test store",
      }).split("\n");
      const section = report.slice(report.findIndex((l) => l.startsWith("Coord enrolments")));
      const line = (actor: string) =>
        section
          .find((l) => l.split(/\s+/)[2] === actor)
          ?.trim()
          .split(/\s+/)[0];
      expect(["cell-tc", "cell-tc2", "master", "release", "crw"].map(line)).toEqual([
        "same",
        "same",
        "same",
        "removed",
        "same",
      ]);
      expect(section.find((l) => l.split(/\s+/)[2] === "crw")).toContain(
        "(process actor, no thread)",
      );
    }),
  );
});

const MISSION_PLAN = `{
  "mission": "crpko",
  "subMissions": [
    {
      "key": "arch-wave",
      "title": "Architecture wave delivery",
      "intent": "Land the wave",
      "milestones": [
        { "key": "arch-wave-done", "title": "Wave delivered", "due": "2026-10-19T18:00:00+04:00" },
        { "key": "arch-wave-review", "title": "Wave reviewed" }
      ],
      "lanes": ["cell-tc", "crpko:lane:cell-tc2"]
    },
    {
      "key": "pr-factory",
      "title": "PR factory",
      "fillIdleCapacity": true,
      "lanes": ["backfill:latency-budgets"]
    }
  ],
  "unplaced": [{ "lane": "retired:old-qa-threads", "reason": "retired before the plan" }]
}
`;

const missionPlanFor = (p: ImportPlan, text = MISSION_PLAN): MissionPlan => {
  const result = parsePlan(text, "plan.json", p);
  if (result._tag !== "ok") throw new Error(result.errors.join("\n"));
  return result.plan;
};

const PlanLayer = MissionService.layer.pipe(Layer.provideMerge(TestLayer));
const ownerApp: MissionProvenance = { _tag: "owner-app", surface: "web", sessionId: "s-1" };
const planRows = (kinds: ReadonlyArray<KindDiff>) =>
  kinds.map((k) => [k.kind, k.create, k.unchanged, k.differs]);
/** Runs the import and the plan once, as a first apply would. */
const importAndPlan = Effect.gen(function* () {
  const p = plan();
  const mp = missionPlanFor(p);
  yield* applyImport(p, memoryRouterSink().sink);
  yield* applyPlan(mp, p.missionId);
  return { p, mp, missionId: p.missionId };
});

it.layer(PlanLayer)("mission plan", (it) => {
  it.effect(
    "creates sub-missions, milestones and placements once; a second apply writes nothing",
    () =>
      Effect.gen(function* () {
        const store = yield* MissionStore.MissionStore;
        const router = memoryRouterSink();
        const p = plan();
        const mp = missionPlanFor(p);
        yield* applyImport(p, router.sink);
        const afterImport = yield* store.latestSeq(p.missionId);

        const dry = yield* diffPlan(mp, p.missionId);
        expect(planRows(dry.kinds)).toEqual([
          ["sub-mission", 2, 0, 0],
          ["milestone", 2, 0, 0],
          ["lane-placement", 3, 0, 0],
        ]);
        assert.strictEqual(yield* store.latestSeq(p.missionId), afterImport);

        const first = yield* applyPlan(mp, p.missionId);
        expect(first.created).toEqual({ "sub-mission": 2, milestone: 2, "lane-placement": 3 });
        assert.strictEqual(first.commits, 7);
        const prov = { _tag: "import", source: "mission plan" };
        expect(
          (yield* store.eventsSince(p.missionId, afterImport)).map((e) => [
            e.kind,
            e.subject?.id,
            e.provenance,
          ]),
        ).toEqual([
          ["sub-mission.created", "crpko:sub:arch-wave", prov],
          ["sub-mission.created", "crpko:sub:pr-factory", prov],
          ["milestone.created", "crpko:milestone:arch-wave-done", prov],
          ["milestone.created", "crpko:milestone:arch-wave-review", prov],
          ["lane.moved", "crpko:lane:cell-tc", prov],
          ["lane.moved", "crpko:lane:cell-tc2", prov],
          ["lane.moved", "crpko:lane:backfill:latency-budgets", prov],
        ]);
        const subs = yield* store.list("sub-mission", { missionId: p.missionId });
        expect(
          subs
            .toSorted((a, b) => a.order - b.order)
            .map((s) => [s.id, s.order, s.fillIdleCapacity]),
        ).toEqual([
          ["crpko:sub:arch-wave", 0, false],
          ["crpko:sub:pr-factory", 1, true],
        ]);
        const done = yield* store.get("milestone", "crpko:milestone:arch-wave-done");
        assert.isTrue(Option.isSome(done) && done.value.targetAt === "2026-10-19T14:00:00.000Z");
        const tc = yield* store.get("lane", "crpko:lane:cell-tc");
        assert.isTrue(Option.isSome(tc) && tc.value.subMissionId === "crpko:sub:arch-wave");

        // A placed lane still counts as the record the import made.
        const core = yield* diffImport(p, router.sink);
        assert.isTrue(core.kinds.every((k) => k.create === 0 && k.differs === 0));

        const seq = yield* store.latestSeq(p.missionId);
        const second = yield* applyPlan(missionPlanFor(plan()), p.missionId);
        assert.strictEqual(second.commits, 0);
        assert.strictEqual(yield* store.latestSeq(p.missionId), seq);
        expect(planRows(second.state.kinds)).toEqual([
          ["sub-mission", 0, 2, 0],
          ["milestone", 0, 2, 0],
          ["lane-placement", 0, 3, 0],
        ]);
      }),
  );
});

it.layer(PlanLayer)("mission plan after owner edits", (it) => {
  it.effect("leaves what the owner changed since, and says so", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const service = yield* MissionService.MissionService;
      const { p, mp, missionId } = yield* importAndPlan;
      // The owner renames a sub-mission, moves cell-tc2 to the PR factory and
      // takes cell-tc out of its sub-mission.
      yield* service.upsertSubMission(ownerApp, {
        missionId,
        subMissionId: SubMissionId.make("crpko:sub:pr-factory"),
        title: "PR factory (fill idle)",
      });
      yield* service.upsertLane(ownerApp, {
        missionId,
        laneId: LaneId.make("crpko:lane:cell-tc2"),
        subMissionId: SubMissionId.make("crpko:sub:pr-factory"),
      });
      yield* service.upsertLane(ownerApp, {
        missionId,
        laneId: LaneId.make("crpko:lane:cell-tc"),
        subMissionId: null,
      });
      const seq = yield* store.latestSeq(missionId);

      const again = yield* applyPlan(mp, missionId);
      assert.strictEqual(again.commits, 0);
      assert.strictEqual(yield* store.latestSeq(missionId), seq);
      expect(again.state.kinds.map((k) => [k.kind, k.unchanged, k.differIds])).toEqual([
        ["sub-mission", 1, ["crpko:sub:pr-factory"]],
        ["milestone", 2, []],
        ["lane-placement", 1, ["crpko:lane:cell-tc", "crpko:lane:cell-tc2"]],
      ]);
      const report = renderReport({
        plan: p,
        diff: { kinds: again.state.kinds, routerAvailable: true },
        mode: "dry-run",
        paths: {},
        against: "test store",
        missionPlan: mp,
        planState: again.state,
      });
      expect(report).toContain("differs  PR factory");
      expect(report).toContain(
        "lane differs  cell-tc2 (trading-core) (now in crpko:sub:pr-factory; kept)",
      );
      expect(report).toContain(
        "lane differs  cell-tc (trading-core) (now in no sub-mission; kept)",
      );
      expect(report).toContain("unplaced Old QA threads: retired before the plan");
      expect(report).toContain("milestone same     Wave delivered (due 2026-10-19T14:00:00.000Z)");
    }),
  );
});

// A later plan version adds a milestone and places a lane that the first one left out.
const LATER_PLAN = MISSION_PLAN.replace(
  '{ "key": "arch-wave-review", "title": "Wave reviewed" }',
  '{ "key": "arch-wave-review", "title": "Wave reviewed" },\n        { "key": "arch-wave-retro", "title": "Wave retro" }',
)
  .replace(
    '"lanes": ["backfill:latency-budgets"]',
    '"lanes": ["backfill:latency-budgets", "retired:old-qa-threads"]',
  )
  .replace(/,\n  "unplaced": \[[^\]]*\]/, "");

it.layer(PlanLayer)("mission plan after closes, parks and merges", (it) => {
  it.effect("adds nothing to a closed sub-mission and re-places no lane someone took out", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const service = yield* MissionService.MissionService;
      const { p, missionId } = yield* importAndPlan;
      const later = missionPlanFor(p, LATER_PLAN);
      expect(planRows((yield* diffPlan(later, missionId)).kinds)).toEqual([
        ["sub-mission", 0, 2, 0],
        ["milestone", 1, 2, 0],
        ["lane-placement", 1, 3, 0],
      ]);
      const seqBefore = yield* store.latestSeq(missionId);

      // The owner parks cell-tc out of its sub-mission in one edit (a lane.parked
      // event, not lane.moved), saves the due time without milliseconds, merges
      // the PR factory into the wave and closes the wave.
      yield* service.upsertLane(ownerApp, {
        missionId,
        laneId: LaneId.make("crpko:lane:cell-tc"),
        status: "parked",
        subMissionId: null,
      });
      yield* service.upsertMilestone(ownerApp, {
        missionId,
        milestoneId: MilestoneId.make("crpko:milestone:arch-wave-done"),
        targetAt: "2026-10-19T14:00:00Z",
      });
      yield* service.mergeSubMissions(ownerApp, {
        missionId,
        subMissionId: SubMissionId.make("crpko:sub:pr-factory"),
        intoSubMissionId: SubMissionId.make("crpko:sub:arch-wave"),
      });
      yield* service.upsertSubMission(ownerApp, {
        missionId,
        subMissionId: SubMissionId.make("crpko:sub:arch-wave"),
        status: "closed",
      });
      const last = yield* store.eventsSince(missionId, seqBefore);
      expect(last.map((e) => e.kind)).toEqual([
        "lane.parked",
        "milestone.updated",
        "sub-mission.merged",
        "sub-mission.closed",
      ]);
      const seq = yield* store.latestSeq(missionId);

      const again = yield* applyPlan(later, missionId);
      assert.strictEqual(again.commits, 0);
      assert.strictEqual(yield* store.latestSeq(missionId), seq);
      expect(again.state.kinds.map((k) => [k.kind, k.create, k.unchanged, k.differIds])).toEqual([
        ["sub-mission", 0, 0, ["crpko:sub:arch-wave", "crpko:sub:pr-factory"]],
        // The due time saved without milliseconds is still the same moment.
        ["milestone", 0, 2, ["crpko:milestone:arch-wave-retro"]],
        [
          "lane-placement",
          0,
          1,
          // cell-tc was parked out, latency-budgets went with the merge, and the
          // newly planned lane would land in a closed sub-mission.
          [
            "crpko:lane:cell-tc",
            "crpko:lane:backfill:latency-budgets",
            "crpko:lane:retired:old-qa-threads",
          ],
        ],
      ]);
      const report = renderReport({
        plan: p,
        diff: { kinds: again.state.kinds, routerAvailable: true },
        mode: "dry-run",
        paths: {},
        against: "test store",
        missionPlan: later,
        planState: again.state,
      });
      const shut = "(sub-mission closed or another mission's; not";
      expect(report).toContain(`milestone differs  Wave retro (due none) ${shut} created)`);
      expect(report).toContain(`lane differs  Old QA threads ${shut} placed)`);
      expect(report).toContain(
        "lane differs  cell-tc (trading-core) (now in no sub-mission; kept)",
      );
      expect(report).toContain("lane differs  Latency budgets (now in crpko:sub:arch-wave; kept)");
      expect(report).toContain(
        "milestone not written (sub-mission closed or another mission's): crpko:milestone:arch-wave-retro",
      );
      expect(report).not.toContain("milestone differs (kept as is)");
      expect(report).toContain(
        "lane-placement differs (kept as is): crpko:lane:cell-tc, crpko:lane:backfill:latency-budgets",
      );
      expect(report).toContain(
        "lane-placement not written (sub-mission closed or another mission's): crpko:lane:retired:old-qa-threads",
      );
    }),
  );
});

it.layer(PlanLayer)("mission plan after a park and a retire", (it) => {
  it.effect("does not re-place a lane someone parked into a sub-mission and retired out", () =>
    Effect.gen(function* () {
      const store = yield* MissionStore.MissionStore;
      const service = yield* MissionService.MissionService;
      const { p, missionId } = yield* importAndPlan;
      // The edits sit past the scan's first page of events.
      for (let n = 0; n < 520; n++)
        yield* store.appendEvent({
          missionId,
          kind: "import.applied",
          actor: { _tag: "system", component: "coord-import" },
          provenance: ownerApp,
          summary: `filler ${n}`,
          subject: null,
        });
      // The first plan left old-qa-threads unplaced. The owner parks it into the
      // wave, then retires it out again: lane.parked and lane.retired, no lane.moved.
      const qa = LaneId.make("crpko:lane:retired:old-qa-threads");
      yield* service.upsertLane(ownerApp, {
        missionId,
        laneId: qa,
        status: "parked",
        subMissionId: SubMissionId.make("crpko:sub:arch-wave"),
      });
      yield* service.upsertLane(ownerApp, {
        missionId,
        laneId: qa,
        status: "retired",
        subMissionId: null,
      });
      const seq = yield* store.latestSeq(missionId);
      expect((yield* store.eventsSince(missionId, seq - 2)).map((e) => e.kind)).toEqual([
        "lane.parked",
        "lane.retired",
      ]);

      // The later plan puts it in the PR factory, which is still open.
      const again = yield* applyPlan(missionPlanFor(p, LATER_PLAN), missionId);
      assert.strictEqual(again.state.placements.get(qa)?.state, "differs");
      assert.isFalse(again.state.blocked.has(qa));
      // Only the new milestone is written.
      expect(again.created).toEqual({ "sub-mission": 0, milestone: 1, "lane-placement": 0 });
      const lane = yield* store.get("lane", qa);
      assert.isTrue(Option.isSome(lane) && lane.value.subMissionId === null);
      assert.strictEqual(yield* store.latestSeq(missionId), seq + 1);
    }),
  );
});
