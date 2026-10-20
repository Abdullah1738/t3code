import { type LaneId, MissionMessage, type RoleId, Room, Subscription } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  actorNames,
  composerState,
  groupRooms,
  listedRoomUnread,
  mergeMessages,
  messageAddressLine,
  messageParties,
  nextReadSeq,
  noiseView,
  olderPageRequest,
  pageUnread,
  pendingRuleOffer,
  postMessageInput,
  receiptView,
  roomListLine,
  roomMembers,
  roomMembersLine,
  roomsSummary,
  roomStats,
  roomTimeline,
  statusRunLine,
  ruleFromCorrection,
  wakesFor,
  INITIAL_ROOM_UI,
  roomUiReducer,
  roomView,
} from "./roomsViewModel.ts";
import { diffWords, parseDiffLines } from "./textDiff.ts";

const MASTER = "crpko-master";
const decodeRoom = Schema.decodeUnknownSync(Room);
const decodeMessage = Schema.decodeUnknownSync(MissionMessage);
const decodeSubscription = Schema.decodeUnknownSync(Subscription);

const room = (id: string, kind: string, lastMessageAt: string | null = null) =>
  decodeRoom({
    id,
    missionId: "m",
    subMissionId: null,
    kind,
    title: id,
    workItemId: null,
    archived: false,
    lastSeq: 0,
    lastMessageAt,
    noise: null,
    createdAt: "2026-10-02T00:00:00.000Z",
  });

const message = (seq: number, kind: string, overrides: Record<string, unknown> = {}) =>
  decodeMessage({
    id: `msg-${seq}`,
    missionId: "m",
    roomId: "r",
    seq,
    kind,
    author: { _tag: "lane", laneId: "lane-cell-risk" },
    provenance: { _tag: "import", source: "coord.db" },
    to: [],
    summary: `message ${seq}`,
    hasBody: false,
    key: null,
    workItemId: null,
    links: [],
    receipt: null,
    isCorrection: false,
    createdAt: "2026-10-17T08:00:00.000Z",
    ...overrides,
  });

describe("room list", () => {
  it("groups sub-mission, work-item and standing rooms with unread totals", () => {
    const groups = groupRooms([
      { room: room("arch", "arch"), unread: 6 },
      { room: room("control", "control"), unread: 3 },
      { room: room("delivery", "sub-mission", "2026-10-17T08:33:00.000Z"), unread: 160 },
      { room: room("crp-12350", "work-item"), unread: 20 },
      { room: room("old", "sub-mission", "2026-10-16T08:33:00.000Z"), unread: 0 },
    ]);
    expect(groups.map((g) => [g.key, g.unread])).toEqual([
      ["sub-mission", 160],
      ["work-item", 20],
      ["standing", 9],
    ]);
    expect(groups[0]?.rooms.map((e) => e.room.id)).toEqual(["delivery", "old"]);
    expect(groups[2]?.rooms.map((e) => e.room.id)).toEqual(["control", "arch"]);
  });

  it("counts unread past the newest page and prefers the list's own count", () => {
    const owner = { author: { _tag: "owner" } };
    // A 50-message page of a 400-message room read up to seq 100: the 250
    // messages between the mark and the page count too, not just the page.
    const busy = {
      messages: Array.from({ length: 50 }, (_, index) => message(351 + index, "status")),
      ownerReadSeq: 100,
      hasOlder: true,
    };
    expect(pageUnread(busy)).toBe(300);
    expect(
      pageUnread({
        messages: [message(4, "status"), message(5, "status", owner), message(6, "status")],
        ownerReadSeq: 4,
        hasOlder: true,
      }),
    ).toBe(1);
    expect(pageUnread({ messages: [], ownerReadSeq: 0, hasOlder: false })).toBe(0);
    expect(listedRoomUnread(room("delivery", "sub-mission"))).toBeNull();
    expect(
      listedRoomUnread({ ...room("delivery", "sub-mission"), unreadForOwner: 7 } as Room),
    ).toBe(7);
  });

  it("reads the noise meter", () => {
    expect(noiseView({ messagesPerHour: 48.8, actionableShare: 0.53, wastedWakes: 588 })).toEqual({
      rate: "49/h",
      actionable: "53% actionable",
      wastedWakes: "588 wasted wakes",
      tone: "busy",
      line: "49/h · 53% actionable · 588 wasted wakes",
    });
    expect(noiseView({ messagesPerHour: 1.4, actionableShare: 0.21, wastedWakes: 18 })?.tone).toBe(
      "noisy",
    );
    expect(noiseView({ messagesPerHour: 0.9, actionableShare: 0.95, wastedWakes: 1 })?.line).toBe(
      "0.9/h · 95% actionable · 1 wasted wake",
    );
    expect(noiseView(null)).toBeNull();
  });
});

