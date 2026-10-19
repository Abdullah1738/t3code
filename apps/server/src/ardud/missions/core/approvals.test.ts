import {
  ApprovalId,
  LaneId,
  SubMissionId,
  WorkItemId,
  type MissionProvenance,
  type OpenApprovalInput,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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
import * as MissionService from "../MissionService.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { repositoryOf, routeApprover } from "./approvals.ts";

const crw: MissionProvenance = { _tag: "system", component: "crw" };
const master = agent(masterThread);
const laneAgent = agent(laneThread);

const crwApproval = (pr: string, head: string, repo = "acme/api"): OpenApprovalInput => ({
  missionId,
  approvalId: ApprovalId.make(`m-1:approval:crw:${repo}#${pr}@${head}`),
  kind: "merge",
  title: `Good to merge: ${repo}#${pr}`,
  detail: `Decide in the review thread (head ${head}).`,
  requestedBy: "crw",
  links: [
    {
      kind: "pull-request",
      label: `${repo}#${pr}`,
      url: `https://github.com/${repo}/pull/${pr}`,
      ref: head,
    },
  ],
});

describe("approval routing", () => {
  it("first matching row wins and everything else goes to the owner", () => {
    const routes = [
      {
        id: "docs",
        match: { _tag: "approval" as const, repository: "acme/docs" },
        approver: "master" as const,
      },
      {
        id: "email",
        match: { _tag: "draft" as const, channel: "email" as const },
        approver: "master" as const,
      },
      {
        id: "any-merge",
        match: { _tag: "approval" as const, kind: "merge" as const },
        approver: "owner" as const,
      },
    ];
    assert.deepStrictEqual(
      routeApprover(routes, { _tag: "approval", kind: "merge", repository: "Acme/Docs" }),
      { approver: "master", routeId: "docs" },
    );
    assert.deepStrictEqual(
      routeApprover(routes, { _tag: "approval", kind: "merge", repository: "acme/api" }),
      { approver: "owner", routeId: "any-merge" },
    );
    assert.deepStrictEqual(
      routeApprover(routes, { _tag: "draft", channel: "email", audience: "Bank", person: null }),
      { approver: "master", routeId: "email" },
    );
    assert.deepStrictEqual(
      routeApprover(undefined, { _tag: "approval", kind: "deploy", repository: null }),
      { approver: "owner", routeId: null },
    );
    assert.equal(
      repositoryOf([
        { kind: "url", label: "x", url: "https://github.com/acme/web/pull/3", ref: null },
      ]),
      null,
    );
    assert.equal(
      repositoryOf([
        { kind: "pull-request", label: "PR", url: "https://github.com/acme/web/pull/3", ref: null },
      ]),
      "acme/web",
    );
  });
});

describe("approvals", () => {
  it.effect("owner-routed approvals wait for the owner; stale never counts", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const missions = yield* MissionService.MissionService;
      const first = crwApproval("7", "aaaaaaaaaaaa");
      yield* missions.openApproval(crw, first);

      // Only the requester opens in its own name; nobody else decides an owner-routed one.
      assert.equal(
        yield* failureCode(missions.openApproval(crw, { ...first, requestedBy: "governor" })),
        "forbidden",
      );
      assert.equal(
        yield* failureCode(
          missions.decideApproval(master, { approvalId: first.approvalId, action: "approve" }),
        ),
        "provenance-required",
      );
      const inbox = yield* missions.inbox(missionId);
      assert.deepStrictEqual(
        inbox.approvals.map((approval) => approval.id),
        [first.approvalId],
      );

      // The head moves: crw closes the old record as stale and opens one for the new head.
      yield* missions.closeStaleApproval(crw, {
        missionId,
        approvalId: first.approvalId,
        reason: "head moved to bbbbbbbbbbbb",
      });
      const second = crwApproval("7", "bbbbbbbbbbbb");
      yield* missions.openApproval(crw, second);
      assert.equal(
        yield* failureCode(
          missions.decideApproval(ownerApp, { approvalId: first.approvalId, action: "approve" }),
        ),
        "conflict",
      );
      yield* missions.decideApproval(ownerApp, {
        approvalId: second.approvalId,
        action: "approve",
        note: "Ship it",
      });
      const [older, newer] = yield* missions
        .approvals({
          missionId,
          ids: [first.approvalId, second.approvalId],
        })
        .pipe(
          Effect.map((list) => [
            list.find((approval) => approval.id === first.approvalId),
            list.find((approval) => approval.id === second.approvalId),
          ]),
        );
      assert.equal(older?.status, "stale-closed");
      assert.isNull(older?.decidedBy ?? null);
      assert.equal(newer?.status, "approved");
      assert.deepStrictEqual(newer?.decidedBy, ownerApp);
      assert.equal(newer?.decisionNote, "Ship it");

      // A decided approval cannot be decided again or closed as stale.
      assert.equal(
        yield* failureCode(
          missions.decideApproval(ownerApp, { approvalId: second.approvalId, action: "reject" }),
        ),
        "conflict",
      );
      assert.equal(
        yield* failureCode(
          missions.closeStaleApproval(crw, {
            missionId,
            approvalId: second.approvalId,
            reason: "late",
          }),
        ),
        "conflict",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("the owner and master set routing; the routed approver decides", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const missions = yield* MissionService.MissionService;

      // Only the owner or the master edits the routing table.
      const routes = [
        {
          id: "docs",
          match: { _tag: "approval" as const, repository: "acme/docs" },
          approver: "master" as const,
        },
      ];
      assert.equal(
        yield* failureCode(missions.setApprovalRouting(laneAgent, { missionId, routes })),
        "forbidden",
      );
      const routed = yield* missions.setApprovalRouting(master, {
        missionId,
        routes,
        reason: "Docs PRs are the master's call",
      });

      const docs = crwApproval("3", "cccccccccccc", "acme/docs");
      const api = crwApproval("8", "dddddddddddd");
      yield* missions.openApproval(crw, docs);
      yield* missions.openApproval(crw, api);
      const [docsRecord] = yield* missions.approvals({ missionId, ids: [docs.approvalId] });
      assert.equal(docsRecord?.approver, "master");

      // The owner's inbox holds only owner-routed approvals.
      const inbox = yield* missions.inbox(missionId);
      assert.deepStrictEqual(
        inbox.approvals.map((approval) => approval.id),
        [api.approvalId],
      );

      // The master decides its own; a lane agent cannot.
      assert.equal(
        yield* failureCode(
          missions.decideApproval(laneAgent, { approvalId: docs.approvalId, action: "approve" }),
        ),
        "forbidden",
      );
      yield* missions.decideApproval(master, { approvalId: docs.approvalId, action: "approve" });

      // The master re-routes the api approval to itself with a reason, then decides it.
      yield* missions.routeApproval(master, {
        approvalId: api.approvalId,
        approver: "master",
        reason: "Owner said trivial bumps are mine",
      });
      yield* missions.decideApproval(master, { approvalId: api.approvalId, action: "reject" });

      // The owner can always decide, whoever it is routed to.
      const late = crwApproval("4", "eeeeeeeeeeee", "acme/docs");
      yield* missions.openApproval(crw, late);
      yield* missions.decideApproval(ownerApp, { approvalId: late.approvalId, action: "approve" });

      const events = yield* missions.eventsSince(missionId, routed.seq - 1);
      assert.deepStrictEqual(
        events.map((event) => [event.kind, event.actor._tag]),
        [
          ["approval-routing.updated", "thread"],
          ["approval.opened", "system"],
          ["approval.opened", "system"],
          ["approval.decided", "thread"],
          ["approval.routed", "thread"],
          ["approval.decided", "thread"],
          ["approval.opened", "system"],
          ["approval.decided", "owner"],
        ],
      );
    }).pipe(Effect.provide(layer));
  });
});

