import { MissionId, type MissionEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { watchAddCommand, watchCheckCommand, watchMatches } from "./watch.ts";

const event = (
  seq: number,
  kind: string,
  extra: Partial<Pick<MissionEvent, "actor" | "subject" | "payload">> = {},
): MissionEvent =>
  ({
    id: `e-${seq}`,
    missionId: MissionId.make("m-1"),
    seq,
    kind,
    actor: { _tag: "role", roleId: "role-master" },
    provenance: { _tag: "system", component: "test" },
    summary: kind,
    subject: null,
    causedBy: null,
    payload: {},
    at: "2026-10-19T12:00:00.000Z",
    ...extra,
  }) as MissionEvent;

const request = (id: string) => ({ kind: "owner-request" as const, id });

describe("mission watch kinds for his iMessage agent", () => {
  const events = [
    event(1, "request.replied", {
      subject: request("req-1"),
      payload: { requestId: "req-1", status: "waiting-on-master" },
      actor: { _tag: "owner" },
    }),
    event(2, "request.replied", {
      subject: request("req-1"),
      payload: { requestId: "req-1", status: "answered" },
    }),
    event(3, "request.replied", {
      subject: request("req-2"),
      payload: { requestId: "req-2", status: "waiting-on-master" },
    }),
    event(4, "approval.opened", { subject: { kind: "approval", id: "ap-1" } }),
    event(5, "work-item.updated", {
      subject: { kind: "work-item", id: "wi-1" },
      payload: { changed: ["stage"], stage: "review" },
    }),
    event(6, "work-item.updated", {
      subject: { kind: "work-item", id: "wi-1" },
      payload: { changed: ["stage"], stage: "done" },
    }),
  ] as ReadonlyArray<MissionEvent>;
  const seqs = (matches: ReadonlyArray<MissionEvent>) => matches.map((match) => match.seq);

  it("wakes on the master's replies only, and on one request when asked", () => {
    expect(seqs(watchMatches(events, ["request-replied"]))).toEqual([2, 3]);
    expect(seqs(watchMatches(events, ["request-answered"]))).toEqual([2]);
    expect(seqs(watchMatches(events, ["request-replied"], "req-2"))).toEqual([3]);
  });

  it("wakes on new approvals and finished work items", () => {
    expect(seqs(watchMatches(events, ["approval-opened"]))).toEqual([4]);
    expect(seqs(watchMatches(events, ["work-item-done"], "wi-1"))).toEqual([6]);
    expect(watchMatches(events, ["work-item-done"], "wi-2")).toEqual([]);
  });

  it("puts the record id into the watcher it installs", () => {
    const input = { cli: "mission", missionId: "m-1", kinds: ["request-replied"] as const };
    expect(watchCheckCommand({ ...input, id: "req-1" })).toBe(
      `mission watch-check 'm-1' --on request-replied --id 'req-1' --cursor "$WATCH_DIR/mission-cursor"`,
    );
    expect(watchAddCommand({ ...input, id: "req-1" })).toContain(
      "--id 'mission-m-1-request-replied-req-1'",
    );
    expect(watchCheckCommand(input)).not.toContain("--id");
  });
});