describe("room figures", () => {
  const busy = {
    ...room("delivery", "control", "2026-10-19T04:52:00.000Z"),
    noise: { messagesPerHour: 52.61, actionableShare: 0.53, wastedWakes: 9 },
  };

  it("lists a room with its rate and last post, in the reader's zone", () => {
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    expect(roomListLine(busy, now, "UTC")).toBe("52.6 an hour, last 04:52");
    expect(roomListLine(busy, now, "Asia/Dubai")).toBe("52.6 an hour, last 08:52");
    expect(roomListLine(busy, Date.parse("2026-10-21T09:00:00.000Z"), "UTC")).toBe(
      "52.6 an hour, last Mon 19 Oct",
    );
    expect(roomListLine(room("quiet", "custom"), now, "UTC")).toBeNull();
  });

  it("sums the list's message counts and leaves out what the server does not send", () => {
    expect(
      roomsSummary([
        { room: { ...busy, messageCount: 12_000 } as Room, unread: 160 },
        { room: { ...room("arch", "arch"), messageCount: 783 } as Room, unread: 2 },
      ]),
    ).toEqual({ messages: 12_783, rooms: 2, unread: 162 });
    expect(roomsSummary([{ room: busy, unread: 0 }]).messages).toBeNull();
    expect(roomStats(busy.noise, 12_000)).toEqual([
      { label: "Messages", value: "12,000" },
      { label: "Per hour", value: "52.6" },
      { label: "Actionable", value: "53%" },
    ]);
    expect(roomStats(null, null)).toEqual([]);
  });

  it("folds a status run into one line with its span", () => {
    const run = [
      { createdAt: "2026-10-19T04:28:00.000Z" },
      { createdAt: "2026-10-19T04:31:00.000Z" },
      { createdAt: "2026-10-19T04:34:00.000Z" },
    ];
    expect(statusRunLine(run, "UTC")).toBe("3 status updates, 04:28 to 04:34");
    expect(statusRunLine(run.slice(0, 1), "UTC")).toBe("1 status update at 04:28");
  });
});

describe("timeline", () => {
  it("folds status runs, keeps single status inline and places the read marker", () => {
    const rows = roomTimeline(
      [
        message(1, "decision"),
        message(2, "status"),
        message(3, "status"),
        message(4, "request"),
        message(5, "status"),
        message(6, "blocker"),
      ],
      3,
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "status-run",
      "read-marker",
      "message",
      "message",
      "message",
    ]);
    expect(rows.find((row) => row.kind === "read-marker")).toMatchObject({ unread: 3 });
  });

  it("breaks a status run at the read marker and expands runs the owner opened", () => {
    const messages = [message(1, "status"), message(2, "status"), message(3, "status")];
    const rows = roomTimeline(messages, 1, { expandedRuns: new Set(["status:2"]) });
    expect(rows.map((row) => row.kind)).toEqual(["message", "read-marker", "status-run"]);
    expect(rows[2]).toMatchObject({ expanded: true });
  });

  it("does not count the owner's own posts as unread", () => {
    const rows = roomTimeline([message(1, "control", { author: { _tag: "owner" } })], 0);
    expect(rows.some((row) => row.kind === "read-marker")).toBe(false);
  });

  it("adds day rows when given a day function", () => {
    const rows = roomTimeline(
      [
        message(1, "decision", { createdAt: "2026-10-16T23:59:00.000Z" }),
        message(2, "decision", { createdAt: "2026-10-17T00:01:00.000Z" }),
      ],
      2,
      { dayOf: (iso) => iso.slice(0, 10) },
    );
    expect(rows.map((row) => row.key)).toEqual([
      "day:2026-10-16",
      "msg-1",
      "day:2026-10-17",
      "msg-2",
    ]);
  });

  it("merges older pages in seq order and stops at the start", () => {
    const merged = mergeMessages(
      [message(5, "status"), message(6, "status")],
      [message(3, "status"), message(5, "status")],
    );
    expect(merged.map((m) => m.seq)).toEqual([3, 5, 6]);
    expect(olderPageRequest("r" as never, merged, true)).toEqual({
      roomId: "r",
      beforeSeq: 3,
      limit: 40,
    });
    expect(olderPageRequest("r" as never, merged, false)).toBeNull();
  });

  it("only moves the read position forward", () => {
    expect(nextReadSeq(10, 12)).toBe(12);
    expect(nextReadSeq(10, 9)).toBeNull();
    expect(nextReadSeq(10, null)).toBeNull();
  });
});

