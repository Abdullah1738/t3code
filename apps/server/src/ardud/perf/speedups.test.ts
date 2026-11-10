import { expect, it } from "@effect/vitest";

import { readSpeedups, SHELL_RESUME_LEGACY_MAX_GAP } from "./speedups.ts";

it("turns every speed-up on when nothing is set", () => {
  expect(readSpeedups({})).toEqual({
    sweepReadsOffWriter: true,
    narrowRunControlReads: true,
    threadReplyLane: true,
    shellResumeMaxGap: 20_000,
    shellResumeMaxThreads: 2_000,
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
    }),
  ).toEqual({
    sweepReadsOffWriter: false,
    narrowRunControlReads: false,
    threadReplyLane: false,
    shellResumeMaxGap: SHELL_RESUME_LEGACY_MAX_GAP,
    shellResumeMaxThreads: 50,
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
