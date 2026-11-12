// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
import { readFileSync } from "node:fs";
export function assertRuntime() {
  const pin = JSON.parse(readFileSync(new URL("../runtime.json", import.meta.url), "utf8"));
  if (process.version !== pin.node || process.versions.sqlite !== pin.sqlite)
    throw new Error(
      `Pinned runtime required: Node ${pin.node}, SQLite ${pin.sqlite}; got ${process.version}/${process.versions.sqlite}`,
    );
}
