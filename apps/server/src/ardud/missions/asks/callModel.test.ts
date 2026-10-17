import { CallId, MissionId, RoleId, ThreadId, type MissionProvenance } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { directionCheck, makeCall, reactToCall, type MakeCallCommand } from "./callModel.ts";
import type { MissionCaller } from "./shared.ts";

const masterRole = RoleId.make("role-master");
const masterThread = ThreadId.make("thread-master");
const master: MissionCaller = {
  provenance: { _tag: "agent", threadId: masterThread, roleId: masterRole },
  actors: [{ _tag: "role", roleId: masterRole }],
};
const ownerApp: MissionProvenance = { _tag: "owner-app", surface: "mobile", sessionId: null };

const command = (overrides: Partial<MakeCallCommand> = {}): MakeCallCommand => ({
  id: CallId.make("call-1"),
  missionId: MissionId.make("m1"),
  subMissionId: null,
  caller: master,
  decidedBy: { _tag: "role", roleId: masterRole },
  title: "Split the API lane",
  decision: "Two lanes: read and write paths",
  reason: "Reviews were queueing",
  alternatives: ["Add a worker", ""],
  reversible: true,
  subject: null,
  now: "2026-10-17T10:00:00.000Z",
  ...overrides,
});

const code = (outcome: Result.Result<unknown, { readonly code: string }>) =>
  Result.isFailure(outcome) ? outcome.failure.code : "ok";

describe("calls", () => {
  it("records a master's call without a reaction", () => {
    const outcome = Result.getOrThrow(makeCall(command()));
    expect(outcome.record.ownerReaction).toBeNull();
    expect(outcome.record.alternatives).toEqual(["Add a worker"]);
    expect(outcome.events[0]?.kind).toBe("call.made");
  });

  it("refuses calls from the owner or as an identity the caller lacks", () => {
    expect(code(makeCall(command({ caller: { provenance: ownerApp, actors: [] } })))).toBe(
      "forbidden",
    );
    expect(code(makeCall(command({ decidedBy: { _tag: "role", roleId: RoleId.make("x") } })))).toBe(
      "forbidden",
    );
  });

  it("only the owner reacts, overruling needs a note, and a reaction can be cleared", () => {
    const call = Result.getOrThrow(makeCall(command())).record;
    const base = { call, note: "", now: "2026-10-17T11:00:00.000Z" };
    expect(code(reactToCall({ ...base, reaction: "ok", provenance: master.provenance }))).toBe(
      "provenance-required",
    );
    expect(code(reactToCall({ ...base, reaction: "overruled", provenance: ownerApp }))).toBe(
      "invalid",
    );
    const reacted = Result.getOrThrow(
      reactToCall({ ...base, reaction: "discuss", provenance: ownerApp }),
    );
    expect(reacted.record.ownerReaction).toBe("discuss");
    expect(reacted.events[0]?.payload).toMatchObject({
      reaction: "discuss",
      previousReaction: null,
    });
    const cleared = Result.getOrThrow(
      reactToCall({ ...base, call: reacted.record, reaction: null, provenance: ownerApp }),
    );
    expect(cleared.record.ownerReaction).toBeNull();
  });

  it("direction check lists unreacted calls since the owner last looked, newest first", () => {
    const early = Result.getOrThrow(makeCall(command({ now: "2026-10-17T08:00:00.000Z" }))).record;
    const late = Result.getOrThrow(
      makeCall(command({ id: CallId.make("call-2"), now: "2026-10-17T12:00:00.000Z" })),
    ).record;
    const settled = { ...late, id: CallId.make("call-3"), ownerReaction: "ok" as const };
    expect(directionCheck([early, late, settled], null).map((item) => item.ref.id)).toEqual([
      "call-2",
      "call-1",
    ]);
    expect(
      directionCheck([early, late, settled], "2026-10-17T09:00:00.000Z").map((item) => item.ref.id),
    ).toEqual(["call-2"]);
  });
});
