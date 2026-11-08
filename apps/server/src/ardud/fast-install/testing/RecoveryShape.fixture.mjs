// Populate only a marked synthetic home; never copy a production database.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
export function addRecoveryHistory(home, count = 100000) {
  if (!fs.existsSync(path.join(home, ".crash-sandbox")))
    throw Error("Expected marked synthetic home");
  const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"));
  const table = "orchestration_v2_projection_provider_threads";
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((c) => c.notnull || c.pk || ["thread_id", "owner_node_id"].includes(c.name));
  const insert = db.prepare(
    `INSERT INTO ${table} (${columns.map((c) => c.name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  const payload = JSON.stringify({ pendingBackgroundTasks: [], fixture: "x".repeat(2048) });
  db.exec("BEGIN");
  for (let i = 0; i < count; i++)
    insert.run(
      ...columns.map((c) =>
        c.name === "provider_thread_id"
          ? `cold-provider-${i}`
          : c.name === "thread_id"
            ? `cold-thread-${i}`
            : c.name === "owner_node_id"
              ? `cold-node-${i}`
              : c.name === "status"
                ? "stopped"
                : c.name === "payload_json"
                  ? payload
                  : c.name === "updated_at"
                    ? "2026-01-01T00:00:00Z"
                    : "synthetic",
      ),
    );
  db.exec("COMMIT");
  db.close();
}
