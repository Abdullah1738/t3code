import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

function plan(store: Store, sql: string) {
  const query = store.db.prepare<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`);
  try { return query.all().map(row => row.detail).join("\n"); }
  finally { query.finalize(); }
}
async function loopBound(work: () => void) {
  const started = performance.now();
  const heartbeat = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - started), 0));
  work();
  expect(await heartbeat).toBeLessThan(100);
}

test("pending inbox reads skip 50 MiB of terminal history and preserve row order after state changes", async () => {
  const store = new Store(":memory:");
  try {
    const payload = { text: "x".repeat(10 * 1024) };
    store.db.transaction(() => {
      for (let i = 0; i < 5120; i++) {
        store.acceptInbound(`fixture:${i}`, payload);
        store.updateInbound(`fixture:${i}`, "done");
      }
      store.acceptInbound("pending-1", { text: "one" });
      store.acceptInbound("processing-2", { text: "two" });
      store.updateInbound("processing-2", "processing");
      store.acceptInbound("pending-3", { text: "three" });
    })();
    const sql = "SELECT id,payload,state FROM inbound WHERE state IN ('pending','processing') ORDER BY rowid";
    expect(plan(store, sql)).toContain("inbound_state");
    await loopBound(() => {
      for (let i = 0; i < 20; i++) expect(store.pendingInbound().map(row => row.id)).toEqual(["pending-1", "processing-2", "pending-3"]);
    });
    store.updateInbound("processing-2", "done");
    store.updateInbound("fixture:0", "pending");
    expect(store.pendingInbound().map(row => row.id)).toEqual(["fixture:0", "pending-1", "pending-3"]);
    store.db.exec("DROP INDEX inbound_state");
    expect(plan(store, sql)).toContain("SCAN inbound");
  } finally { store.close(); }
});

test("share and recovery LIKE scans skip 50 MiB of unrelated values, preserving case and prefix semantics", async () => {
  const store = new Store(":memory:");
  try {
    store.db.transaction(() => {
      for (let i = 0; i < 5120; i++) store.set(`unrelated:${i}`, "x".repeat(10 * 1024));
      for (const prefix of ["share:", "failed-replay-receipt:", "failed-alert-pending:", "secret-request:", "seed:", "poll-seen:", "poll-unmatched:"]) {
        for (const suffix of ["a", "z", "_", "%", "[", ":"]) store.set(prefix + suffix, 1);
        store.set(prefix.toUpperCase() + "A", 2);
        store.set(prefix.slice(0, -1) + ";a", 3);
      }
    })();
    for (const prefix of ["share:", "failed-replay-receipt:", "failed-alert-pending:", "secret-request:", "seed:", "poll-seen:", "poll-unmatched:"]) {
      const order = ["share:", "secret-request:", "seed:"].includes(prefix) ? "key" : "rowid";
      const sql = `SELECT key,value FROM kv WHERE key LIKE '${prefix}%' ORDER BY ${order}`;
      expect(plan(store, sql)).toContain("kv_key_nocase");
      const query = store.db.query<{ key: string; value: string }, []>(sql);
      const before = query.all();
      expect(before).toHaveLength(7);
      if (order === "rowid") expect(before.map(row => row.key)).toEqual(["a", "z", "_", "%", "[", ":"].map(suffix => prefix + suffix).concat(prefix.toUpperCase() + "A"));
      await loopBound(() => { for (let i = 0; i < 20; i++) expect(query.all()).toEqual(before); });
      query.finalize();
      store.db.exec("DROP INDEX kv_key_nocase");
      expect(store.db.query(sql).all()).toEqual(before);
      expect(plan(store, sql)).not.toContain("kv_key_nocase");
      store.db.exec("CREATE INDEX kv_key_nocase ON kv(key COLLATE NOCASE)");
    }
  } finally { store.close(); }
});

test("batch parent lookup preserves first recorded membership", () => {
  const store = new Store(":memory:");
  try {
    store.set("batch:z-first", { batchIds: ["member"] });
    store.set("batch:a-second", { batchIds: ["member"] });
    const row = store.db.query<{ id: string }, [string]>(
      "SELECT batch_members.leader AS id FROM batch_members JOIN kv ON kv.key = 'batch:' || batch_members.leader WHERE batch_members.member = ? ORDER BY kv.rowid LIMIT 1",
    ).get("member");
    expect(row?.id).toBe("z-first");
    expect(store.batchLeaders("member")).toEqual(["a-second", "z-first"]);
  } finally { store.close(); }
});

test("batch membership index follows every kv write path, rollback and malformed value", () => {
  const store = new Store(":memory:");
  try {
    store.set("batch:leader", { batchIds: ["leader", "a", "a", 7, null] });
    expect(store.batchLeaders("a")).toEqual(["leader"]);
    expect(store.batchLeaders("7")).toEqual([]);
    store.set("batch:leader", { batchIds: ["leader", "b"] });
    expect(store.batchLeaders("a")).toEqual([]);
    expect(store.batchLeaders("b")).toEqual(["leader"]);
    store.set("batch:leader", null);
    expect(store.batchLeaders("b")).toEqual([]);
    store.db.query("INSERT INTO kv (key, value) VALUES ('batch:raw', ?)").run(JSON.stringify({ batchIds: ["c"] }));
    expect(store.batchLeaders("c")).toEqual(["raw"]);
    store.db.query("UPDATE kv SET key = 'moved:raw' WHERE key = 'batch:raw'").run();
    expect(store.batchLeaders("c")).toEqual([]);
    store.db.query("UPDATE kv SET key = 'batch:back' WHERE key = 'moved:raw'").run();
    expect(store.batchLeaders("c")).toEqual(["back"]);
    store.db.query("INSERT OR REPLACE INTO kv (key, value) VALUES ('batch:back', ?)").run(JSON.stringify({ batchIds: ["f"] }));
    expect(store.batchLeaders("c")).toEqual([]);
    expect(store.batchLeaders("f")).toEqual(["back"]);
    store.db.query("DELETE FROM kv WHERE key = 'batch:back'").run();
    expect(store.batchLeaders("f")).toEqual([]);
    expect(store.batchLeaders("c")).toEqual([]);
    expect(() => store.db.transaction(() => {
      store.set("batch:rolled", { batchIds: ["d"] });
      expect(store.batchLeaders("d")).toEqual(["rolled"]);
      throw new Error("synthetic rollback");
    })()).toThrow("synthetic rollback");
    expect(store.batchLeaders("d")).toEqual([]);
    store.db.query("INSERT INTO kv (key, value) VALUES ('batch:broken', '{not json')").run();
    expect(store.batchLeaders("broken")).toEqual([]);
    store.set("batching:other", { batchIds: ["e"] });
    expect(store.batchLeaders("e")).toEqual([]);
    expect(plan(store, "SELECT leader FROM batch_members WHERE member = 'x' ORDER BY leader")).toContain("PRIMARY KEY");
  } finally { store.close(); }
});

test("an existing database backfills batch membership once on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-members-"));
  const path = join(dir, "state.sqlite");
  try {
    const legacy = new Store(path);
    legacy.db.exec("DROP TRIGGER batch_members_insert; DROP TRIGGER batch_members_update; DROP TRIGGER batch_members_delete; DROP TABLE batch_members");
    legacy.set("batch:old", { batchIds: ["old", "sealed"] });
    legacy.close();
    const store = new Store(path);
    try {
      expect(store.batchLeaders("sealed")).toEqual(["old"]);
      store.set("batch:new", { batchIds: ["sealed"] });
    } finally { store.close(); }
    const reopened = new Store(path);
    try { expect(reopened.batchLeaders("sealed")).toEqual(["new", "old"]); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
