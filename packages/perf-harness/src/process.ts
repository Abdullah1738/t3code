// @effect-diagnostics nodeBuiltinImport:off
import type { ChildProcess } from "node:child_process";
export function observeExit(child: ChildProcess) {
  let exited = child.exitCode !== null || child.signalCode !== null;
  const exit = exited ? Promise.resolve() : new Promise<void>(ok => {
    child.once("exit", () => { exited = true; ok(); });
  });
  return { get exited() { return exited; }, exit };
}
