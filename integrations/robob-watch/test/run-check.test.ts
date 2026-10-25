import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, inQuiet, MAX_WAKE, normalize, runCheck, sameContact, wakeText } from "../src/lib.ts";

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

test("a watcher that can send WhatsApp says who it may message, in the owner's words", () => {
  const base = { id: "eta", title: "EK58 ETA", check: "true", mode: "wake" as const, context: "On an ETA change, wa draft <jid> then wa send --approved <id>." };
  expect(() => normalize(base)).toThrow("list who it may message in relays");
  expect(normalize({ ...base, relays: [] }).relays).toEqual([]);
  const pam = { to: "120363@g.us", name: "Pam group", quote: "Keep Pam's group posted on the landing time", at: "2026-10-19T08:00:00+04:00" };
  expect(normalize({ ...base, trip: "dus-oct", relays: [pam] }).relays).toEqual([{ ...pam, at: "2026-10-19T04:00:00.000Z" }]);
  for (const relays of [[{ ...pam, quote: "" }], [{ ...pam, at: "soon" }], [pam, { ...pam, to: "120363@G.US" }], "Pam"])
    expect(() => normalize({ ...base, relays } as never)).toThrow("relays must be");
  expect(() => normalize({ ...base, relays: [], trip: "Bad Trip" })).toThrow("trip must be");
  expect(sameContact("971501234567@s.whatsapp.net", "+971 50 123 4567")).toBe(true);
  expect(sameContact("120363@g.us", "971501234567")).toBe(false);
  const state = { status: "active" as const, fires: 0, consecutive_failures: 0, failure_alerted: false };
  const live = wakeText(normalize({ ...base, relays: [pam] }), "ETA 21:40", state);
  expect(live).toContain(`- Pam group (120363@g.us), allowed 2026-10-19: "Keep Pam's group posted on the landing time"`);
  expect(live).toContain("robob-watch relay-ok eta --to <to>");
  expect(wakeText(normalize({ ...base, relays: [] }), "ETA 21:40", state)).toContain("No third-party relays: tell only the owner.");
  expect(wakeText(normalize({ ...base, context: "Tell the owner." }), "x", state)).not.toContain("third-party");
  // Set up before relays existed: the add-time guard never saw it, so the fire tells the agent owner-only.
  const legacy = { ...normalize({ ...base, relays: [] }), relays: undefined };
  const old = wakeText(legacy, "ETA 21:40", state);
  expect(old).toContain("No third-party relays: tell only the owner.");
  expect(old).toContain("no longer applies");
  expect(old.indexOf("tell only the owner")).toBeLessThan(old.indexOf(base.context));
  expect(clip(wakeText({ ...legacy, context: `${base.context} ${"x".repeat(5_900)}` }, "e".repeat(6_000), state), MAX_WAKE))
    .toContain("no longer applies");
  expect(wakeText({ ...legacy, context: "Tell the owner when it lands." }, "x", state)).not.toContain("third-party");
  // The longest wake there can be is still clipped, but never the owner-only line.
  const longest = wakeText(normalize({ ...base, context: `${base.context} ${"x".repeat(5_900)}`, relays: [] }), "e".repeat(6_000), state);
  expect(longest.length).toBeGreaterThan(MAX_WAKE);
  expect(clip(longest, MAX_WAKE)).toContain("No third-party relays: tell only the owner.");
});
