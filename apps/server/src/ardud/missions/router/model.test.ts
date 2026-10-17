import {
  MissionId,
  RoleId,
  RoomId,
  SubscriptionId,
  ThreadId,
  type MissionActor,
  type Subscription,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  actorKey,
  decideSend,
  doorbellAction,
  noiseFor,
  receiptFor,
  receiptRecipients,
  wakeRequestId,
  wakeTargets,
  type Member,
  type SendSender,
} from "./model.ts";

const mission = MissionId.make("crpko");
const otherMission = MissionId.make("juno");
const master = ThreadId.make("thread-master");
const lane = ThreadId.make("thread-lane");
const outsider = ThreadId.make("thread-outsider");

const member = (threadId: ThreadId, kind: Member["kind"], missionId = mission): Member => ({
  missionId,
  threadId,
  kind,
});

const fromThread = (threadId: ThreadId): SendSender => ({ _tag: "thread", threadId, title: "t" });

const role = (id: string): MissionActor => ({ _tag: "role", roleId: RoleId.make(id) });

const sub = (
  subscriber: MissionActor,
  mode: Subscription["mode"],
  wakeOn: Subscription["wakeOn"] = [],
): Subscription => ({
  id: SubscriptionId.make(`sub-${actorKey(subscriber)}-${mode}`),
  roomId: RoomId.make("room"),
  subscriber,
  mode,
  wakeOn,
  createdAt: "2026-10-17T00:00:00.000Z",
});

describe("decideSend", () => {
  it("leaves threads outside every mission alone", () => {
    expect(
      decideSend({
        target: null,
        sender: null,
        from: fromThread(outsider),
        targetThreadId: lane,
      }),
    ).toEqual({ _tag: "not-member" });
  });

  it("knocks when a non-member thread sends to the master", () => {
    const decision = decideSend({
      target: member(master, "master"),
      sender: null,
      from: fromThread(outsider),
      targetThreadId: master,
    });
    expect(decision).toEqual({ _tag: "knock", missionId: mission, reason: "outsider" });
  });

  it("knocks a member of another mission", () => {
    const decision = decideSend({
      target: member(master, "master"),
      sender: member(outsider, "master", otherMission),
      from: fromThread(outsider),
      targetThreadId: master,
    });
    expect(decision._tag).toBe("knock");
  });

  it("lets owner typing through", () => {
    const decision = decideSend({
      target: member(master, "master"),
      sender: null,
      from: { _tag: "owner", provenance: { _tag: "owner-app", surface: "web", sessionId: "s" } },
      targetThreadId: master,
    });
    expect(decision).toEqual({ _tag: "allow", missionId: mission, reason: "owner" });
  });

  it("routes a member lane's direct send to the master through a room", () => {
    const decision = decideSend({
      target: member(master, "master"),
      sender: member(lane, "created"),
      from: fromThread(lane),
      targetThreadId: master,
    });
    expect(decision).toEqual({
      _tag: "route",
      missionId: mission,
      author: { _tag: "thread", threadId: lane },
      reason: "member",
    });
  });

  it("lets the master reach its own members and a thread reach itself", () => {
    expect(
      decideSend({
        target: member(lane, "created"),
        sender: member(master, "master"),
        from: fromThread(master),
        targetThreadId: lane,
      })._tag,
    ).toBe("allow");
    expect(
      decideSend({
        target: member(lane, "created"),
        sender: member(lane, "created"),
        from: fromThread(lane),
        targetThreadId: lane,
      }),
    ).toEqual({ _tag: "allow", missionId: mission, reason: "self" });
  });

  it("knocks an anonymous control-API session and routes a registered service", () => {
    const session: SendSender = { _tag: "session", sessionId: "s1", subject: "cli-issued-session" };
    expect(
      decideSend({
        target: member(master, "master"),
        sender: null,
        from: session,
        targetThreadId: master,
      }),
    ).toEqual({ _tag: "knock", missionId: mission, reason: "anonymous" });
    expect(
      decideSend({
        target: member(master, "master"),
        sender: { missionId: mission, threadId: ThreadId.make("session:s1"), kind: "service" },
        from: session,
        targetThreadId: master,
      })._tag,
    ).toBe("route");
  });

  it("allows owner-made schedules and knocks MCP clients", () => {
    expect(
      decideSend({
        target: member(master, "master"),
        sender: null,
        from: { _tag: "schedule", scheduledTaskId: "t", title: "tick", createdBy: "user" },
        targetThreadId: master,
      }),
    ).toEqual({ _tag: "allow", missionId: mission, reason: "owner-schedule" });
    expect(
      decideSend({
        target: member(master, "master"),
        sender: null,
        from: { _tag: "mcp-client", sessionId: "c", label: "outside" },
        targetThreadId: master,
      })._tag,
    ).toBe("knock");
  });
});

