import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, runCheck } from "../src/lib.ts";

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
