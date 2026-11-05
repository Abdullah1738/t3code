import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, escalationText, inQuiet, MAX_WAKE, normalize, runCheck, sameContact, sendNotes, wakeText } from "../src/lib.ts";

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

test("a wake carries the start of its context, and the whole context only on the day's first fire", () => {
  const context = `Tell the owner. ${"x ".repeat(1000)}`;
  const w = normalize({ id: "ctx", title: "Ctx", check: "true", mode: "wake", context });
  const base = { status: "active" as const, fires: 0, consecutive_failures: 0, failure_alerted: false };
  const pointer = "Full rules: `robob-watch context ctx`";
  const sameDay = wakeText(w, "event", { ...base, last_fire_at: "2026-10-28T06:00:00Z", pending: { key: "k", event: "event", at: "2026-10-28T08:00:00Z" } });
  expect(sameDay).toContain(pointer);
  expect(sameDay).not.toContain(context);
  expect(sameDay.length).toBeLessThan(1_500);
  // The cut lands at a space, so the preview never ends mid-word.
  expect(sameDay).toContain("Tell the owner. x x");
  const newDay = wakeText(w, "event", { ...base, last_fire_at: "2026-10-27T06:00:00Z", pending: { key: "k", event: "event", at: "2026-10-28T08:00:00Z" } });
  expect(newDay).toContain(w.context);
  expect(newDay).not.toContain(pointer);
  expect(wakeText(w, "event", base)).toContain(w.context);
  const escalation = escalationText(w, { ...base, consecutive_failures: 5, failing_since: "2026-10-28T06:00:00Z", last_error: "boom" }, 15);
  expect(escalation).toContain(pointer);
  expect(escalation.length).toBeLessThan(1_500);
});

test("watcher check children inherit replica overrides", async () => {
  const names = ["ROBOB_READONLY_DB", "MONEY_CASES_STATE_DB", "SEND_APPROVAL_STATE_DB", "ROBOB_HOME", "T3CODE_HOME", "XDG_DATA_HOME"];
  const before = names.map(name => process.env[name]);
  for (const name of names) process.env[name] = `/replica/${name}`;
  try {
    const result = await runCheck(watcher('print -r -- "$ROBOB_READONLY_DB|$MONEY_CASES_STATE_DB|$SEND_APPROVAL_STATE_DB|$ROBOB_HOME|$T3CODE_HOME|$XDG_DATA_HOME"'), dir);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(names.map(name => `/replica/${name}`).join("|"));
  } finally {
    for (const [i, name] of names.entries()) {
      if (before[i] === undefined) delete process.env[name];
      else process.env[name] = before[i];
    }
  }
});

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
  // Nothing is refused any more: a watcher without relays is accepted, and sendNotes gives the note.
  expect(normalize(base).relays).toBeUndefined();
  expect(sendNotes(normalize({ ...base, check: "wa draft $JID hi" }))).toEqual([
    "its text mentions WhatsApp sends: relays, with his words, are optional and give the fire his stops and the ETA throttle",
    "its check sends WhatsApp by itself on every change, with no agent reading it first",
  ]);
  expect(sendNotes(normalize({ ...base, relays: [] }))).toEqual([]);
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
  expect(wakeText(normalize(base), "ETA 21:40", state)).not.toContain("third-party");
  expect(wakeText(normalize({ ...base, context: "Tell the owner." }), "x", state)).not.toContain("third-party");
  // Set up before relays existed: no relay lines, and nothing about relays is added to the wake text.
  const legacy = { ...normalize({ ...base, relays: [] }), relays: undefined };
  const old = wakeText(legacy, "ETA 21:40", state);
  expect(old).not.toContain("No third-party relays");
  expect(old).not.toContain("tell only the owner");
  expect(old).not.toContain("no longer applies");
  expect(wakeText({ ...legacy, context: "Tell the owner when it lands." }, "x", state)).not.toContain("third-party");
  // The longest wake there can be is still clipped.
  const longest = wakeText(normalize({ ...base, context: `${base.context} ${"x".repeat(5_900)}`, relays: [] }), "e".repeat(6_000), state);
  expect(longest.length).toBeGreaterThan(MAX_WAKE);
  expect(clip(longest, MAX_WAKE)).toContain("No third-party relays: tell only the owner.");
});