describe("wakeTargets", () => {
  const author = role("lane-a");
  const subs = [
    sub(role("master"), "wake", ["blocker", "request"]),
    sub(role("lane-b"), "read"),
    sub(role("lane-c"), "mute"),
    sub(author, "wake", ["blocker"]),
  ];

  it("wakes nobody for status", () => {
    expect(
      wakeTargets(
        { kind: "status", to: [role("master")], author },
        { subscriptions: subs, itemWatchers: [] },
      ),
    ).toEqual([]);
  });

  it("wakes the addressed role for a blocker, never the author or owner", () => {
    expect(
      wakeTargets(
        { kind: "blocker", to: [role("lane-b"), author, { _tag: "owner" }], author },
        { subscriptions: subs, itemWatchers: [] },
      ),
    ).toEqual([role("lane-b")]);
  });

  it("wakes subscribers whose wakeOn has the kind when nobody is addressed", () => {
    expect(
      wakeTargets({ kind: "request", to: [], author }, { subscriptions: subs, itemWatchers: [] }),
    ).toEqual([role("master")]);
  });

  it("wakes the item lead and verifier for evidence", () => {
    expect(
      wakeTargets(
        { kind: "evidence", to: [], author },
        { subscriptions: subs, itemWatchers: [role("lead"), role("verifier"), author] },
      ),
    ).toEqual([role("lead"), role("verifier")]);
  });

  it("wakes every non-muted subscriber for a room-wide control", () => {
    expect(
      wakeTargets({ kind: "control", to: [], author }, { subscriptions: subs, itemWatchers: [] }),
    ).toEqual([role("master"), role("lane-b")]);
  });
});

describe("receipts", () => {
  it("counts named recipients whose read position covers the message", () => {
    const recipients = receiptRecipients(
      { kind: "control", to: [role("a"), role("b"), role("c")], author: role("master") },
      [],
    ).map((actor) => ({ actor, label: actor._tag === "role" ? actor.roleId : "?" }));
    const reads: Record<string, number> = { "role:a": 12, "role:b": 9, "role:c": 10 };
    const receipt = receiptFor(10, recipients, (actor) =>
      actor._tag === "role" ? (reads[`role:${actor.roleId}`] ?? 0) : 0,
    );
    expect(receipt).toEqual({ reached: 2, total: 3, pending: ["b"] });
  });

  it("has no receipt for non-controls", () => {
    expect(receiptRecipients({ kind: "request", to: [role("a")], author: role("m") }, [])).toEqual(
      [],
    );
  });
});

describe("doorbellAction", () => {
  const clear = { outstanding: false, rungSeq: 0 };
  const out = { outstanding: true, rungSeq: 5 };
  const unread = [
    { seq: 4, covered: false },
    { seq: 6, covered: false },
  ];

  it("rings an idle or waiting thread with unread deliveries", () => {
    expect(doorbellAction(clear, "idle", unread)).toEqual({ _tag: "ring", upToSeq: 6, unread: 2 });
    expect(doorbellAction(clear, "waiting", unread)._tag).toBe("ring");
  });

  it("never rings a running, queued or blocked thread", () => {
    for (const activity of ["running", "queued", "needs-input", "missing"] as const) {
      expect(doorbellAction(clear, activity, unread)).toEqual({ _tag: "none" });
    }
  });

  it("keeps one outstanding wake and folds new deliveries into a queued one", () => {
    expect(doorbellAction(out, "idle", unread)).toEqual({ _tag: "none" });
    expect(doorbellAction(out, "running", unread)).toEqual({ _tag: "none" });
    expect(doorbellAction(out, "queued", unread)).toEqual({ _tag: "fold", upToSeq: 6 });
  });

  it("does not ring again for deliveries an earlier ring covered", () => {
    expect(
      doorbellAction(clear, "idle", [
        { seq: 4, covered: true },
        { seq: 6, covered: true },
      ]),
    ).toEqual({ _tag: "none" });
  });

  it("uses one request id per thread and newest seq", () => {
    expect(wakeRequestId(mission, lane, 6)).toBe(wakeRequestId(mission, lane, 6));
    expect(wakeRequestId(mission, lane, 6)).not.toBe(wakeRequestId(mission, lane, 7));
  });
});

describe("noiseFor", () => {
  it("measures rate, actionable share and wasted wakes", () => {
    const hour = 3_600_000;
    expect(
      noiseFor({
        now: 10 * hour,
        roomCreatedAt: 0,
        kinds: ["status", "status", "blocker", "request", "status"],
        wastedWakes: 2,
      }),
    ).toEqual({ messagesPerHour: 0.5, actionableShare: 0.4, wastedWakes: 2 });
  });
});
