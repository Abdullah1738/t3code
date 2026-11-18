import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRunner } from "../src/runner.ts";
import { opaqueId } from "../../spectrum-bridge/src/remote-protocol.ts";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));
function fixture(root = mkdtempSync(join(tmpdir(), "action-isolation-"))) {
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = 1_000;
  const calls: string[] = [], turns: string[] = [];
  const failures = new Map<string, number | "network" | "json">([["/react", 502]]);
  const config = { root, boxId: "bx_test", epoch: "test", token: "a".repeat(40), callbackToken: "b".repeat(40),
    callbackUrl: "http://fixture", privateKey: "", system: "" };
  const make = () => new BoxRunner(config, { run: async ({ id }) => { turns.push(id); return "fixture reply"; } }, {
    now: () => now, callbackReady: async () => true,
    fetch: async url => {
      const path = new URL(String(url)).pathname; calls.push(path);
      const failure = failures.get(path);
      if (failure === "network") throw new Error("PRIVATE_NETWORK_ERROR");
      if (failure === "json") return new Response("not-json");
      return failure ? new Response("", { status: failure }) : Response.json({ accepted: true });
    },
  });
  let runner = make(); cleanup.push(() => runner.db.close());
  const request = (path: string, body = {}) => new Request(`http://fixture${path}`, {
    method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify(body),
  });
  const lease = () => runner.handle(request("/lease", { boxId: config.boxId, epoch: config.epoch }));
  const insert = (path: string, label = path, parent: string | null = null) => {
    const id = opaqueId(label);
    runner.db.query("INSERT INTO actions(id,path,payload,state,inbox_id) VALUES (?,?,?,'pending',?)")
      .run(id, path, JSON.stringify({ target: "PRIVATE_TARGET", text: "PRIVATE_TEXT" }), parent);
    return id;
  };
  const row = (id: string) => runner.db.query<{ state: string; attempts: number; last_status: number | null; next_at: number | null; result: string | null }, [string]>(
    "SELECT state,attempts,last_status,next_at,result FROM actions WHERE id=?").get(id)!;
  return { get runner() { return runner; }, calls, turns, failures, insert, row, request, lease,
    advance: async (ms: number) => { now += ms; await lease(); },
    restart: async () => { runner.db.close(); runner = make(); await lease(); },
  };
}

test("a reaction backs off across restart and gives up after three failures while later inbox sends complete", async () => {
  const s = fixture(); await s.lease(); const reaction = s.insert("/react");
  const first = opaqueId("inbox-first"), second = opaqueId("inbox-second");
  s.runner.enqueue(first, {}); await s.runner.tick();
  expect(s.turns).toEqual([first]); expect(s.calls).toEqual(["/react", "/send", "/metrics"]);
  expect(s.row(reaction)).toMatchObject({ state: "pending", attempts: 1, last_status: 502, next_at: 6_000 });
  await s.advance(4_999); await s.restart(); await s.runner.tick();
  expect(s.calls.filter(p => p === "/react")).toHaveLength(1);
  await s.advance(1); await s.runner.tick();
  expect(s.row(reaction)).toMatchObject({ attempts: 2, next_at: 36_000 });
  s.runner.enqueue(second, {}); await s.runner.tick();
  expect(s.turns).toEqual([first, second]); expect(s.calls.filter(p => p === "/send")).toHaveLength(2);
  await s.advance(29_999); await s.runner.tick(); expect(s.row(reaction).attempts).toBe(2);
  await s.advance(1); await s.runner.tick();
  expect(s.row(reaction)).toMatchObject({ state: "failed", attempts: 3, last_status: 502, next_at: 156_000 });
  expect(JSON.parse(s.row(reaction).result!)).toEqual({ error: "Nonessential action gave up", status: 502, attempts: 3 });
  await s.advance(120_000); await s.runner.tick(); expect(s.calls.filter(p => p === "/react")).toHaveLength(3);
});

test("a refused reaction fails immediately and does not block the inbox", async () => {
  const s = fixture(); s.failures.set("/react", 422); await s.lease(); const id = s.insert("/react");
  s.runner.enqueue(opaqueId("next"), {}); await s.runner.tick();
  expect(s.row(id)).toMatchObject({ state: "failed", attempts: 0 });
  expect(JSON.parse(s.row(id).result!)).toEqual({ error: "Action refused", status: 422 });
  expect(s.turns).toHaveLength(1);
});

