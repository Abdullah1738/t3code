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
    callerIsMaster: caller === master,
    forkThreadId,
    now,
  });

const code = (result: Result.Result<unknown, { code: string }>) =>
  Result.isFailure(result) ? result.failure.code : "ok";

describe("forks", () => {
  it("M3: the master opens Discuss and dev forks; owner questions stay the owner's", () => {
    expect(code(open(master))).toBe("ok");
    expect(code(open(stranger))).toBe("forbidden");
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

  it("closes with one line for the master and commits the mission only when the owner or master says so", () => {
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
    ).toBe("forbidden");

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

    expect(
      code(
        markForkCommits({
          fork: closed.record,
          provenance: forkThread.provenance,
          callerIsMaster: false,
          noteId: NoteId.make("n-3"),
          now,
        }),
      ),
    ).toBe("forbidden");
    const committed = Result.getOrThrow(
      markForkCommits({
        fork: closed.record,
        provenance: owner.provenance,
        callerIsMaster: false,
        noteId: NoteId.make("n-2"),
        now,
      }),
    );
    expect(committed.record.commitsMission).toBe(true);
    expect(committed.delivery.text).toContain("This commits the mission");
    // M3: the fork thread wrote that summary line, so it never reaches the master as the owner's words.
    expect(committed.delivery.asOwner).toBe(false);
    expect(committed.note).toMatchObject({ id: "n-2", type: "decision", ackedBy: [] });

    // The master can say so too, under its own name and never as the owner.
    const byMaster = Result.getOrThrow(
      markForkCommits({
        fork: closed.record,
        provenance: master.provenance,
        callerIsMaster: true,
        noteId: NoteId.make("n-4"),
        now,
      }),
    );
    expect(byMaster.events[0]?.actor).toEqual({ _tag: "role", roleId: "role-master" });
    expect(byMaster.delivery.asOwner).toBe(false);
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

  it("M3: archives answered forks and lets the owner or the master reopen them", () => {
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
    expect(code(reopenFork(archived, forkThread.provenance, false))).toBe("forbidden");
    expect(Result.getOrThrow(reopenFork(archived, owner.provenance, false)).record.status).toBe(
      "open",
    );
    const reopened = Result.getOrThrow(reopenFork(archived, master.provenance, true));
    expect(reopened.record.status).toBe("open");
    expect(reopened.events[0]?.actor).toEqual({ _tag: "role", roleId: "role-master" });
  });
});
