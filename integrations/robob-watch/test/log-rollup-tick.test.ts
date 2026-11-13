import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previousDayRollup } from "../src/runner.ts";
const dir = mkdtempSync(join(tmpdir(), "rollup-tick-"));
const previous = process.env.TOOLLOG_DIR;
afterEach(() => { setSystemTime(); if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
test("first tick after 00:05 launches yesterday's rollup outside the runner only once", () => {
  process.env.TOOLLOG_DIR = dir;
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({ exited: Promise.resolve(0) }) as ReturnType<typeof Bun.spawn>);
  try {
    setSystemTime(new Date("2026-10-24T00:04:59Z")); previousDayRollup(); expect(spawn).not.toHaveBeenCalled();
    setSystemTime(new Date("2026-10-24T00:05:00Z")); previousDayRollup();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toEqual([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", "--day", "2026-10-23"]);
    previousDayRollup(); expect(spawn).toHaveBeenCalledTimes(1);
    setSystemTime(new Date("2026-10-25T00:05:00Z")); previousDayRollup(); expect(spawn).toHaveBeenCalledTimes(2);
  } finally { spawn.mockRestore(); }
});
