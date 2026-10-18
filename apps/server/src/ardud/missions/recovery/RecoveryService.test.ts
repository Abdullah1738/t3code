import { assert, it } from "@effect/vitest";
import {
  MissionError,
  PoolHoldId,
  PoolId,
  RoleId,
  ThreadId,
  type Lane,
  type PoolHold,
  type RecoveryIncident,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  agent,
  lane,
  laneThread,
  masterThread,
  mission,
  missionId,
  ownerApp,
  role,
} from "../asks/AsksService.testkit.ts";
import * as MissionService from "../MissionService.ts";
import * as PolicyService from "../policy/PolicyService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import * as RecoveryService from "./RecoveryService.ts";
import * as RecoveryStore from "./RecoveryStore.ts";
import {
  T0,
  boot,
  childRow,
  docsThread,
  handoff,
  harness,
  itemRow,
  plus,
  previousBoot,
  runRow,
  subMission,
  test,
  threadRow,
  webLane,
  webThread,
  world,
} from "./testkit.ts";

// The server comes back at 09:00:00; the previous one last beat at 08:58.
const RESTART = 3600;

/** A member run the restart cut while it was running `command`. */
const cutRun = (
  threadId: string,
  ordinal: number,
  command: string,
  completedAt = plus(RESTART + 1),
) =>
  Effect.gen(function* () {
    yield* runRow({ threadId, ordinal, status: "cancelled", completedAt });
    yield* itemRow(`${threadId}-run-${ordinal}`, threadId, 1, "command_execution", "running", {
      input: command,
    });
  });

const restartWorld = (lanes?: ReadonlyArray<Lane>, extra?: Parameters<typeof world>[0]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0 + RESTART * 1000);
    yield* world({ ...extra, ...(lanes === undefined ? {} : { lanes }) });
    yield* previousBoot(plus(RESTART - 120));
  });

const threadsOf = (incident: RecoveryIncident | null) => {
  assert.isNotNull(incident);
  return (incident?.threads ?? []).map((thread) => ({
    threadId: thread.threadId,
    position: thread.position,
    action: thread.action,
    reason: thread.reason,
  }));
};

