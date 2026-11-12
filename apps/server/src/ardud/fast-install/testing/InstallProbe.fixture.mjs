import { continuationReport } from "../report.ts";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
globalThis.__l5InstallReport = continuationReport;
const home = process.argv[process.argv.indexOf("--base-dir") + 1];
if (!home || !fs.existsSync(path.join(home, ".crash-sandbox")))
  throw Error("Probe requires marked synthetic home");
globalThis.__l5Snapshot = () => {
  const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"), { readOnly: true });
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
        if (!fs.existsSync(path.join(home, ".pause-reconcile"))) return;
        fs.writeFileSync(
          path.join(home, ".cut-snapshot"),
          JSON.stringify(globalThis.__l5Snapshot()),
        );
        fs.writeFileSync(path.join(home, ".reconcile-boundary"), input.commandId);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }).pipe(Effect.andThen(service.commitCommand(input)));
    },
  });
