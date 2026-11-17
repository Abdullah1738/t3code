// @effect-diagnostics nodeBuiltinImport:off -- serialized native adapter; no Effect runtime crosses the worker boundary.
import type * as NodeChildProcess from "node:child_process";
import type * as NodeWorkerThreads from "node:worker_threads";
import type { createCommandResolver } from "./commandResolver.ts";

export interface SpawnRequest {
  readonly command: string;
  readonly args: string[];
  readonly options: NodeChildProcess.SpawnOptions;
  readonly state: SharedArrayBuffer;
  readonly port: NodeWorkerThreads.MessagePort;
}

export type SpawnEvent =
  | { readonly type: "spawn"; readonly pid: number }
  | {
      readonly type: "error";
      readonly message: string;
      readonly code?: string;
      readonly errno?: number;
      readonly syscall?: string;
      readonly path?: string;
    }
  | { readonly type: "data"; readonly stream: "stdout" | "stderr"; readonly data: Uint8Array }
  | { readonly type: "end"; readonly stream: "stdout" | "stderr" }
  | { readonly type: "written"; readonly error?: string }
  | { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null };

// Keep this function self-contained: toString works in the bundled CLI as well
// as development, without shipping a separate worker entry or loading the server.
export function spawnWorker(
  cp: typeof NodeChildProcess,
  parent: NodeWorkerThreads.MessagePort,
  resolver?: ReturnType<typeof createCommandResolver>,
) {
  parent.on("message", async (request: SpawnRequest) => {
    const { port } = request;
    // Native errors may also hold output or arguments; only transport diagnostic fields.
    const sendError = (error: NodeJS.ErrnoException) => {
      const event: SpawnEvent = {
        type: "error",
        message: error.message,
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        ...(typeof error.errno === "number" ? { errno: error.errno } : {}),
        ...(typeof error.syscall === "string" ? { syscall: error.syscall } : {}),
        ...(typeof error.path === "string" ? { path: error.path } : {}),
      };
      port.postMessage(event);
    };
    const state = new Int32Array(request.state);
    if (Atomics.load(state, 1)) {
      port.close();
      return;
    }
    try {
      const start = (previous?: string, native = false): Promise<NodeChildProcess.ChildProcess> => {
        if (Atomics.load(state, 1)) return Promise.reject(new Error("Spawn cancelled"));
        let command = native
          ? request.command
          : resolver!.resolve(request.command, request.options);
        // A missing interpreter or changed permissions can invalidate a hit.
        // If it resolves again, let native PATH search decide whether to skip it.
        if (command === previous) {
          command = request.command;
        }
        return new Promise((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException) => {
            if (
              (error.code === "ENOENT" || error.code === "EACCES" || error.code === "ENOTDIR") &&
              command !== request.command
            ) {
              start(command, previous !== undefined).then(resolve, reject);
            } else reject(error);
          };
          try {
            const child = cp.spawn(command, request.args, {
              ...request.options,
              ...(command === request.command
                ? {}
                : { argv0: request.options.argv0 ?? request.command }),
            });
            child.once("error", onError);
            child.once("spawn", () => {
              child.removeListener("error", onError);
              resolve(child);
            });
          } catch (error) {
            onError(error as NodeJS.ErrnoException);
          }
        });
      };
      const child = resolver
        ? await start()
        : cp.spawn(request.command, request.args, request.options);
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
      if (resolver) port.postMessage({ type: "spawn", pid: child.pid });
      else child.on("spawn", () => port.postMessage({ type: "spawn", pid: child.pid }));
      child.on("error", sendError);
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
        output.on("error", sendError);
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
      sendError(error as NodeJS.ErrnoException);
    }
  });
}
