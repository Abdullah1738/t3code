import { continuationReport } from "../report.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
globalThis.__l5InstallReport = continuationReport;
const home = process.argv[process.argv.indexOf("--base-dir") + 1];
if (!home || !NodeFS.existsSync(NodePath.join(home, ".crash-sandbox")))
  throw Error("Probe requires marked synthetic home");
globalThis.__l5Snapshot = () => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), { readOnly: true });
  try {
    return Object.fromEntries(
      ["runs", "provider_turns", "provider_threads", "messages", "subagents", "threads"].map(
        (name) => [
          name,
          db
            .prepare(`SELECT payload_json FROM orchestration_v2_projection_${name}`)
            .all()
            .map((r) => JSON.parse(r.payload_json)),
        ],
      ),
    );
  } finally {
    db.close();
  }
};
// Freeze only the synthetic process, inside an actual reconciliation commit.
const Effect = await import("effect/Effect");
const { EventSinkV2 } = await import("../../../orchestration-v2/EventSink.ts");
const originalOf = EventSinkV2.of;
EventSinkV2.of = (service) =>
  originalOf({
    ...service,
    commitCommand: (input) => {
      if (input.commandType !== "provider-runtime.reconcile") return service.commitCommand(input);
      return Effect.sync(() => {
        if (!NodeFS.existsSync(NodePath.join(home, ".pause-reconcile"))) return;
        NodeFS.writeFileSync(
          NodePath.join(home, ".cut-snapshot"),
          JSON.stringify(globalThis.__l5Snapshot()),
        );
        NodeFS.writeFileSync(NodePath.join(home, ".reconcile-boundary"), input.commandId);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }).pipe(Effect.andThen(service.commitCommand(input)));
    },
  });