it.effect("a restart opens one incident, tells the master first, then resumes lanes", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* restartWorld();
    // API lane: cut while waiting on offbox, with two native subagents.
    yield* cutRun(laneThread, 1, "offbox wait run-42");
    yield* childRow({
      id: "sub-a",
      threadId: laneThread,
      runId: `${laneThread}-run-1`,
      status: "cancelled",
      title: "Fix CRP-123 review findings",
      completedAt: plus(RESTART + 1),
      session: "ses_a1",
    });
    yield* childRow({
      id: "sub-b",
      threadId: laneThread,
      runId: `${laneThread}-run-1`,
      status: "cancelled",
      title: "Harness sweep",
      completedAt: plus(RESTART + 1),
      session: "ses_b2",
    });
    // Docs lane waits on an owner ask; its run was cut with one child.
    yield* cutRun(docsThread, 1, "vp run docs:build");
    yield* childRow({
      id: "sub-c",
      threadId: docsThread,
      runId: `${docsThread}-run-1`,
      status: "cancelled",
      title: "Docs index",
      completedAt: plus(RESTART + 1),
      session: "ses_c3",
    });
    // The web lane was idle: nothing to tell it.

    const incident = yield* boot;
    assert.deepStrictEqual(threadsOf(incident), [
      {
        threadId: masterThread,
        position: 0,
        action: "notice-only",
        reason: "summary for the master",
      },
      { threadId: laneThread, position: 1, action: "resume", reason: "turn cut" },
      {
        threadId: docsThread,
        position: 2,
        action: "notice-only",
        reason: "waiting on owner ask ask-7: Which docs host?",
      },
    ]);
    assert.strictEqual(incident?.cause, "server-restart");
    assert.strictEqual(incident?.downSeconds, 120);
    const api = incident?.threads[1];
    assert.deepStrictEqual(
      api?.lostChildren.map((child) => [child.title, child.kind, child.ref]),
      [
        ["Fix CRP-123 review findings", "native-subagent", "ses_a1"],
        ["Harness sweep", "native-subagent", "ses_b2"],
      ],
    );

    const missions = yield* MissionService.MissionService;
    const overview = yield* missions.overview(missionId);
    assert.deepStrictEqual(overview.recovery, {
      incidentId: incident?.id ?? "",
      cause: "server-restart",
      at: plus(RESTART),
      label: "Recovered from restart at 09:00",
      total: 3,
      pending: 3,
      reconcile: 0,
    });
    const inbox = yield* missions.inbox(missionId);
    assert.deepStrictEqual(
      inbox.fyi.map((note) => [note.author, note.summary]),
      [
        [
          "code-check",
          "Recovered from restart at 09:00: 3 thread(s) (1 resume, 2 notice only). Master first, then 4 per minute.",
        ],
      ],
    );

    // Master first; lanes wait 60 seconds after its note.
    const recovery = yield* RecoveryService.RecoveryService;
    assert.strictEqual(yield* recovery.tick, 1);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread],
    );
    const master = fake.sent[0]?.text ?? "";
    assert.include(
      master,
      '[mission recovery] Robob restarted at 09:00 (down about 2 min). Mission "Mission one": 2 thread(s) affected. You get this first.',
    );
    assert.include(
      master,
      '1. lane "API" ("Lane API", t-lane): resume (turn cut). Cut while running `offbox wait run-42`. Lost 2: `Fix CRP-123 review findings` (native subagent, session ses_a1), `Harness sweep` (native subagent, session ses_b2).',
    );
    assert.include(master, '2. lane "Docs" ("Lane Docs", t-docs): notice only, stays as it is');
    assert.include(master, "Your own turn was not running.");

    yield* TestClock.adjust("30 seconds");
    assert.strictEqual(yield* recovery.tick, 0);
    yield* TestClock.adjust("31 seconds");
    assert.strictEqual(yield* recovery.tick, 2);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread, laneThread, docsThread],
    );
    assert.strictEqual(
      fake.sent[1]?.text,
      "[mission recovery] Robob restarted at 09:00. Your turn was cut while you were running `offbox wait run-42`. You had 2 background children: `Fix CRP-123 review findings` (native subagent, session ses_a1) and `Harness sweep` (native subagent, session ses_b2). They were stopped and will not report back. Resume each one: native subagents by passing the session id back to the subagent tool with a short prompt (keeps their context). Then continue your work.",
    );
    assert.strictEqual(
      fake.sent[2]?.text,
      "[mission recovery] Robob restarted at 09:00. Your turn was cut while you were running `vp run docs:build`. You had 1 background child: `Docs index` (native subagent, session ses_c3). They were stopped and will not report back. When you are released, resume each one: native subagents by passing the session id back to the subagent tool with a short prompt (keeps their context). Your work stays as it is (waiting on owner ask ask-7: Which docs host?): do not restart it now.",
    );
    assert.isFalse(fake.sent.some((sent) => sent.threadId === webThread));

    // Everyone heard: the overview state clears and the timeline says so.
    assert.isNull((yield* missions.overview(missionId)).recovery);
    const store = yield* MissionStore.MissionStore;
    const kinds = (yield* store.recentEvents(missionId, 20)).map((event) => event.kind);
    assert.deepStrictEqual(
      kinds.filter((kind) => kind.startsWith("recovery.")),
      [
        "recovery.incident-cleared",
        "recovery.notice-sent",
        "recovery.notice-sent",
        "recovery.notice-sent",
        "recovery.incident-opened",
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a second boot over the same runs opens nothing new", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* restartWorld();
    yield* cutRun(laneThread, 1, "offbox wait run-42");
    const first = yield* boot;
    assert.isNotNull(first);
    assert.isNull(yield* (yield* RecoveryService.RecoveryService).detectBoot);

    // A fresh server instance on the same database, three minutes later.
    yield* TestClock.adjust("3 minutes");
    const second = yield* RecoveryService.make;
    yield* second.beat;
    assert.isNull(yield* second.detectBoot);
    const recoveryStore = yield* RecoveryStore.RecoveryStore;
    assert.deepStrictEqual(
      (yield* recoveryStore.openIncidents).map((incident) => incident.id),
      [first?.id ?? ""],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("an owner Stop is never resumed; a stall-watch interrupt is", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* restartWorld();
    assert.isNull(yield* boot);
    const recovery = yield* RecoveryService.RecoveryService;

    // Ten minutes after boot: the owner stopped API, the stall watch cut Web.
    yield* runRow({
      threadId: laneThread,
      ordinal: 1,
      status: "interrupted",
      completedAt: plus(RESTART + 120),
    });
    yield* itemRow(`${laneThread}-run-1`, laneThread, 1, "run_interrupt_request", "completed", {
      message: "Interrupt requested",
    });
    yield* runRow({
      threadId: webThread,
      ordinal: 1,
      status: "interrupted",
      completedAt: plus(RESTART + 130),
    });
    yield* itemRow(`${webThread}-run-1`, webThread, 1, "command_execution", "running", {
      input: "vp test run src/a.test.ts",
    });
    yield* itemRow(`${webThread}-run-1`, webThread, 2, "run_interrupt_request", "completed", {
      message: "stall watch: no output for 20 minutes",
    });
    yield* TestClock.setTime(T0 + (RESTART + 600) * 1000);

    const incident = yield* recovery.scan;
    assert.deepStrictEqual(threadsOf(incident), [
      { threadId: webThread, position: 0, action: "resume", reason: "turn cut" },
      { threadId: laneThread, position: 1, action: "skip", reason: "stopped by the owner" },
    ]);
    assert.strictEqual(incident?.cause, "run-interrupted");
    // One lane on its own: no master summary, no owner FYI.
    const missions = yield* MissionService.MissionService;
    assert.deepStrictEqual((yield* missions.inbox(missionId)).fyi, []);

    assert.strictEqual(yield* recovery.tick, 1);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [webThread],
    );
    assert.strictEqual(
      fake.sent[0]?.text,
      "[mission recovery] Your run was interrupted at 09:02 (stall watch: no output for 20 minutes). Your turn was cut while you were running `vp test run src/a.test.ts`. You had no background children. Then continue your work.",
    );
    // The same runs are not reported twice.
    assert.isNull(yield* recovery.scan);
  }).pipe(Effect.provide(layer));
});

