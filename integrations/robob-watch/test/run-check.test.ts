import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inQuiet, normalize, runCheck } from "../src/lib.ts";

const dir = mkdtempSync(join(tmpdir(), "robob-watch-runcheck-"));
const watcher = (check: string) => normalize({ id: "rc", title: "rc", check, mode: "notify", context: "" });

test("a timeout kills the whole process group, including grandchildren", async () => {
  const pidFile = join(dir, "grandchild.pid");
  const result = await runCheck(watcher(`/bin/sleep 30 & print $! > ${pidFile}; wait`), dir, {}, 500);
  expect(result.timedOut).toBe(true);
  expect(result.ms).toBeLessThan(6_000);
  const pid = Number(await Bun.file(pidFile).text());
  await Bun.sleep(200);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("the result never waits on a child that keeps its pipes open after the kill", async () => {
  // A process outside the check's group that inherited stdout keeps the pipe open; runCheck still returns.
  const result = await runCheck(watcher(`/usr/bin/perl -e 'setpgrp; sleep 20' & sleep 30`), dir, {}, 500);
  expect(result.timedOut).toBe(true);
  expect(result.ms).toBeLessThan(7_000);
}, 15_000);

test("quiet hours are validated and wrap past midnight", () => {
  const base = { id: "q", title: "q", check: "true", mode: "notify" as const };
  expect(normalize({ ...base, quiet: { start: 23, end: 8, time_zone: "Asia/Dubai" } }).quiet).toEqual({ start: 23, end: 8, time_zone: "Asia/Dubai" });
  for (const quiet of [{ start: 8, end: 8, time_zone: "UTC" }, { start: 24, end: 1, time_zone: "UTC" }, { start: 1, end: 2, time_zone: "Mars/Base" }, "23-8"])
    expect(() => normalize({ ...base, quiet } as never)).toThrow("quiet must be");
  const at = (h: number) => Date.UTC(2026, 9, 24, h, 30);
  const night = { start: 23, end: 8, time_zone: "UTC" };
  expect([22, 23, 0, 7, 8].map(h => inQuiet(night, at(h)))).toEqual([false, true, true, true, false]);
  // 19:30 UTC is 23:30 in Dubai.
  expect(inQuiet({ start: 23, end: 8, time_zone: "Asia/Dubai" }, at(19))).toBe(true);
  expect(inQuiet({ start: 9, end: 17, time_zone: "UTC" }, at(12))).toBe(true);
  expect(inQuiet(undefined, at(0))).toBe(false);
});