describe("routing by sub-mission and work item", () => {
  it("rows match the work the approval or draft is about", () => {
    const routes = [
      {
        id: "item",
        match: { _tag: "approval" as const, workItemId: WorkItemId.make("wi-1") },
        approver: "owner" as const,
      },
      {
        id: "wave",
        match: { _tag: "approval" as const, subMissionId: SubMissionId.make("sm-wave") },
        approver: "master" as const,
      },
      {
        id: "wave-drafts",
        match: {
          _tag: "draft" as const,
          channel: "email" as const,
          subMissionId: SubMissionId.make("sm-wave"),
        },
        approver: "master" as const,
      },
    ];
    const approval = { _tag: "approval" as const, kind: "merge" as const, repository: null };
    assert.deepStrictEqual(
      routeApprover(routes, { ...approval, subMissionId: "sm-wave", workItemId: "wi-1" }),
      { approver: "owner", routeId: "item" },
    );
    assert.deepStrictEqual(
      routeApprover(routes, { ...approval, subMissionId: "sm-wave", workItemId: "wi-2" }),
      { approver: "master", routeId: "wave" },
    );
    // No known work never matches a row that names work.
    assert.deepStrictEqual(routeApprover(routes, approval), { approver: "owner", routeId: null });
    const draft = { _tag: "draft" as const, channel: "email" as const, audience: "Bank" };
    assert.deepStrictEqual(
      routeApprover(routes, { ...draft, person: null, subMissionId: "sm-wave" }),
      { approver: "master", routeId: "wave-drafts" },
    );
    assert.deepStrictEqual(routeApprover(routes, { ...draft, person: null }), {
      approver: "owner",
      routeId: null,
    });
  });

  it.effect("the master takes a whole sub-mission's approvals; the owner still decides any", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const missions = yield* MissionService.MissionService;
      const wave = SubMissionId.make(
        (yield* missions.upsertSubMission(master, { missionId, title: "Architecture wave" })).ref
          .id,
      );
      const other = SubMissionId.make(
        (yield* missions.upsertSubMission(master, { missionId, title: "Billing" })).ref.id,
      );
      const onPr = (id: string, subMissionId: SubMissionId, number: number) =>
        missions.upsertWorkItem(master, {
          missionId,
          workItemId: WorkItemId.make(id),
          subMissionId,
          title: `PR ${number}`,
          kind: "pr",
          pullRequest: { repository: "acme/api", number },
        });
      yield* onPr("wi-wave-1", wave, 11);
      yield* onPr("wi-wave-2", wave, 12);
      yield* onPr("wi-billing", other, 13);

      // Rows must name work in this mission.
      assert.equal(
        yield* failureCode(
          missions.setApprovalRouting(master, {
            missionId,
            routes: [
              {
                id: "ghost",
                match: { _tag: "approval", subMissionId: SubMissionId.make("sm-ghost") },
                approver: "master",
              },
            ],
          }),
        ),
        "invalid",
      );
      assert.equal(
        yield* failureCode(
          missions.setApprovalRouting(master, {
            missionId,
            routes: [
              {
                id: "ghost-item",
                match: { _tag: "approval", workItemId: WorkItemId.make("wi-ghost") },
                approver: "master",
              },
            ],
          }),
        ),
        "invalid",
      );

      // The owner told the master these are its call; one item stays the owner's.
      const routed = yield* missions.setApprovalRouting(master, {
        missionId,
        routes: [
          {
            id: "keep-12",
            match: { _tag: "approval", workItemId: WorkItemId.make("wi-wave-2") },
            approver: "owner",
          },
          {
            id: "wave",
            match: { _tag: "approval", subMissionId: wave },
            approver: "master",
          },
        ],
        reason: "Owner: I don't need to approve the architecture wave",
      });
      const routingEvent = (yield* missions.eventsSince(missionId, routed.seq - 1))[0];
      assert.equal(routingEvent?.kind, "approval-routing.updated");

      const first = crwApproval("11", "aaaaaaaaaaaa");
      const kept = crwApproval("12", "bbbbbbbbbbbb");
      const billing = crwApproval("13", "cccccccccccc");
      const loose = crwApproval("99", "dddddddddddd");
      for (const input of [first, kept, billing, loose]) {
        yield* missions.openApproval(crw, input);
      }
      const records = yield* missions.approvals({
        missionId,
        ids: [first.approvalId, kept.approvalId, billing.approvalId, loose.approvalId],
      });
      const approverFor = (id: ApprovalId) => records.find((record) => record.id === id)?.approver;
      assert.equal(approverFor(first.approvalId), "master");
      assert.equal(approverFor(kept.approvalId), "owner");
      assert.equal(approverFor(billing.approvalId), "owner");
      assert.equal(approverFor(loose.approvalId), "owner");

      // The opened event says which work and row decided it.
      const opened = (yield* missions.eventsSince(missionId, routed.seq)).find(
        (event) => event.kind === "approval.opened" && event.subject?.id === first.approvalId,
      );
      assert.deepStrictEqual(opened?.payload, {
        approver: "master",
        routeId: "wave",
        subMissionId: wave,
        workItemId: "wi-wave-1",
      });
      // An approval with no known work says so by leaving the fields out.
      const looseOpened = (yield* missions.eventsSince(missionId, routed.seq)).find(
        (event) => event.kind === "approval.opened" && event.subject?.id === loose.approvalId,
      );
      assert.deepStrictEqual(looseOpened?.payload, { approver: "owner", routeId: null });

      // The master decides the wave's approval; the owner can still decide it too.
      yield* missions.decideApproval(master, { approvalId: first.approvalId, action: "approve" });
      assert.equal(
        yield* failureCode(
          missions.decideApproval(master, { approvalId: kept.approvalId, action: "approve" }),
        ),
        "provenance-required",
      );
      yield* missions.decideApproval(ownerApp, { approvalId: kept.approvalId, action: "approve" });
    }).pipe(Effect.provide(layer));
  });
});

