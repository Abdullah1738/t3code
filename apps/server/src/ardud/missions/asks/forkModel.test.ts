import { CallId, ForkId, MissionId, NoteId, RoleId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import {
  archiveFork,
  closeFork,
  markForkCommits,
  openFork,
  openForkFor,
  reopenFork,
} from "./forkModel.ts";
import type { MissionCaller } from "./shared.ts";

const missionId = MissionId.make("m-1");
const masterThreadId = ThreadId.make("t-master");
const forkThreadId = ThreadId.make("t-fork");
const now = "2026-10-17T10:00:00.000Z";

const owner: MissionCaller = {
  provenance: { _tag: "owner-app", surface: "web", sessionId: "s" },
  actors: [{ _tag: "owner" }],
};
const master: MissionCaller = {
  provenance: { _tag: "agent", threadId: masterThreadId, roleId: RoleId.make("role-master") },
  actors: [
    { _tag: "thread", threadId: masterThreadId },
    { _tag: "role", roleId: RoleId.make("role-master") },
  ],
};
const forkThread: MissionCaller = {
  provenance: { _tag: "agent", threadId: forkThreadId, roleId: null },
  actors: [{ _tag: "thread", threadId: forkThreadId }],
};
const stranger: MissionCaller = {
  provenance: { _tag: "agent", threadId: ThreadId.make("t-other"), roleId: null },
  actors: [{ _tag: "thread", threadId: ThreadId.make("t-other") }],
};

const origin = { kind: "call" as const, id: CallId.make("c-1"), label: "Use Postgres" };

const open = (
  caller: MissionCaller,
  kind: "discuss" | "dev-question" | "owner-question" = "discuss",
) =>
  openFork({
    id: ForkId.make("f-1"),
    missionId,
    kind,
    origin,
    caller,
    masterThreadId,
    forkThreadId,
    now,
  });

const code = (result: Result.Result<unknown, { code: string }>) =>
  Result.isFailure(result) ? result.failure.code : "ok";

describe("forks", () => {
  it("only the owner opens Discuss and his own questions; dev questions can come from the master", () => {
    expect(code(open(master))).toBe("provenance-required");
    expect(code(open(master, "owner-question"))).toBe("provenance-required");
    expect(code(open(master, "dev-question"))).toBe("ok");
    const fork = Result.getOrThrow(open(owner)).record;
    expect(fork).toMatchObject({
      status: "open",
      commitsMission: false,
      masterThreadId,
      forkThreadId,
    });
    expect(openForkFor([fork], missionId, "discuss", origin)?.id).toBe("f-1");
    expect(openForkFor([fork], missionId, "dev-question", origin)).toBeUndefined();
  });

  it("closes with one line for the master and does not commit the mission unless the owner says so", () => {
    const fork = Result.getOrThrow(open(owner)).record;
    expect(
      code(
        closeFork({
          fork,
          summaryLine: "  ",
          commitsMission: false,
          caller: forkThread,
          noteId: NoteId.make("n"),
          now,
        }),
      ),
    ).toBe("invalid");
    expect(
      code(
        closeFork({
          fork,
          summaryLine: "x",
          commitsMission: false,
          caller: stranger,
          noteId: NoteId.make("n"),
          now,
        }),
      ),
    ).toBe("forbidden");
    expect(
      code(
        closeFork({
          fork,
          summaryLine: "x",
          commitsMission: true,
          caller: forkThread,
          noteId: NoteId.make("n"),
          now,
        }),
      ),
    ).toBe("provenance-required");

    const closed = Result.getOrThrow(
      closeFork({
        fork,
        summaryLine: "Keep Postgres;\n revisit after load test.",
        commitsMission: false,
        caller: forkThread,
        noteId: NoteId.make("n"),
        now,
      }),
    );
    expect(closed.record.summaryLine).toBe("Keep Postgres; revisit after load test.");
    expect(closed.note).toBeNull();
    expect(closed.delivery).toEqual({
      threadId: masterThreadId,
      text: "[Discussed: Use Postgres] Keep Postgres; revisit after load test.",
      asOwner: false,
      commitsMission: false,
    });

    const committed = Result.getOrThrow(
      markForkCommits({
        fork: closed.record,
        provenance: owner.provenance,
        noteId: NoteId.make("n-2"),
        now,
      }),
    );
    expect(committed.record.commitsMission).toBe(true);
    expect(committed.delivery.text).toContain("This commits the mission");
    expect(committed.note).toMatchObject({ id: "n-2", type: "decision", ackedBy: [] });
    expect(
      code(
        markForkCommits({
          fork: closed.record,
          provenance: master.provenance,
          noteId: NoteId.make("n-3"),
          now,
        }),
      ),
    ).toBe("provenance-required");
  });

  it("owner-closed Discuss forks reach the master as the owner's decision", () => {
    const fork = Result.getOrThrow(open(owner)).record;
    const closed = Result.getOrThrow(
      closeFork({
        fork,
        summaryLine: "Ship it on Friday",
        commitsMission: true,
        caller: owner,
        noteId: NoteId.make("n"),
        now,
      }),
    );
    expect(closed.delivery.asOwner).toBe(true);
    expect(closed.note?.summary).toBe("[Discussed: Use Postgres] Ship it on Friday");
  });

  it("archives answered forks and lets the owner reopen them", () => {
    const fork = Result.getOrThrow(open(owner)).record;
    expect(code(archiveFork(fork, owner.provenance))).toBe("conflict");
    const closed = Result.getOrThrow(
      closeFork({
        fork,
        summaryLine: "done",
        commitsMission: false,
        caller: master,
        noteId: NoteId.make("n"),
        now,
      }),
    ).record;
    const archived = Result.getOrThrow(archiveFork(closed, master.provenance)).record;
    expect(archived.status).toBe("archived");
    expect(code(reopenFork(archived, master.provenance))).toBe("provenance-required");
    expect(Result.getOrThrow(reopenFork(archived, owner.provenance)).record.status).toBe("open");
  });
});