describe("message details", () => {
  it("shows broadcast receipts and who has not read yet", () => {
    expect(receiptView({ reached: 21, total: 21, pending: [] })).toEqual({
      label: "Reached 21 of 21",
      complete: true,
      pending: null,
    });
    expect(receiptView({ reached: 7, total: 10, pending: ["cell-bal", "cell-fab-tc"] })).toEqual({
      label: "Reached 7 of 10",
      complete: false,
      pending: "waiting on cell-bal, cell-fab-tc",
    });
  });

  it("names author and addressees", () => {
    const fromMaster = message(1, "decision", {
      author: { _tag: "role", roleId: MASTER },
      to: [{ _tag: "lane", laneId: "lane-cell-tc" }],
    });
    expect(messageAddressLine(fromMaster, MASTER)).toBe("master → cell-tc");
    expect(
      messageAddressLine({ author: { _tag: "owner" }, to: [], isCorrection: true }, MASTER),
    ).toBe("you → master (correction)");
  });

  it("shows lane and role names, never their ids", () => {
    const names = {
      "role:crpko:lane-lead:crpko:lane:cell-tc": "cell-tc lead",
      "lane:crpko:lane:cell-risk": "cell-risk",
    };
    const post = {
      author: { _tag: "role" as const, roleId: "crpko:lane-lead:crpko:lane:cell-tc" as RoleId },
      to: [{ _tag: "lane" as const, laneId: "crpko:lane:cell-risk" as LaneId }],
      isCorrection: false,
    };
    expect(messageParties(post, MASTER, names)).toEqual({ from: "cell-tc lead", to: "cell-risk" });
    expect(messageAddressLine(post, MASTER, names)).toBe("cell-tc lead → cell-risk");
    expect(messageParties({ ...post, to: [] }, MASTER, names).to).toBeNull();
    // Lanes and roles from the mission name actors where no room page does.
    expect(
      actorNames(
        [{ id: "crpko:lane:cell-risk" as LaneId, name: "cell-risk" }],
        [{ id: "crpko:lane-lead:crpko:lane:cell-tc" as RoleId, name: "cell-tc lead" }],
      ),
    ).toEqual(names);
  });

  it("lists waking members first and says who a post would wake", () => {
    const sub = (laneId: string, mode: string, wakeOn: string[]) =>
      decodeSubscription({
        id: `sub-${laneId}`,
        roomId: "r",
        subscriber: laneId === "owner" ? { _tag: "owner" } : { _tag: "lane", laneId },
        mode,
        wakeOn,
        createdAt: "2026-10-02T00:00:00.000Z",
      });
    const members = roomMembers(
      [
        sub("owner", "read", []),
        sub("lane-observe", "read", []),
        sub("lane-cell-tc", "wake", ["request", "blocker"]),
        sub("lane-cell-bal", "wake", ["control"]),
      ],
      MASTER,
    );
    expect(members.map((m) => m.label)).toEqual(["cell-bal", "cell-tc", "observe"]);
    expect(wakesFor(members, "status")).toEqual([]);
    expect(wakesFor(members, "request").map((m) => m.label)).toEqual(["cell-tc"]);
    expect(roomMembersLine(members)).toBe("3 members, 2 woken by posts");
  });

  it("counts everyone a wake brought in, not only subscribers", () => {
    // After a wake the page carries no subscription rows, only who is in the room.
    const members = roomMembers([], MASTER, {
      members: [
        { _tag: "lane", laneId: "crpko:lane:cell-tc" as LaneId },
        { _tag: "role", roleId: MASTER as RoleId },
        { _tag: "owner" },
      ],
      names: { "lane:crpko:lane:cell-tc": "cell-tc" },
    });
    expect(members.map((m) => m.label)).toEqual(["cell-tc", "master"]);
    expect(roomMembersLine(members)).toBe("2 members");
    expect(roomMembersLine([])).toBeNull();
  });
});

describe("composer", () => {
  const target = room("r", "control");

  it("posts to the room, one lane, or as a correction to the master", () => {
    expect(postMessageInput(target, { kind: "room" }, " Pause merges ")).toEqual({
      ok: true,
      value: { missionId: "m", roomId: "r", kind: "control", summary: "Pause merges" },
    });
    expect(
      postMessageInput(
        target,
        {
          kind: "lane",
          member: { actor: { _tag: "lane", laneId: "lane-cell-tc" } as never, label: "cell-tc" },
        },
        "Rebase first",
      ),
    ).toMatchObject({
      ok: true,
      value: { kind: "request", to: [{ _tag: "lane", laneId: "lane-cell-tc" }] },
    });
    expect(postMessageInput(target, { kind: "correction" }, "No Friday deploys")).toMatchObject({
      ok: true,
      value: { kind: "control", isCorrection: true },
    });
  });

  it("refuses empty and over-long posts", () => {
    expect(postMessageInput(target, { kind: "room" }, "   ").ok).toBe(false);
    expect(postMessageInput(target, { kind: "room" }, "x".repeat(401)).ok).toBe(false);
    expect(composerState("x".repeat(401))).toEqual({
      remaining: -1,
      overLimit: true,
      canSend: false,
    });
    expect(composerState(" hi ").canSend).toBe(true);
  });

  it("offers the newest unoffered correction as a rule, quoting it verbatim", () => {
    const correction = message(9, "control", {
      author: { _tag: "owner" },
      isCorrection: true,
      summary: "Never deploy on Fridays. Ask me first.",
    });
    const page = { messages: [message(8, "decision"), correction] };
    expect(pendingRuleOffer(page, new Set())?.id).toBe("msg-9");
    expect(pendingRuleOffer(page, new Set(["msg-9"]))).toBeNull();
    expect(ruleFromCorrection("m" as never, correction)).toEqual({
      missionId: "m",
      title: "Never deploy on Fridays",
      quote: "Never deploy on Fridays. Ask me first.",
    });
    expect(ruleFromCorrection("m" as never, message(8, "decision"))).toBeNull();
  });
});

