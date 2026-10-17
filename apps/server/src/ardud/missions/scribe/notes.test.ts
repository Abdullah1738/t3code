import type { Note } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  checkReplaces,
  currentNotes,
  noteChain,
  rankFyi,
  scribeNoteId,
  stableHash,
} from "./notes.ts";

const note = (id: string, overrides: Partial<Note> = {}): Note =>
  ({
    id,
    missionId: "m1",
    subMissionId: null,
    laneId: null,
    type: "risk",
    summary: `note ${id}`,
    sources: [],
    basis: "claimed",
    severity: "medium",
    confidence: 0.5,
    author: "scribe",
    citation: "verified",
    evidence: "not-applicable",
    evidenceLinks: [],
    replacesNoteId: null,
    ackedBy: [],
    createdAt: "2026-10-17T10:00:00.000Z",
    ...overrides,
  }) as Note;

describe("note ids", () => {
  it("are stable and ignore quote whitespace", () => {
    const base = {
      missionId: "m1",
      type: "risk",
      sources: [{ threadId: "t", quote: "a  b\nc", fromEvent: 1, toEvent: 2 }],
    };
    expect(scribeNoteId(base)).toBe(
      scribeNoteId({
        ...base,
        sources: [{ threadId: "t", quote: "a b c", fromEvent: 1, toEvent: 2 }],
      }),
    );
    expect(scribeNoteId(base)).not.toBe(scribeNoteId({ ...base, type: "blocker" }));
    expect(stableHash("")).toBe("cbf29ce484222325");
  });
});

describe("replaces chains", () => {
  const a = note("a");
  const b = note("b", { replacesNoteId: "a" as Note["id"] });
  const c = note("c", { replacesNoteId: "b" as Note["id"] });
  const other = note("x", { missionId: "m2" as Note["missionId"] });
  const byId = new Map([a, b, c, other].map((n) => [n.id as string, n]));

  it("keeps only the newest note of each chain", () => {
    expect(currentNotes([a, b, c, other]).map((n) => n.id)).toEqual(["c", "x"]);
    expect(noteChain("c", [a, b, c]).map((n) => n.id)).toEqual(["c", "b", "a"]);
  });

  it("refuses unknown, cross-mission, self and cyclic replaces", () => {
    expect(checkReplaces({ id: "d", missionId: "m1", replacesNoteId: "c" }, byId)).toBeNull();
    expect(checkReplaces({ id: "d", missionId: "m1", replacesNoteId: "zz" }, byId)).toBe("unknown");
    expect(checkReplaces({ id: "d", missionId: "m1", replacesNoteId: "x" }, byId)).toBe(
      "other-mission",
    );
    expect(checkReplaces({ id: "d", missionId: "m1", replacesNoteId: "d" }, byId)).toBe("self");
    // a replacing c would loop a -> c -> b -> a
    expect(checkReplaces({ id: "a", missionId: "m1", replacesNoteId: "c" }, byId)).toBe("cycle");
  });
});

describe("FYI ranking", () => {
  it("puts owner-must-know first, drops failed, replaced and owner-acked notes", () => {
    const notes = [
      note("low", { severity: "low" }),
      note("crit", { severity: "critical", type: "blocker" }),
      note("omk", { type: "owner-must-know", severity: "low" }),
      note("failed", { severity: "critical", citation: "failed" }),
      note("acked", { severity: "critical", ackedBy: [{ _tag: "owner" }] }),
      note("old", { severity: "critical" }),
      note("new", { severity: "low", replacesNoteId: "old" as Note["id"] }),
      note("watermelon", { type: "claim-of-done", evidence: "mismatch" }),
    ];
    expect(rankFyi(notes, { limit: 10 }).map((n) => n.id)).toEqual([
      "omk",
      "crit",
      "watermelon",
      "low",
      "new",
    ]);
    expect(rankFyi(notes, { limit: 2 }).map((n) => n.id)).toEqual(["omk", "crit"]);
  });

  it("follows the editor's order when it has one", () => {
    const notes = [note("a", { severity: "critical" }), note("b"), note("c")];
    expect(rankFyi(notes, { limit: 10, editorOrder: ["c", "b"] }).map((n) => n.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});
