import {
  MissionEventId,
  MissionId,
  RoleId,
  ThreadId,
  type MissionEvent,
  type MissionEventKind,
  type MissionProvenance,
  type MissionRecordRef,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { buildDirectionCheck, buildFeed } from "./snapshots.ts";

const missionId = MissionId.make("m-import");
const importAt = (minute: number) => `2026-10-19T10:${String(minute).padStart(2, "0")}:00.000Z`;

const coord: MissionProvenance = { _tag: "import", source: "coord.db" };
const policy: MissionProvenance = { _tag: "system", component: "mission-policy" };
const master: MissionProvenance = {
  _tag: "agent",
  threadId: ThreadId.make("t-master"),
  roleId: RoleId.make("role-master"),
};

let seq = 0;
const event = (
  kind: MissionEventKind,
  provenance: MissionProvenance,
  summary: string,
  payload: unknown,
  at: string,
  subject: MissionRecordRef | null = null,
): MissionEvent => {
  seq += 1;
  return {
    id: MissionEventId.make(`event-${seq}`),
    missionId,
    seq,
    kind,
    actor:
      provenance._tag === "agent"
        ? { _tag: "role", roleId: RoleId.make("role-master") }
        : { _tag: "system", component: "test" },
    provenance,
    summary,
    subject,
    causedBy: null,
    payload,
    at,
  };
};

const batch = (kind: string, count: number, minute: number) =>
  event(
    "import.applied",
    coord,
    `Imported ${count} ${kind} records from coord`,
    { kind, count, asOf: importAt(0) },
    importAt(minute),
  );

const keepsModel = (n: number, minute: number) =>
  event(
    "role.model-changed",
    policy,
    `Role ${n}: gpt-6 1 imported holder(s) keep their model`,
    {
      phase: "applied",
      model: "gpt-6",
      applied: [],
      confirmed: [],
      accepted: [`t-${n}`],
      waiting: [],
      finished: false,
    },
    importAt(minute),
    { kind: "role", id: `role-${n}` },
  );

/** The ship import: batches, stale closes and 52 "keep their model" echoes. */
const shipImport = (): Array<MissionEvent> => [
  batch("mission", 1, 1),
  batch("role", 52, 1),
  batch("role-binding", 52, 1),
  batch("lane", 88, 1),
  batch("rule", 110, 1),
  batch("work-item", 261, 2),
  batch("approval", 15, 2),
  ...Array.from({ length: 11 }, (_, index) =>
    event(
      "approval.decided",
      { _tag: "import", source: "crw.db" },
      `Closed as stale: PR ${index}`,
      { status: "stale-closed", staleReason: "head moved" },
      importAt(2),
      { kind: "approval", id: `approval-${index}` },
    ),
  ),
  event(
    "import.applied",
    coord,
    "Imported 5 rooms and 92 subscriptions from coord",
    { kind: "room", rooms: 5, subscriptions: 92, asOf: importAt(0) },
    importAt(3),
  ),
  event(
    "import.applied",
    coord,
    "Imported coord messages 1-12783",
    { kind: "message", count: 12783, fromSeq: 1, toSeq: 12783 },
    importAt(3),
  ),
  ...Array.from({ length: 52 }, (_, index) => keepsModel(index, 4)),
];

describe("since you last looked after a coord import", () => {
  it("shows one feed line per import and nothing to check", () => {
    const events = shipImport();
    const feed = buildFeed({ missionId, events, notes: [], since: null });
    assert.deepStrictEqual(feed, [
      {
        kind: "note",
        summary:
          "Imported from coord: 1 mission, 52 roles, 52 role bindings, 88 lanes, 110 rules, 261 work items, 15 approvals, 5 rooms, 92 subscriptions, 12783 messages, 11 approvals closed as stale, 52 roles keep their imported model",
        ref: { kind: "mission", id: missionId, label: "Coord import" },
        at: importAt(4),
      },
    ]);
    const check = buildDirectionCheck({ missionId, calls: [], events, since: null });
    assert.deepStrictEqual(check, []);
  });

  it("keeps real changes around the import and splits separate imports", () => {
    const decided = event(
      "approval.decided",
      master,
      "Approved: Merge PR 12",
      { action: "approve", approver: "master", note: null },
      importAt(30),
      { kind: "approval", id: "approval-live" },
    );
    const realModelChange = event(
      "role.model-changed",
      master,
      "Writer: gpt-6 set on 1 idle holder(s) for their next turn",
      {
        phase: "applied",
        model: "gpt-6",
        applied: ["t-writer"],
        confirmed: [],
        accepted: [],
        waiting: [],
        finished: true,
      },
      importAt(31),
      { kind: "role", id: "role-writer" },
    );
    const events = [
      batch("lane", 3, 1),
      keepsModel(1, 2),
      decided,
      realModelChange,
      batch("lane", 1, 50),
    ];
    const feed = buildFeed({ missionId, events, notes: [], since: null });
    assert.deepStrictEqual(
      feed.map((item) => [item.kind, item.summary]),
      [
        ["note", "Imported from coord: 1 lane"],
        ["decided", "Approved: Merge PR 12"],
        ["note", "Imported from coord: 3 lanes, 1 role keeps its imported model"],
      ],
    );
    const check = buildDirectionCheck({ missionId, calls: [], events, since: null });
    assert.deepStrictEqual(
      check.map((item) => item.ref.id),
      ["role-writer"],
    );
  });

  it("leaves out imports before the owner last looked", () => {
    const events = [batch("lane", 3, 1), batch("rule", 2, 2)];
    assert.deepStrictEqual(buildFeed({ missionId, events, notes: [], since: importAt(5) }), []);
  });
});
