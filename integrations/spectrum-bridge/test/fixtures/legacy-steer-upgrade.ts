import { readFileSync } from "node:fs";
import type { Store } from "../../src/store.ts";

type Snapshot = {
  inbound: { id: string; payload: string; state: string }[];
  kv: { key: string; value: string }[];
  outbox: { id: string; payload: string; state: string; attempts: number; providerId: string | null }[];
};
// Generated offbox with b1a0de35^ Router/Store: root tick, a two-message steer batch,
// then final("Both done") and sent receipts. The late-adopted case closes the root
// NO_REPLY before accepting its uncertain steer. No reply coverage existed.
const fixture = JSON.parse(readFileSync(new URL("./legacy-steer-upgrade.json", import.meta.url), "utf8")) as {
  start: number; running: Snapshot; completed: Snapshot; lateAdopted: Snapshot;
};
export const legacySteerStart = fixture.start;
export function restoreLegacySteer(store: Store, phase: "running" | "completed" | "lateAdopted"): void {
  const snapshot = fixture[phase];
  store.db.transaction(() => {
    for (const row of snapshot.inbound) store.db.query("INSERT INTO inbound (id, payload, state) VALUES (?, ?, ?)").run(row.id, row.payload, row.state);
    for (const row of snapshot.kv) store.db.query("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(row.key, row.value);
    for (const row of snapshot.outbox) store.db.query("INSERT INTO outbox (id, payload, state, attempts, providerId) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, row.payload, row.state, row.attempts, row.providerId);
  }).immediate();
}
