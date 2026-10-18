import { ApprovalId, PoolId, RoleId, type Approval } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import { routeApprover } from "../core/approvals.ts";
import { PolicyService } from "../policy/PolicyService.ts";
import { makePorts, testLayer } from "../policy/testing.ts";
import * as MissionStore from "../store/MissionStore.ts";
import {
  applyImport,
  applyPools,
  diffImport,
  diffPools,
  failingWrite,
  memoryRouterSink,
  readPositionId,
} from "./apply.ts";
import { coordActorFor, HAIKU_XHIGH, OPUS_XHIGH, parseCoordBodyText } from "./coordIds.ts";
import {
  awaitingStaleReason,
  buildImportPlan,
  crwApprovalId,
  reviewPoolId,
  workLinks,
} from "./mapping.ts";
import type { ImportSources } from "./readers.ts";
import { countChecks } from "./report.ts";
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
    expect(positions).toEqual({
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
        "read-position": 3,
      });
      // The dry run wrote nothing.
      assert.strictEqual(yield* store.latestSeq(p.missionId), 0);
      assert.strictEqual(router.messages.size, 0);

      const first = yield* applyImport(p, router.sink);
      assert.strictEqual(first.created.message, 4);
      assert.strictEqual(router.rooms.size, 2);
      assert.strictEqual(router.readPositions.size, 3);
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

      // The master moves the capacity; a re-import reports it and leaves it.
      yield* policy.setPoolCapacity(
        { _tag: "system", component: "test" },
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
