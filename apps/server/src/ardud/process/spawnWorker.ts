// @effect-diagnostics nodeBuiltinImport:off -- serialized native adapter; no Effect runtime crosses the worker boundary.
import type * as NodeChildProcess from "node:child_process";
import type * as NodeWorkerThreads from "node:worker_threads";

export interface SpawnRequest {
  readonly command: string;
  readonly args: string[];
  readonly options: NodeChildProcess.SpawnOptions;
  readonly state: SharedArrayBuffer;
  readonly port: NodeWorkerThreads.MessagePort;
}

export type SpawnEvent =
  | { readonly type: "spawn"; readonly pid: number }
  | { readonly type: "error"; readonly message: string; readonly code?: string }
  | { readonly type: "data"; readonly stream: "stdout" | "stderr"; readonly data: Uint8Array }
  | { readonly type: "end"; readonly stream: "stdout" | "stderr" }
  | { readonly type: "written"; readonly error?: string }
  | { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null };

// Keep this function self-contained: toString works in the bundled CLI as well
// as development, without shipping a separate worker entry or loading the server.
export function spawnWorker(cp: typeof NodeChildProcess, parent: NodeWorkerThreads.MessagePort) {
  parent.on("message", (request: SpawnRequest) => {
    const { port } = request;
    const state = new Int32Array(request.state);
    if (Atomics.load(state, 1)) {
      port.close();
      return;
    }
    try {
      const child = cp.spawn(request.command, request.args, request.options);
      if (child.pid) Atomics.store(state, 0, child.pid);
      const kill = () => {
        if (!child.pid) return;
        try {
          process.kill(request.options.detached ? -child.pid : child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      };
      // Cancellation may arrive while uv_spawn is blocked; the shared flag is
      // visible before the worker can service its next message.
      if (Atomics.load(state, 1)) kill();
      child.on("spawn", () => port.postMessage({ type: "spawn", pid: child.pid }));
      child.on("error", (error: NodeJS.ErrnoException) => {
        port.postMessage({ type: "error", message: error.message, code: error.code });
      });
      child.on("exit", (code, signal) => {
        port.postMessage({ type: "exit", code, signal });
        if (code !== 0 && code !== null) {
          try {
            process.kill(
              request.options.detached ? -child.pid! : child.pid!,
              request.options.killSignal ?? "SIGTERM",
            );
          } catch {
            /* Already exited. */
          }
        }
      });
      for (const name of ["stdout", "stderr"] as const) {
        const output = child[name];
        if (!output) {
          port.postMessage({ type: "end", stream: name });
          continue;
        }
        output.on("data", (data: Buffer) => {
          output.pause();
          port.postMessage({ type: "data", stream: name, data });
        });
        output.on("end", () => port.postMessage({ type: "end", stream: name }));
        output.on("error", (error) => port.postMessage({ type: "error", message: error.message }));
      }
      child.stdin?.on("error", (error) =>
        port.postMessage({ type: "written", error: error.message }),
      );
      port.on(
        "message",
        (
          message:
            | { type: "read"; stream: "stdout" | "stderr" }
            | { type: "write"; data: Uint8Array }
            | { type: "end" },
        ) => {
          switch (message.type) {
            case "read":
              child[message.stream]?.resume();
              break;
            case "write":
              child.stdin?.write(message.data, (error) =>
                port.postMessage({ type: "written", error: error?.message }),
              );
              break;
            case "end":
              child.stdin?.end(() => port.postMessage({ type: "written" }));
              break;
          }
        },
      );
      port.on("close", () => {
        if (Atomics.load(state, 1)) kill();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
      });
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      port.postMessage({ type: "error", message: cause.message, code: cause.code });
    }
  });
}
