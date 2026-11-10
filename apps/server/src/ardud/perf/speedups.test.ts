import { expect, it } from "@effect/vitest";

import { readSpeedups, SHELL_RESUME_LEGACY_MAX_GAP } from "./speedups.ts";

it("turns every speed-up on when nothing is set", () => {
  expect(readSpeedups({})).toEqual({
    sweepReadsOffWriter: true,
    narrowRunControlReads: true,
    threadReplyLane: true,
    shellResumeMaxGap: 20_000,
    shellResumeMaxThreads: 2_000,
    shellRecentFirst: true,
    threadsPullRequestIndex: true,
    ingestDedupeForeground: true,
    shellResumeAcrossSessions: true,
  });
  expect(readSpeedups({ ROBOB_SWEEP_READS_ON_WRITER: " ", ROBOB_THREAD_REPLY_LANE: "" })).toEqual(
    readSpeedups({}),
  );
});

it("restores each old behaviour from its documented value", () => {
  expect(
    readSpeedups({
      ROBOB_SWEEP_READS_ON_WRITER: "1",
      ROBOB_RUN_CONTROL_FULL_READS: "true",
      ROBOB_THREAD_REPLY_LANE: "0",
      ROBOB_SHELL_RESUME_MAX_GAP: "1000",
      ROBOB_SHELL_RESUME_MAX_THREADS: "50",
      ROBOB_SHELL_RECENT_FIRST: "off",
      ROBOB_THREADS_PR_INDEX: "0",
      ROBOB_INGEST_DEDUPE_LANE: "background",
      ROBOB_SHELL_KEEP_RESUMABLE: "0",
    }),
  ).toEqual({
    sweepReadsOffWriter: false,
    narrowRunControlReads: false,
    threadReplyLane: false,
    shellResumeMaxGap: SHELL_RESUME_LEGACY_MAX_GAP,
    shellResumeMaxThreads: 50,
    shellRecentFirst: false,
    threadsPullRequestIndex: false,
    ingestDedupeForeground: false,
    shellResumeAcrossSessions: false,
  });
});

it("ignores values that are not the documented ones and clamps counts", () => {
  expect(
    readSpeedups({
      ROBOB_SWEEP_READS_ON_WRITER: "0",
      ROBOB_RUN_CONTROL_FULL_READS: "maybe",
      ROBOB_THREAD_REPLY_LANE: "1",
      ROBOB_SHELL_RESUME_MAX_GAP: "-5",
      ROBOB_SHELL_RESUME_MAX_THREADS: "1e9",
      ROBOB_SHELL_RECENT_FIRST: "1",
      ROBOB_THREADS_PR_INDEX: "yes",
      ROBOB_INGEST_DEDUPE_LANE: "foreground",
    }),
  ).toEqual(readSpeedups({}));
  expect(readSpeedups({ ROBOB_SHELL_RESUME_MAX_GAP: "5" }).shellResumeMaxGap).toBe(
    SHELL_RESUME_LEGACY_MAX_GAP,
  );
  expect(readSpeedups({ ROBOB_SHELL_RESUME_MAX_GAP: "999999999" }).shellResumeMaxGap).toBe(
    2_000_000,
  );
  expect(readSpeedups({ ROBOB_SHELL_RESUME_MAX_THREADS: "0" }).shellResumeMaxThreads).toBe(1);
  expect(readSpeedups({ ROBOB_SHELL_RESUME_MAX_THREADS: "999999" }).shellResumeMaxThreads).toBe(
    20_000,
  );
});