it.effect("a paused mission gets notices about lost children but no resume", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* restartWorld([lane], { mission: { ...mission, status: "paused" } });
    yield* cutRun(laneThread, 1, "offbox wait run-42");
    yield* childRow({
      id: "task-1",
      threadId: laneThread,
      runId: `${laneThread}-run-1`,
      status: "running",
      title: "Harness sweep",
      completedAt: null,
      delegated: true,
    });
    const incident = yield* boot;
    assert.deepStrictEqual(threadsOf(incident), [
      { threadId: masterThread, position: 0, action: "notice-only", reason: "mission paused" },
      { threadId: laneThread, position: 1, action: "notice-only", reason: "mission paused" },
    ]);
    const recovery = yield* RecoveryService.RecoveryService;
    yield* recovery.tick;
    yield* TestClock.adjust("61 seconds");
    yield* recovery.tick;
    assert.strictEqual(
      fake.sent[1]?.text,
      "[mission recovery] Robob restarted at 09:00. Your turn was cut while you were running `offbox wait run-42`. You had 1 background child: `Harness sweep` (delegated task task-1, may still be running). When you are released, resume each one: delegated tasks by checking task_status (leave a running one alone, re-delegate a stopped one with the same brief). Your work stays as it is (mission paused): do not restart it now.",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a hold whose lease ran out during the outage means reconcile first", () => {
  const { fake, layer } = harness();
  const hold: PoolHold = {
    id: PoolHoldId.make("hold-1"),
    poolId: PoolId.make("pool-dev-deploy"),
    missionId,
    holder: { _tag: "lane", laneId: lane.id },
    amount: 1,
    purpose: "dev deploy",
    fence: 1,
    status: "active",
    leaseExpiresAt: plus(RESTART - 60),
    takenAt: plus(RESTART - 900),
    releasedAt: null,
    releaseNote: null,
    createdAt: plus(RESTART - 900),
  };
  return Effect.gen(function* () {
    yield* restartWorld([lane], { extra: [{ _tag: "pool-hold", record: hold }] });
    yield* cutRun(laneThread, 1, "./deploy.zsh dev");
    const incident = yield* boot;
    assert.deepStrictEqual(threadsOf(incident), [
      {
        threadId: masterThread,
        position: 0,
        action: "notice-only",
        reason: "summary for the master",
      },
      {
        threadId: laneThread,
        position: 1,
        action: "reconcile-first",
        reason: "cut inside a deploy (`./deploy.zsh dev`)",
      },
    ]);
    assert.deepStrictEqual(incident?.threads[1]?.holds, [
      {
        holdId: hold.id,
        poolId: hold.poolId,
        purpose: "dev deploy",
        status: "active",
        leaseExpiresAt: hold.leaseExpiresAt,
        reconcileRequired: true,
      },
    ]);
    const missions = yield* MissionService.MissionService;
    assert.strictEqual((yield* missions.overview(missionId)).recovery?.reconcile, 1);
    assert.strictEqual((yield* missions.inbox(missionId)).fyi[0]?.severity, "high");

    const recovery = yield* RecoveryService.RecoveryService;
    yield* recovery.tick;
    assert.include(
      fake.sent[0]?.text ?? "",
      'Pool holds now reconcile-required: hold-1 (lane "API" ("Lane API", t-lane)).',
    );
    yield* TestClock.adjust("61 seconds");
    yield* recovery.tick;
    assert.strictEqual(
      fake.sent[1]?.text,
      "[mission recovery] Robob restarted at 09:00. Your turn was cut while you were running `./deploy.zsh dev`. You had no background children. Before anything else, check the exact state of what was in flight. You were inside a deploy (`./deploy.zsh dev`). You hold pool pool-dev-deploy hold hold-1 (dev deploy, lease ran out, now reconcile-required). Do not repeat it blindly: read back whether it happened, then finish it or roll forward. Then continue your work.",
    );
  }).pipe(Effect.provide(layer));
});