describe("master structure controls", () => {
  it.effect("the master splits and merges lanes and merges sub-missions, on the timeline", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      yield* seed;
      const missions = yield* MissionService.MissionService;
      const store = yield* MissionStore.MissionStore;
      const start = yield* store.latestSeq(missionId);
      const subA = SubMissionId.make(
        (yield* missions.upsertSubMission(master, { missionId, title: "Import" })).ref.id,
      );
      const subB = SubMissionId.make(
        (yield* missions.upsertSubMission(master, { missionId, title: "Export" })).ref.id,
      );
      const apiLane = LaneId.make("lane-api");
      yield* missions.upsertLane(master, { missionId, laneId: apiLane, subMissionId: subA });

      // Split wi-free off the API lane into a new lane; unknown items are refused.
      const split = yield* missions.splitLane(master, {
        missionId,
        laneId: apiLane,
        newLaneId: LaneId.make("lane-api-2"),
        name: "API two",
        workItemIds: [WorkItemId.make("wi-free")],
      });
      assert.equal(split.ref.id, "lane-api-2");
      const moved = Option.getOrThrow(yield* store.get("work-item", WorkItemId.make("wi-free")));
      assert.equal(moved.laneId, "lane-api-2");
      assert.equal(moved.subMissionId, subA);
      assert.equal(
        yield* failureCode(
          missions.splitLane(master, {
            missionId,
            laneId: apiLane,
            name: "API three",
            workItemIds: [WorkItemId.make("wi-nope")],
          }),
        ),
        "invalid",
      );

      // Merge it back: its items return and the split lane retires.
      yield* missions.mergeLanes(master, {
        missionId,
        laneId: LaneId.make("lane-api-2"),
        intoLaneId: apiLane,
      });
      const back = Option.getOrThrow(yield* store.get("work-item", WorkItemId.make("wi-free")));
      assert.equal(back.laneId, apiLane);
      const retired = Option.getOrThrow(yield* store.get("lane", LaneId.make("lane-api-2")));
      assert.equal(retired.status, "retired");

      // Merge the Import sub-mission into Export: lanes and items follow, focus moves.
      yield* missions.setMissionFocus(master, { missionId, subMissionId: subA });
      yield* missions.mergeSubMissions(master, {
        missionId,
        subMissionId: subA,
        intoSubMissionId: subB,
      });
      const lane = Option.getOrThrow(yield* store.get("lane", apiLane));
      assert.equal(lane.subMissionId, subB);
      const closed = Option.getOrThrow(yield* store.get("sub-mission", subA));
      assert.equal(closed.status, "closed");
      const mission = Option.getOrThrow(yield* store.get("mission", missionId));
      assert.equal(mission.focusSubMissionId, subB);

      const events = yield* missions.eventsSince(missionId, start);
      assert.deepStrictEqual(
        events.map((event) => event.kind),
        [
          "sub-mission.created",
          "sub-mission.created",
          "lane.moved",
          "lane.split",
          "lane.merged",
          "mission.updated",
          "sub-mission.merged",
        ],
      );
      for (const event of events) {
        assert.deepStrictEqual(event.provenance, master);
        assert.deepStrictEqual(event.actor, { _tag: "thread", threadId: masterThread });
      }
    }).pipe(Effect.provide(layer));
  });
});
