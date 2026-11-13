// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- process boundary must interrupt native SQLite, including a blocked C call.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";
import * as NodeModule from "node:module";

export interface ReaderRuntime {
  readonly completion?: Promise<number>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  postMessage(value: unknown): void;
  ref(): unknown;
  unref(): unknown;
  terminate(): Promise<number>;
}

/** A worker thread cannot interrupt sqlite3_step. A process can be killed by
 * the watchdog; wait for exit before its slot is replaced so retired queries
 * cannot accumulate outside the configured pool bound. IPC advanced mode keeps
 * blob and bigint results lossless. No SQL, parameters or credentials in argv. */
export function startReaderProcess(
  source: string,
  data: Record<string, unknown>,
  spawnProcess: typeof NodeChildProcess.spawn = NodeChildProcess.spawn,
): ReaderRuntime {
  const bootstrap =
    source.replace(
      'const { parentPort, workerData } = require("node:worker_threads");',
      `let workerData;
process.on("disconnect", () => process.exit(0));
process.once("message", data => { workerData = data; start(); });
function start() {
const { Worker } = require("node:worker_threads");
const deadline = new BigInt64Array(new SharedArrayBuffer(8));
const arm = (limitMs = workerData.statementLimitMs) => {
  const next = process.hrtime.bigint() / 1000000n + BigInt(limitMs);
  const prior = Atomics.load(deadline, 0);
  Atomics.store(deadline, 0, prior === 0n || next < prior ? next : prior);
};
// This thread never executes SQLite. It also bounds an orphan's native call if
// the server is killed while the child cannot handle its IPC disconnect event.
const guard = new Worker(\`const { workerData } = require("node:worker_threads");
const deadline = new BigInt64Array(workerData.deadline);
setInterval(() => { const at = Atomics.load(deadline, 0);
  if (at !== 0n && process.hrtime.bigint() / 1000000n >= at) process.kill(workerData.pid, "SIGKILL");
}, 100);\`, { eval: true, workerData: { deadline: deadline.buffer, pid: process.pid } });
guard.unref();
arm();
const parentPort = {
  postMessage: value => { if (value.type === "ready") Atomics.store(deadline, 0, 0n); process.send(value); },
  on: (_event, listener) => process.on("message", input => {
    arm();
    try { listener(input); } finally {
      if (db && !db.isTransaction) Atomics.store(deadline, 0, 0n);
      // An open transaction keeps its own (usually shorter) bound from its first statement.
      else if (db && workerData.transactionLimitMs !== undefined) arm(workerData.transactionLimitMs);
    }
  }),
};`,
    ) + "\n}";
  const sea = NodeSea.isSea();
  const child = spawnProcess(process.execPath, sea ? ["__sqlite-reader"] : ["-e", bootstrap], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  const pid = child.pid;
  const hasPid = typeof pid === "number" && Number.isInteger(pid) && pid > 0;
  let exited = false;
  const exit = new Promise<number>((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      resolve(code ?? 1);
    });
    child.once("error", () => {
      if (child.pid === undefined) {
        exited = true;
        resolve(1);
      }
    });
  });
  child.send(sea ? { bootstrap, data } : data);
  return {
    completion: exit,
    on: (event, listener) => child.on(event, listener),
    postMessage: (value) => {
      if (child.connected) child.send(value as NodeChildProcess.Serializable);
    },
    ref: () => {
      child.ref();
      child.channel?.ref();
    },
    unref: () => {
      child.unref();
      child.channel?.unref();
    },
    terminate: () => {
      if (!exited && hasPid) child.kill("SIGKILL");
      return exit;
    },
  };
}

/** Early SEA CLI dispatch, before the server graph or migrations are loaded. */
export function runReaderProcess(): void {
  if (typeof process.send !== "function") throw new Error("Reader requires a private IPC channel");
  process.once("message", (input: { bootstrap: string; data: unknown }) => {
    const run = new Function("require", input.bootstrap);
    run(NodeModule.createRequire(process.execPath));
    process.emit("message", input.data, undefined);
  });
}
