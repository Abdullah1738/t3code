import { expect, test } from "bun:test";
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

test.each([true, false])("batch parent lookup preserves first recorded membership (prefix index: %s)", indexed => {
  const store = new Store(":memory:");
  try {
    store.set("batch:z-first", { batchIds: ["member"] });
    store.set("batch:a-second", { batchIds: ["member"] });
    if (!indexed) {
      store.db.exec("DROP INDEX kv_key_nocase");
    }
    const row = store.db.query<{ id: string }, [string]>(
      "SELECT substr(kv.key, 7) AS id FROM kv, json_each(kv.value, '$.batchIds') member WHERE kv.key LIKE 'batch:%' AND member.value = ? ORDER BY kv.rowid LIMIT 1",
    ).get("member");
    expect(row?.id).toBe("z-first");
  } finally { store.close(); }
});
