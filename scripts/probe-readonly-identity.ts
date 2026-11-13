// @effect-diagnostics nodeBuiltinImport:off globalDate:off - standalone read-only diagnostic.
import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeTimersPromises from "node:timers/promises";

const { values } = NodeUtil.parseArgs({
  options: {
    replica: {
      type: "string",
      default: NodePath.join(NodeOS.homedir(), ".robob/userdata/readonly/state.sqlite"),
    },
    "provider-thread-id": { type: "string" },
    "thread-id": { type: "string" },
    "created-at": { type: "string" },
    "timeout-ms": { type: "string", default: "120000" },
  },
});
if (!values["provider-thread-id"] && !values["thread-id"])
  throw new Error(
    "Pass --provider-thread-id <projection key> or --thread-id <delegate childThreadId>",
  );
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid --timeout-ms");
const suppliedCreated = values["created-at"] ? Date.parse(values["created-at"]) : undefined;
if (suppliedCreated !== undefined && !Number.isFinite(suppliedCreated))
  throw new Error("Invalid --created-at");
// Never opens the live source. created_at in the replica is the copied source
// timestamp; --created-at can instead carry the commit time from a service/API.
const db = new NodeSqlite.DatabaseSync(values.replica, { readOnly: true });
db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
const provider = values["provider-thread-id"]
  ? db.prepare(
      "SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?",
    )
  : db.prepare(
      "SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE thread_id=? LIMIT 1",
    );
const thread = db.prepare(
  "SELECT created_at FROM orchestration_v2_projection_threads WHERE thread_id=?",
);
const child = db.prepare(
  "SELECT subagent_id FROM orchestration_v2_projection_subagents WHERE child_thread_id=? LIMIT 1",
);
const meta = db.prepare(
  "SELECT key,value FROM ardud_readonly_meta WHERE key IN ('ready','updated_at')",
);
const started = Date.now();
try {
  while (Date.now() - started < timeoutMs) {
    // A pinned snapshot proves that the three identity rows coexist.
    db.exec("BEGIN");
    let result;
    try {
      const binding = provider.get(values["provider-thread-id"] ?? values["thread-id"]!);
      const id = values["thread-id"] ?? binding?.thread_id;
      const row = typeof id === "string" ? thread.get(id) : undefined;
      const lineage = typeof id === "string" ? child.get(id) : undefined;
      const markers = Object.fromEntries(meta.all().map((r) => [r.key, r.value]));
      if (binding && row && lineage && markers.ready === "1") {
        const created = suppliedCreated ?? Date.parse(String(row.created_at));
        if (!Number.isFinite(created))
          throw new Error("Source creation timestamp missing; pass --created-at");
        result = {
          threadId: id,
          visibleAt: new Date().toISOString(),
          createdAt: new Date(created).toISOString(),
          lagMs: Date.now() - created,
          probeElapsedMs: Date.now() - started,
          updatedAt: markers.updated_at,
        };
      }
    } finally {
      db.exec("ROLLBACK");
    }
    if (result) {
      console.log(JSON.stringify(result));
      process.exitCode = result.lagMs <= 5_000 ? 0 : 1;
      break;
    }
    await NodeTimersPromises.setTimeout(100);
  }
  if (process.exitCode === undefined) {
    console.error(
      JSON.stringify({ error: "identity_not_visible", elapsedMs: Date.now() - started }),
    );
    process.exitCode = 2;
  }
} finally {
  db.close();
}
