import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planNotification, tick, notify, isLiveRun } from "./check.mjs";
const now = Date.parse("2026-11-13T10:30:00Z");
const sustained = { verdict: "stalled", summary: "stalled: fixture", lag: { severeMinutes: 3, stalls5s: 4, status: "complete" }, connection: { status: "ok" }, roundTrip: { status: "ok", ms: 10 } };
const recovered = { ...sustained, verdict: "healthy", lag: { severeMinutes: 0, stalls5s: 0, status: "complete" } };
test("three separate minutes required, not one spike or three rows in one minute", () => {
  for (const [minutes, count] of [[1, 1], [1, 3], [2, 10]]) assert.deepEqual(planNotification({ ...sustained, lag: { severeMinutes: minutes, stalls5s: count } }, {}, now), {});
});
test("persistent hourly alert dedupe and a single recovery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-watch-"));
  const sent = [];
  const run = (report, at) => tick({ dir, report, now: at, send: async pending => sent.push(pending) });
  try {
    await run(sustained, now);
    await run(sustained, now + 120_000);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].key, "robob-stall:2026-11-13T10");
    assert.equal(sent[0].text, sustained.summary);
    await run(recovered, now + 599_999);
    await run({ ...recovered, lag: { ...recovered.lag, status: "unknown" } }, now + 600_000);
    assert.equal(sent.length, 1);
    await run(recovered, now + 600_000);
    await run(recovered, now + 720_000);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].kind, "recovered");
    assert.equal(sent[1].key, "robob-stall:2026-11-13T10:recovered");
    await run(sustained, now + 780_000);
    assert.equal(sent.length, 2);
    await run(sustained, now + 3_600_000);
    assert.equal(sent.length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("lost acknowledgement retries identical payload before accepting newer data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-retry-"));
  let failed;
  try {
    await assert.rejects(tick({ dir, report: sustained, now, send: async event => { failed = event; throw new Error("lost ack"); } }));
    let retried;
    await tick({ dir, report: recovered, now: now + 120_000, send: async event => { retried = event; } });
    assert.deepEqual(retried, failed);
    const state = JSON.parse(fs.readFileSync(path.join(dir, "stall-state.json")));
    assert.equal(state.pending, undefined);
    assert.equal(state.active.key, failed.key);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Telegram acknowledgements use id/created for both new and deduplicated queue entries", () => {
  const pending = { kind: "alert", key: "robob-stall:2026-11-13T10", text: "stalled: fixture" };
  for (const created of [true, false]) {
    notify(pending, (_bin, args) => {
      assert.equal(args[1], "notify");
      assert.equal(args.find(a => a.startsWith("--key=")).slice(6), pending.key);
      assert.equal(args.find(a => a.startsWith("--text=")).slice(7), pending.text);
      return JSON.stringify({ id: "notify:" + "a".repeat(64), created });
    });
  }
  for (const response of [null, {}, { ok: true }, { id: "notify:bad", created: true }, { id: "notify:" + "a".repeat(64), created: "true" }]) {
    assert.throws(() => notify(pending, () => JSON.stringify(response)));
  }
});

for (const [name, env, live] of [
  ["scratch", {}, false], ["prime", { WATCH_RUN: "prime-abc" }, false],
  ["scheduled", { WATCH_RUN: "run-abc" }, true],
  ["test flag", { WATCH_RUN: "run-abc", ROBOB_TEST: "1" }, false],
  ["node test", { WATCH_RUN: "run-abc", NODE_ENV: "test" }, false],
  ["pytest", { WATCH_RUN: "run-abc", PYTEST_CURRENT_TEST: "fixture" }, false],
]) test(`notification permission: ${name}`, () => assert.equal(isLiveRun(env), live));
test("recovery requires a healthy verdict, including database readiness", () => {
  const state = { active: { key: "robob-stall:2026-11-13T10", at: now } };
  for (const verdict of ["degraded", "unknown", "stalled"]) {
    assert.deepEqual(planNotification({ ...recovered, verdict, connection: { status: "ok", readiness: verdict } }, state, now + 600_000), state);
  }
});
