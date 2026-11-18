import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previousDayRollup } from "../src/runner.ts";
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rollup-tick-"));
  dirs.push(dir);
  process.env.TOOLLOG_DIR = dir;
  process.env.ROBOB_WATCH_ROOT = join(dir, "watch-state");
  return dir;
}
const previous = process.env.TOOLLOG_DIR;
const previousRoot = process.env.ROBOB_WATCH_ROOT;
afterEach(() => {
  setSystemTime();
  if (previous === undefined) delete process.env.TOOLLOG_DIR; else process.env.TOOLLOG_DIR = previous;
  if (previousRoot === undefined) delete process.env.ROBOB_WATCH_ROOT; else process.env.ROBOB_WATCH_ROOT = previousRoot;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
test("first tick after 00:30 launches yesterday's rollup outside the runner only once", () => {
  fixture();
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => ({ exited: Promise.resolve(0) }) as ReturnType<typeof Bun.spawn>);
  try {
    setSystemTime(new Date("2026-10-24T00:29:59Z")); previousDayRollup(); expect(spawn).not.toHaveBeenCalled();
    setSystemTime(new Date("2026-10-24T00:30:00Z")); previousDayRollup();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toEqual([process.execPath, join(import.meta.dir, "../src/cli.ts"), "log-rollup", "--day", "2026-10-23"]);
    previousDayRollup(); expect(spawn).toHaveBeenCalledTimes(1);
    setSystemTime(new Date("2026-10-25T00:30:00Z")); previousDayRollup(); expect(spawn).toHaveBeenCalledTimes(2);
  } finally { spawn.mockRestore(); }
});

test.each([
  { label: "partial rollup is rewritten", day: "2026-11-10", mtime: "2026-11-10T23:59:59.999Z", launches: true },
  { label: "final rollup is skipped", day: "2026-11-11", mtime: "2026-11-12T00:01:00Z", launches: false },
  { label: "rollup at the exact end of the day is skipped", day: "2026-11-12", mtime: "2026-11-13T00:00:00Z", launches: false },
  { label: "missing rollup is created", day: "2026-11-13", mtime: undefined, launches: true },
])("$label", async ({ day, mtime, launches }) => {
  const dir = fixture(), target = join(dir, `rollup-${day}.json`);
  const dayEnd = Date.parse(`${day}T00:00:00Z`) + 86400_000;
  const original = JSON.stringify({ day, total: 0 });
  writeFileSync(join(dir, `${day}.ndjson`), ["watch.run", "wake.sent"].map(name => JSON.stringify({ tool: "watchers", kind: "perf", name, ok: true })).join("\n") + "\n");
  if (mtime) {
    writeFileSync(target, original);
    utimesSync(target, new Date(mtime), new Date(mtime));
  }
  const spawn = spyOn(Bun, "spawn");
  try {
    for (const elapsedMs of [5 * 60_000, 30 * 60_000 - 1]) {
      setSystemTime(new Date(dayEnd + elapsedMs));
      previousDayRollup();
      expect(spawn).not.toHaveBeenCalled();
    }
    setSystemTime(new Date(dayEnd + 30 * 60_000));
    previousDayRollup();
    expect(spawn).toHaveBeenCalledTimes(launches ? 1 : 0);
    if (launches) {
      const child = spawn.mock.results[0]!.value as ReturnType<typeof Bun.spawn>;
      expect(await child.exited).toBe(0);
      expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({ day, total: 2, counts: { "watch.run": 1, "wake.sent": 1 } });
      expect(statSync(target).mtimeMs).toBeGreaterThanOrEqual(dayEnd);
    } else {
      expect(readFileSync(target, "utf8")).toBe(original);
      expect(statSync(target).mtimeMs).toBe(Date.parse(mtime!));
    }
    previousDayRollup();
    expect(spawn).toHaveBeenCalledTimes(launches ? 1 : 0);
  } finally { spawn.mockRestore(); }
});