test.each(["/send", "/files", "/agent-ask", "/agent-answer", "/agent-requests", "/share", "/unshare", "/shares"])(
  "%s retains strict order and never auto-fails on a retryable error", async path => {
    const s = fixture(); s.failures.set(path, path === "/send" ? 409 : 502); await s.lease(); const id = s.insert(path);
    s.insert("/send", "later-send"); s.runner.enqueue(opaqueId("next"), {});
    for (const ms of [0, 5_000, 30_000, 120_000]) { await s.advance(ms); await s.runner.tick(); }
    expect(s.turns).toEqual([]); expect(s.calls.every(p => p === path)).toBe(true);
    expect(s.row(id)).toEqual({ state: "pending", attempts: 0, last_status: null, next_at: null, result: null });
  });

test("retryable send 502 stops at the head; successful acknowledgement never replays it", async () => {
  const s = fixture(); s.failures.set("/send", 502); await s.lease(); const id = s.insert("/send");
  s.insert("/react"); s.runner.enqueue(opaqueId("next"), {}); await s.runner.tick();
  expect(s.calls).toEqual(["/send", "/send"]); expect(s.turns).toEqual([]); expect(s.row(id).state).toBe("pending");
  s.failures.delete("/send"); await s.runner.flush(); s.calls.length = 0; await s.runner.flush();
  expect(s.calls).toEqual([]); expect(s.row(id).state).toBe("done");
});

test.each(["network", "json"] as const)("reaction %s failures also back off without holding the inbox", async failure => {
  const s = fixture(); s.failures.set("/react", failure); await s.lease(); const id = s.insert("/react");
  s.runner.enqueue(opaqueId("next"), {}); await s.runner.tick();
  expect(s.turns).toHaveLength(1); expect(s.row(id)).toMatchObject({ state: "pending", attempts: 1, last_status: failure === "json" ? 200 : null });
});

test("a done parent, failing reaction and 1000 failing metrics cannot hold a new inbox row", async () => {
  const s = fixture(); await s.lease(); const parent = opaqueId("done-parent");
  s.runner.enqueue(parent, {}); s.runner.db.query("UPDATE inbox SET state='done' WHERE id=?").run(parent);
  s.insert("/react", "reaction", parent);
  s.runner.db.transaction(() => { for (let n = 0; n < 1000; n++) s.insert("/metrics", `metric-${n}`, parent); })();
  s.failures.set("/metrics", 502); s.runner.enqueue(opaqueId("next"), {}); await s.runner.tick();
  expect(s.turns).toEqual([opaqueId("next")]);
  expect(s.runner.db.query("SELECT 1 FROM actions WHERE path='/metrics' AND state!='done'").get()).toBeNull();
  const raw = await (await s.runner.handle(s.request("/events"))).text();
  expect(JSON.parse(raw).actions).toEqual([{ id: opaqueId("reaction").slice(0, 12), path: "/react", attempts: 1, lastStatus: 502, nextAt: 6_000, inboxId: parent.slice(0, 12) }]);
  expect(raw).not.toContain("PRIVATE_"); expect(raw).not.toContain("payload");
});

test("legacy rowid 86 action migration is idempotent and preserves the pending action", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-actions-"));
  const db = new Database(join(root, "agent.sqlite"));
  db.exec("CREATE TABLE actions(id TEXT PRIMARY KEY,path TEXT,payload TEXT,result TEXT,state TEXT)");
  db.query("INSERT INTO actions(rowid,id,path,payload,result,state) VALUES (86,?,'/react','{}',NULL,'pending')").run(opaqueId("legacy")); db.close();
  const s = fixture(root);
  const expected = { state: "pending", attempts: 0, last_status: null, next_at: null, result: null };
  expect(s.row(opaqueId("legacy"))).toEqual(expected);
  s.runner.db.close();
  const second = new BoxRunner(s.runner.config, { run: async () => "NO_REPLY" });
  expect(second.db.query("SELECT rowid,attempts,last_status,next_at,inbox_id FROM actions").get()).toEqual({ rowid: 86, attempts: 0, last_status: null, next_at: null, inbox_id: null });
  second.db.close();
});
