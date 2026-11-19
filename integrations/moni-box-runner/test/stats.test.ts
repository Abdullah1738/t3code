import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRunner, type Harness } from "../src/runner.ts";
import { initStats, runnerStats, RECENT_INTERRUPTION_COUNTS } from "../src/stats.ts";
import { opaqueId } from "../../spectrum-bridge/src/remote-protocol.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-stats-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = 1000, began!: () => void, fail!: () => void, complete = false;
  const started = new Promise<void>(resolve => { began = resolve; });
  const harness: Harness = { run: ({ signal }) => complete ? Promise.resolve("NO_REPLY") : new Promise((_resolve, reject) => {
    fail = () => reject(new Error("PRIVATE_FAILURE")); signal!.addEventListener("abort", fail); began();
  }) };
  const config = { root, boxId: "bx_test", epoch: "test", token: "t".repeat(32), callbackToken: "c".repeat(32),
    callbackUrl: "http://unused", privateKey: "PRIVATE_KEY", system: "PRIVATE_SYSTEM" };
  const runner = new BoxRunner(config, harness, { now: () => now, modelReady: async () => true, callbackReady: async () => true,
    fetch: async () => Response.json({ accepted: true }) });
  cleanup.push(() => runner.db.close());
  const lease = () => runner.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ boxId: config.boxId, epoch: config.epoch }) }));
  const id = opaqueId("PRIVATE_MESSAGE_ID");
  return { runner, config, id, lease, started, fail: () => fail(), advance: (ms: number) => { now += ms; }, complete: () => { complete = true; } };
}

test.each(["authority-expired", "disabled", "harness-exit"] as const)("lease counts a simulated %s interruption without disclosing the turn", async reason => {
  const s = fixture(); await s.lease(); s.runner.enqueue(s.id, { text: "PRIVATE_INPUT" });
  const turn = s.runner.tick(); await s.started;
  if (reason === "authority-expired") { s.advance(20_001); await s.runner.tick(); }
  else if (reason === "disabled") s.runner.pause();
  else s.fail();
  await turn;
  const response = await s.lease(), { stats } = await response.json();
  expect(response.status).toBe(200);
  for (const window of ["total", "last24h"]) expect(stats.interruptions[window]).toEqual({
    "authority-expired": Number(reason === "authority-expired"), disabled: Number(reason === "disabled"), "harness-exit": Number(reason === "harness-exit"),
  });
  expect(stats.lastInterruptionReason).toBe(reason);
  expect(stats.lastInterruptionAt).toBe(reason === "authority-expired" ? 21_001 : 1000);
  expect(stats.stuck).toBe(Number(reason !== "authority-expired"));
  expect(stats.autoRetry).toEqual({ retried: Number(reason === "authority-expired") });
  for (const secret of ["PRIVATE_", s.id, s.config.token, s.config.callbackToken]) expect(JSON.stringify(stats)).not.toContain(secret);
});

test("a retry that completes keeps its durable count and ages out of the 24h window", async () => {
  const s = fixture(); await s.lease(); s.runner.enqueue(s.id, { text: "PRIVATE_INPUT" });
  const turn = s.runner.tick(); await s.started; s.advance(20_001); await s.runner.tick(); await turn;
  s.complete(); await s.lease(); await s.runner.tick();
  expect(s.runner.db.query<{ state: string }, []>("SELECT state FROM inbox").get()!.state).toBe("done");
  const { stats } = await (await s.lease()).json();
  expect(stats.autoRetry).toEqual({ retried: 1 }); expect(stats.stuck).toBe(0);
  s.advance(86_400_001);
  const { stats: later } = await (await s.lease()).json();
  expect(later.interruptions.last24h["authority-expired"]).toBe(0);
  expect(later.interruptions.total["authority-expired"]).toBe(1);
});

