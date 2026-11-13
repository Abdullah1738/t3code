import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deepHealth } from "../../../../apps/server/src/ardud/control/deep-health.mjs";
import { planNotification, tick } from "./check.mjs";

// Each row covers one failed-probe/target-binding combination. Only verified
// local listeners may retain evidence while HTTP boot verification is unavailable.
const cases = [
  { name: "health timeout, state read succeeds", health: "timeout", state: "ok", alert: true },
  { name: "health error, state read succeeds", health: "error", state: "ok", alert: true },
  { name: "both reads time out", health: "timeout", state: "timeout", alert: true },
  { name: "both reads error", health: "error", state: "error", alert: true },
  { name: "localhost alias on owned port", health: "timeout", state: "ok", url: "http://localhost:3773", alert: true },
  { name: "IPv6 alias on owned port", health: "error", state: "ok", url: "http://[::1]:3773", alert: true },
  { name: "listener query unavailable", health: "error", state: "ok", ownershipError: true, alert: false },
  { name: "protocol mismatch", health: "timeout", state: "ok", url: "https://127.0.0.1:3773", alert: false },
  { name: "query string target", health: "error", state: "ok", url: "http://127.0.0.1:3773/?target=other", alert: false },
  { name: "invalid runtime PID", health: "error", state: "ok", runtime: { pid: -1 }, alert: false },
  { name: "dead runtime PID", health: "error", state: "ok", runtime: { pid: 2147483647 }, alert: false },
  { name: "invalid runtime boot", health: "error", state: "ok", runtime: { startedAt: "invalid" }, alert: false },
  { name: "another port", health: "timeout", state: "ok", url: "http://127.0.0.1:9000", alert: false },
  { name: "remote target", health: "error", state: "ok", url: "https://remote.example", alert: false },
  { name: "proxy path", health: "error", state: "ok", url: "http://127.0.0.1:3773/proxy", alert: false },
  { name: "missing runtime metadata", health: "error", state: "ok", missingRuntime: true, alert: false },
  { name: "listener belongs to another process", health: "timeout", state: "ok", owned: false, alert: false },
  { name: "successful reply from another boot", health: "other-boot", state: "ok", alert: false },
];
for (const row of cases) test(`outage evidence to alert: ${row.name}`, async () => {
  const now = Date.now();
  const notificationNow = Date.parse("2026-11-13T10:30:00Z");
  const boot = new Date(now - 3_600_000).toISOString();
  const tail = {
    text: [4, 3, 2].map(minutes => JSON.stringify({ time: new Date(now - minutes * 60_000).toISOString(), delayMaxMs: 6000, rssMb: 3000 })).join("\n") + "\n",
    bytesRead: 300,
  };
  let tailRead = false;
  let ownershipChecks = 0;
  const report = await deepHealth({
    timeoutMs: 20,
    client: {
      url: row.url ?? "http://127.0.0.1:3773",
      request: async (_method, route) => {
        const outcome = route === "/health" ? row.health : row.state;
        if (outcome === "timeout") return new Promise(() => {});
        if (outcome === "error") throw new Error("fixture transport failure");
        return route === "/health"
          ? { ok: true, status: "healthy", serverStartedAt: new Date(now - 7_200_000).toISOString() }
          : { threads: [] };
      },
    },
    readRuntime: () => row.missingRuntime ? null : { origin: "http://127.0.0.1:3773", pid: process.pid, startedAt: boot, ...row.runtime },
    checkListener: identity => {
      ownershipChecks++;
      assert.deepEqual(identity, { pid: process.pid, port: 3773 });
      if (row.ownershipError) throw new Error("ownership unavailable");
      return row.owned !== false;
    },
    readTail: () => { tailRead = true; return tail; },
  });
  const canQueryListener = !row.missingRuntime && !row.runtime && row.health !== "other-boot" && (!row.url || row.url === "http://localhost:3773" || row.url === "http://[::1]:3773");
  assert.equal(ownershipChecks, canQueryListener ? 1 : 0);
  assert.equal(tailRead, row.alert);
  assert.equal(report.lag.severeMinutes, row.alert ? 3 : 0);
  const planned = planNotification(report, {}, notificationNow);
  assert.equal(planned.pending?.kind, row.alert ? "alert" : undefined);
  assert.notEqual(report.verdict, "healthy");
  if (!row.alert) return;
  assert.equal(report.verdict, "stalled");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-outage-"));
  const sent = [];
  try {
    const send = async event => sent.push(event);
    await tick({ report, dir, send, now: notificationNow });
    await tick({ report, dir, send, now: notificationNow + 120_000 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, report.summary);
    assert.equal(sent[0].key, `robob-stall:${new Date(notificationNow).toISOString().slice(0, 13)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Clock corpus: duplicate ticks inside one UTC hour stay silent; crossing an
// hour boundary permits a new alert, including calendar rollovers.
for (const [name, first, second, expected] of [
  ["hour start", "2026-11-13T10:00:00Z", "2026-11-13T10:02:00Z", 1],
  ["last two minutes, same hour", "2026-11-13T10:58:00Z", "2026-11-13T10:59:59Z", 1],
  ["hour boundary", "2026-11-13T10:59:00Z", "2026-11-13T11:01:00Z", 2],
  ["day boundary", "2026-11-13T23:59:00Z", "2026-11-14T00:01:00Z", 2],
  ["month boundary", "2026-11-30T23:59:00Z", "2026-12-01T00:01:00Z", 2],
  ["year boundary", "2026-12-31T23:59:00Z", "2027-01-01T00:01:00Z", 2],
]) test(`outage alert clock: ${name}`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-clock-"));
  const report = { summary: "stalled: fixture", lag: { severeMinutes: 3 } };
  const sent = [];
  try {
    const send = async event => sent.push(event);
    await tick({ report, dir, send, now: Date.parse(first) });
    await tick({ report, dir, send, now: Date.parse(second) });
    assert.equal(sent.length, expected);
    assert.equal(new Set(sent.map(event => event.key)).size, expected);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