describe("text diff", () => {
  it("round-trips both sides", () => {
    const before = "Hi Dylan, hope your week went well! Please rebase #334.";
    const after = "Please rebase #334 on main-dev.";
    const segments = diffWords(before, after);
    const join = (kinds: string[]) =>
      segments
        .filter((s) => kinds.includes(s.kind))
        .map((s) => s.text)
        .join("");
    expect(join(["same", "removed"])).toBe(before);
    expect(join(["same", "added"])).toBe(after);
  });

  it("reads +/- diff lines", () => {
    expect(parseDiffLines("- sweeps: stopped\n+ sweeps: every 30 min\n")).toEqual([
      { kind: "removed", text: "sweeps: stopped" },
      { kind: "added", text: "sweeps: every 30 min" },
    ]);
  });
});

describe("open room state", () => {
  const page = (messages: ReturnType<typeof message>[], ownerReadSeq: number, hasOlder = true) => ({
    room: room("r", "control"),
    messages,
    hasOlder,
    ownerReadSeq,
  });

  it("pins the read marker to where the owner was when the room opened", () => {
    let state = roomUiReducer(INITIAL_ROOM_UI, { type: "open", roomId: "r" });
    state = roomUiReducer(state, { type: "page", page: page([], 4) });
    expect(state.markerSeq).toBe(4);
    // Marking read moves the live position; the marker stays put.
    state = roomUiReducer(state, { type: "page", page: page([], 9) });
    expect(state.markerSeq).toBe(4);
    const view = roomView(page([message(5, "decision"), message(9, "request")], 9), state);
    expect(view.rows.map((row) => row.kind)).toEqual(["read-marker", "message", "message"]);
    expect(view.markRead).toBeNull();
  });

  it("asks to mark the newest message read once", () => {
    const state = roomUiReducer(INITIAL_ROOM_UI, { type: "open", roomId: "r" });
    expect(roomView(page([message(5, "decision")], 3), state).markRead).toBe(5);
  });

  it("merges older pages and stops when the start is reached", () => {
    let state = roomUiReducer(INITIAL_ROOM_UI, { type: "open", roomId: "r" });
    const live = page([message(10, "decision")], 10);
    expect(roomView(live, state).olderRequest).toEqual({ roomId: "r", beforeSeq: 10, limit: 40 });
    state = roomUiReducer(state, { type: "older-start" });
    expect(roomView(live, state).olderRequest).toBeNull();
    state = roomUiReducer(state, {
      type: "older-done",
      page: { messages: [message(7, "request")], hasOlder: false },
    });
    const view = roomView(live, state);
    expect(view.messages.map((m) => m.seq)).toEqual([7, 10]);
    expect(view.hasOlder).toBe(false);
    expect(view.olderRequest).toBeNull();
  });

  it("resets loaded pages and composer when another room opens, keeping rule offers", () => {
    let state = roomUiReducer(INITIAL_ROOM_UI, { type: "open", roomId: "r" });
    state = roomUiReducer(state, { type: "text", text: "hold the deploy" });
    state = roomUiReducer(state, { type: "rule-offered", messageId: "msg-1" });
    state = roomUiReducer(state, { type: "toggle-run", key: "status:2" });
    state = roomUiReducer(state, { type: "open", roomId: "other" });
    expect(state.text).toBe("");
    expect(state.expandedRuns.size).toBe(0);
    expect(state.offeredRuleIds.has("msg-1")).toBe(true);
  });

  it("clears the composer back to the whole room after sending", () => {
    let state = roomUiReducer(INITIAL_ROOM_UI, { type: "target", target: { kind: "correction" } });
    state = roomUiReducer(state, { type: "text", text: "No Friday deploys." });
    state = roomUiReducer(state, { type: "sent" });
    expect(state).toMatchObject({ text: "", target: { kind: "room" } });
  });
});