test("repeated interruption of one turn preserves both reason counts across restart", async () => {
  const s = fixture(); await s.lease(); s.runner.enqueue(s.id, { text: "PRIVATE_INPUT" });
  const turn = s.runner.tick(); await s.started; s.advance(20_001); await s.runner.tick(); await turn;
  const reopened = new BoxRunner(s.config, { run: async () => { throw new Error("PRIVATE_RETRY_FAILURE"); } }, {
    now: () => 22_000, modelReady: async () => true, callbackReady: async () => true, fetch: async () => Response.json({ accepted: true }),
  }); cleanup.push(() => reopened.db.close());
  await reopened.handle(new Request("http://box/lease", { method: "POST", headers: { authorization: `Bearer ${s.config.token}` },
    body: JSON.stringify({ boxId: s.config.boxId, epoch: s.config.epoch }) }));
  await reopened.tick();
  const stats = runnerStats(reopened.db, 22_000);
  expect(stats.interruptions.total).toEqual({ "authority-expired": 1, disabled: 0, "harness-exit": 1 });
  expect(stats.autoRetry).toEqual({ retried: 1 }); expect(stats.stuck).toBe(1); expect(stats.historySince).toBe(1000);
});

test("legacy migration is idempotent and makes retained-history coverage explicit", () => {
  const db = new Database(":memory:"); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE inbox(state TEXT);
    CREATE TABLE interruptions(reason TEXT,at INTEGER);
    INSERT INTO interruptions VALUES ('disabled',10),('PRIVATE_TEXT',20);`);
  initStats(db, 30); initStats(db, 40);
  expect(runnerStats(db, 50)).toMatchObject({ interruptions: { total: { disabled: 1 } }, historySince: 30, legacyRetained: 1,
    lastInterruptionAt: 10, lastInterruptionReason: "disabled" });
  expect(JSON.stringify(runnerStats(db, 50))).not.toContain("PRIVATE_");
});

test("legacy timestamps retain safe integers and reject malformed values", () => {
  const db = new Database(":memory:"); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE inbox(state TEXT);
    CREATE TABLE interruptions(reason TEXT,at INTEGER);
    INSERT INTO interruptions VALUES ('disabled',0),('disabled',9007199254740991),('disabled',-1),('disabled',NULL),
      ('disabled',1.5),('disabled',9007199254740992),('disabled',9223372036854775807),('disabled','PRIVATE_TEXT');`);
  initStats(db, 30);
  expect(runnerStats(db, 50)).toMatchObject({ interruptions: { total: { disabled: 2 } }, legacyRetained: 2,
    lastInterruptionAt: 9007199254740991, lastInterruptionReason: "disabled" });
  expect(JSON.stringify(runnerStats(db, 50))).not.toContain("PRIVATE_");
});

test("lifetime totals are incremental and the recent query searches a bounded timestamp range", () => {
  const s = fixture(); const now = 10 * 86_400_000;
  s.runner.db.transaction(() => {
    const insert = s.runner.db.query("INSERT INTO interruption_stats(reason,at) VALUES ('disabled',?)");
    for (let n = 0; n < 5000; n++) insert.run(n);
    insert.run(now); insert.run(now - 86_400_000); insert.run(now + 1);
  })();
  expect(runnerStats(s.runner.db, now).interruptions).toEqual({
    total: { "authority-expired": 0, disabled: 5003, "harness-exit": 0 },
    last24h: { "authority-expired": 0, disabled: 2, "harness-exit": 0 },
  });
  const plan = s.runner.db.query<{ detail: string }, [number, number]>("EXPLAIN QUERY PLAN " + RECENT_INTERRUPTION_COUNTS)
    .all(now - 86_400_000, now).map(row => row.detail).join("\n");
  expect(plan).toMatch(/SEARCH interruption_stats USING COVERING INDEX interruption_stats_at_reason \(at>\? AND at<\?\)/);
});

test("lease stays fast with thousands of metadata and inbox rows", async () => {
  const s = fixture();
  s.runner.db.transaction(() => {
    const event = s.runner.db.query("INSERT INTO interruption_stats(reason,at) VALUES ('disabled',?)");
    const inbox = s.runner.db.query("INSERT INTO inbox(id,payload,state) VALUES (?,?,'interrupted')");
    for (let n = 0; n < 5000; n++) { event.run(n % 1000); inbox.run(opaqueId(String(n)), '{}'); }
  })();
  const start = performance.now(); const response = await s.lease(); const { stats } = await response.json();
  expect(performance.now() - start).toBeLessThan(50);
  expect(stats.interruptions.total.disabled).toBe(5000); expect(stats.stuck).toBe(5000);
});