it.effect("boot flips policy holds whose lease ran out before planning the resume", () => {
  const { layer } = harness({ withPolicy: true });
  return Effect.gen(function* () {
    yield* TestClock.setTime(T0 + (RESTART - 900) * 1000);
    yield* world({ lanes: [lane] });
    const policy = yield* PolicyService.PolicyService;
    const pool = yield* policy.createPool(ownerApp, {
      poolId: PoolId.make("pool-dev-deploy"),
      name: "Dev deploy",
      unit: "slot",
      capacity: 1,
      scope: { _tag: "mission", missionId },
      kind: "lease",
      backend: "native",
    });
    const taken = yield* policy.takeHold(agent(laneThread), {
      poolId: PoolId.make(pool.ref.id),
      missionId,
      purpose: "dev deploy",
      ttlSeconds: 600,
    });
    yield* TestClock.setTime(T0 + RESTART * 1000);
    yield* previousBoot(plus(RESTART - 120));
    yield* cutRun(laneThread, 1, "./deploy.zsh dev");

    const incident = yield* boot;
    const holdOf = (snapshot: typeof incident) =>
      snapshot?.threads.find((thread) => thread.threadId === laneThread)?.holds[0];
    assert.strictEqual(holdOf(incident)?.status, "reconcile-required");
    assert.isTrue(holdOf(incident)?.reconcileRequired);
    const view = yield* policy.pools({ missionId });
    assert.strictEqual(view.pools[0]?.holds[0]?.id, taken.hold.id);
    assert.strictEqual(view.pools[0]?.holds[0]?.status, "reconcile-required");
    const missions = yield* MissionService.MissionService;
    const kinds = (yield* missions.eventsSince(missionId, 0)).map((event) => event.kind);
    assert.isBelow(kinds.indexOf("pool.hold-expired"), kinds.indexOf("recovery.incident-opened"));
    assert.isAtLeast(kinds.indexOf("pool.hold-expired"), 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a failing hold expiry never costs the boot incident or later scans", () => {
  const { layer } = harness({
    policy: Layer.mock(PolicyService.PolicyService)({
      expireHolds: Effect.die(new Error("policy store is gone")),
    }),
  });
  return Effect.gen(function* () {
    yield* restartWorld([lane]);
    yield* cutRun(laneThread, 1, "vp test run");
    const incident = yield* boot;
    assert.deepStrictEqual(
      threadsOf(incident).find((thread) => thread.threadId === laneThread)?.action,
      "resume",
    );
    // Scans run once the boot was checked, failure or not.
    yield* runRow({
      threadId: laneThread,
      ordinal: 2,
      status: "failed",
      completedAt: plus(RESTART + 120),
    });
    yield* TestClock.setTime(T0 + (RESTART + 600) * 1000);
    const recovery = yield* RecoveryService.RecoveryService;
    assert.strictEqual((yield* recovery.scan)?.cause, "run-interrupted");
  }).pipe(Effect.provide(layer));
});

it.effect("resumes follow sub-mission order at the mission's pace and skip busy threads", () => {
  const { fake, layer } = harness();
  const laneIn = (name: string, sub: string): Lane => ({
    ...webLane,
    id: webLane.id.replace("web", name) as Lane["id"],
    name,
    subMissionId: subMission(sub, 0).id,
    threadId: ThreadId.make(`t-${name}`),
  });
  const lanes = [
    laneIn("a1", "sm-a"),
    laneIn("a2", "sm-a"),
    laneIn("b1", "sm-b"),
    laneIn("b2", "sm-b"),
  ];
  return Effect.gen(function* () {
    yield* restartWorld(lanes, {
      extra: [
        { _tag: "sub-mission", record: subMission("sm-a", 1) },
        { _tag: "sub-mission", record: subMission("sm-b", 0) },
      ],
    });
    for (const entry of lanes) yield* cutRun(entry.threadId ?? "", 1, "vp test run");
    const recovery = yield* RecoveryService.RecoveryService;
    yield* recovery.setSettings(ownerApp, { missionId, resumePerMinute: 2, masterLeadSeconds: 0 });
    const incident = yield* boot;
    assert.deepStrictEqual(
      threadsOf(incident).map((thread) => thread.threadId),
      [masterThread, "t-b1", "t-b2", "t-a1", "t-a2"],
    );

    fake.busy.add("t-b2");
    assert.strictEqual(yield* recovery.tick, 3);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread, "t-b1", "t-a1"],
    );
    fake.busy.delete("t-b2");
    yield* TestClock.adjust("30 seconds");
    assert.strictEqual(yield* recovery.tick, 0);
    yield* TestClock.adjust("31 seconds");
    assert.strictEqual(yield* recovery.tick, 2);
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread, "t-b1", "t-a1", "t-b2", "t-a2"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("the master and the owner steer the plan; nobody else can", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* restartWorld([lane, webLane]);
    yield* cutRun(laneThread, 1, "vp test run");
    yield* cutRun(webThread, 1, "vp test run");
    const incident = yield* boot;
    assert.isNotNull(incident);
    const recovery = yield* RecoveryService.RecoveryService;

    const refused = yield* Effect.flip(
      recovery.resume(agent(laneThread), { missionId, mode: "skip", threadId: webThread }),
    );
    assert.instanceOf(refused, MissionError);
    assert.strictEqual(refused.code, "forbidden");

    // The installer resumes threads itself; recovery waits for it.
    fake.installer = true;
    assert.strictEqual(yield* recovery.tick, 0);
    fake.installer = false;
    assert.strictEqual(yield* recovery.tick, 1);

    yield* recovery.resume(agent(masterThread), { missionId, mode: "hold", threadId: laneThread });
    yield* recovery.resume(agent(masterThread), {
      missionId,
      mode: "now",
      threadId: webThread,
      instruction: "Rebase on main before the tests.",
    });
    assert.deepStrictEqual(
      fake.sent.map((sent) => sent.threadId),
      [masterThread, webThread],
    );
    assert.include(
      fake.sent[1]?.text ?? "",
      "From the master: Rebase on main before the tests. Then continue",
    );

    yield* TestClock.adjust("2 minutes");
    assert.strictEqual(yield* recovery.tick, 0);
    const status = yield* recovery.resume(ownerApp, { missionId, mode: "release" });
    assert.strictEqual(
      status.incident?.threads.find((thread) => thread.threadId === laneThread)?.state,
      "pending",
    );
    assert.strictEqual(yield* recovery.tick, 1);
    assert.strictEqual(fake.sent.at(-1)?.threadId, laneThread);
    assert.isNull((yield* recovery.status(missionId)).state);
  }).pipe(Effect.provide(layer));
});

it.effect("recovery records the deciding principal, never the claimed thread", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* restartWorld([lane, webLane]);
    yield* cutRun(laneThread, 1, "vp test run");
    yield* cutRun(webThread, 1, "vp test run");
    assert.isNotNull(yield* boot);
    const recovery = yield* RecoveryService.RecoveryService;
    const store = yield* MissionStore.MissionStore;

    const status = yield* recovery.resume(agent(masterThread), {
      missionId,
      mode: "hold",
      threadId: webThread,
      instruction: "Rebase first.",
    });
    const held = status.incident?.threads.find((thread) => thread.threadId === webThread);
    // The master acts as its role, as asks and policy record it.
    assert.deepStrictEqual(held?.decidedBy, { _tag: "role", roleId: RoleId.make("role-master") });
    assert.deepStrictEqual(held?.instructionBy, {
      _tag: "role",
      roleId: RoleId.make("role-master"),
    });
    yield* recovery.setSettings(ownerApp, { missionId, resumePerMinute: 6 });
    const events = (yield* store.eventsSince(missionId, 0)).filter(
      (event) => event.kind.startsWith("recovery.") && event.kind !== "recovery.incident-opened",
    );
    assert.deepStrictEqual(
      events.map((event) => [event.kind, event.actor, event.provenance]),
      [
        [
          "recovery.thread-decided",
          { _tag: "role", roleId: RoleId.make("role-master") },
          { _tag: "agent", threadId: masterThread, roleId: RoleId.make("role-master") },
        ],
        ["recovery.settings-changed", { _tag: "owner" }, ownerApp],
      ],
    );

    // The owner sends it on; the instruction stays the master's.
    yield* recovery.resume(ownerApp, { missionId, mode: "now", threadId: webThread });
    assert.include(fake.sent.at(-1)?.text ?? "", "From the master: Rebase first.");

    // A restart report is a component's finding; nothing else is relabelled as one.
    const report = {
      reportId: "rs-x",
      cause: "opencode-restart" as const,
      startAt: plus(RESTART),
      endAt: plus(RESTART + 10),
      threads: [{ threadId: laneThread, runIds: [], childIds: [] }],
    };
    for (const caller of [ownerApp, agent(masterThread)]) {
      const refused = yield* Effect.flip(recovery.report(caller, report));
      assert.strictEqual(refused.code, "provenance-invalid");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("a role handoff tells the new holder about the old thread's children", () => {
  const { fake, layer } = harness();
  const oldThread = ThreadId.make("t-api-old");
  const newThread = ThreadId.make("t-api-new");
  return Effect.gen(function* () {
    yield* TestClock.setTime(T0 + 600 * 1000);
    yield* world({
      lanes: [lane],
      extra: [
        { _tag: "role", record: role("role-api", "lane-lead", lane.id) },
        {
          _tag: "role-binding",
          record: handoff("b-api-old", "role-api", oldThread, { endedAt: plus(590) }),
        },
      ],
    });
    yield* threadRow(oldThread, "API lead (old)");
    yield* threadRow(newThread, "API lead");
    yield* runRow({ threadId: oldThread, ordinal: 1, status: "completed", completedAt: plus(580) });
    yield* childRow({
      id: "sub-x",
      threadId: oldThread,
      runId: `${oldThread}-run-1`,
      status: "running",
      title: "Fix CRP-9 review findings",
      completedAt: null,
      session: "ses_x9",
    });
    const next = handoff("b-api-new", "role-api", newThread, {
      reason: "succession",
      boundAt: plus(590),
    });
    const store = yield* MissionStore.MissionStore;
    yield* store.upsert(
      { _tag: "role-binding", record: next },
      {
        missionId,
        kind: "role.succession",
        actor: { _tag: "system", component: "test" },
        provenance: test,
        summary: "handoff",
        subject: null,
      },
    );
    const recovery = yield* RecoveryService.RecoveryService;
    const incident = yield* recovery.onSuccession(next, missionId);
    assert.deepStrictEqual(threadsOf(incident), [
      {
        threadId: newThread,
        position: 0,
        action: "resume",
        reason: "took over from API lead (old)",
      },
    ]);
    assert.isNull(yield* recovery.onSuccession(next, missionId));
    assert.strictEqual(yield* recovery.tick, 1);
    assert.strictEqual(
      fake.sent[0]?.text,
      '[mission recovery] You took over lane "API" at 08:09 from thread "API lead (old)" (t-api-old). The old thread had 1 background child: `Fix CRP-9 review findings` (native subagent, session ses_x9). They will not report back to you. Adopt each one if the work still matters: native subagents by passing the session id back to the subagent tool with a short prompt (keeps their context). Then continue your work.',
    );
  }).pipe(Effect.provide(layer));
});

it.effect("stream-recovery reports name mission members and land in one incident", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* restartWorld([lane]);
    assert.isNull(yield* boot);
    const recovery = yield* RecoveryService.RecoveryService;
    // OpenCode restarts at 09:05 while Robob stays up.
    yield* cutRun(laneThread, 1, "vp test run", plus(RESTART + 300));
    yield* TestClock.setTime(T0 + (RESTART + 400) * 1000);
    const input = {
      reportId: "rs-20261017T090500Z",
      cause: "opencode-restart" as const,
      startAt: plus(RESTART + 290),
      endAt: plus(RESTART + 310),
      threads: [
        { threadId: laneThread, runIds: [`${laneThread}-run-1`], childIds: [] },
        { threadId: ThreadId.make("t-elsewhere"), runIds: [], childIds: [] },
      ],
    };
    const dry = yield* recovery.report(test, { ...input, dryRun: true });
    assert.deepStrictEqual(dry, {
      incidentId: null,
      members: [{ threadId: laneThread, missionIds: [missionId] }],
      missions: [],
    });
    const first = yield* recovery.report(test, input);
    assert.strictEqual(first.incidentId, "rcv-rs-20261017T090500Z");
    assert.deepStrictEqual(first.missions, [
      { missionId, title: "Mission one", threads: 2, resume: 1, reconcile: 0, noticeOnly: 1 },
    ]);
    const again = yield* recovery.report(test, input);
    assert.strictEqual(again.incidentId, first.incidentId);
    // The scan sees the same run later and leaves it to the report's incident.
    yield* TestClock.adjust("10 minutes");
    assert.isNull(yield* recovery.scan);
    const status = yield* recovery.status(missionId);
    assert.strictEqual(status.state?.label, "Recovered from OpenCode restart at 09:05");
  }).pipe(Effect.provide(layer));
});
