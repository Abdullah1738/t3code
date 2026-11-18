// @effect-diagnostics-next-line nodeBuiltinImport:off -- Quit callbacks must persist synchronously before Electron exits.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Signals expose a parent PID, not the sender PID.
import * as NodeChildProcess from "node:child_process";
import { classifyQuit, readSmallJson } from "@t3tools/shared/desktopQuitContext";
import { readMacQuitContext } from "../electron/MacQuitContext.ts";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopState from "./DesktopState.ts";

export type QuitTrigger =
  | {
      readonly trigger:
        | "before-quit"
        | "windowAllClosed"
        | "will-quit"
        | "quitAndInstall"
        | "menu"
        | "os-shutdown";
    }
  | { readonly trigger: "signal"; readonly signal: "SIGINT" | "SIGTERM" | "SIGHUP" }
  | { readonly trigger: "ipc-relaunch"; readonly reason: string };

export type QuitRequest = QuitTrigger & { readonly at: string };

const { logError } = makeComponentLogger("desktop-lifecycle");
const processStartedAt = performance.timeOrigin;
const encodeQuitRecord = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      at: Schema.String,
      pid: Schema.Number,
      trigger: Schema.String,
      signal: Schema.optional(Schema.String),
      reason: Schema.optional(Schema.String),
      initiator: Schema.String,
      restartReason: Schema.optional(Schema.String),
      requesterPid: Schema.optional(Schema.Number),
      appleEventSenderPid: Schema.optional(Schema.Number),
      appleEventSenderBundleId: Schema.optional(Schema.String),
      osShutdownInProgress: Schema.Boolean,
      signalParent: Schema.optional(
        Schema.Struct({ pid: Schema.Number, name: Schema.optional(Schema.String) }),
      ),
    }),
  ),
);

export const prepare = Effect.fn("desktop.lifecycle.prepareQuit")(function* (trigger: QuitTrigger) {
  const state = yield* DesktopState.DesktopState;
  const at = DateTime.formatIso(yield* DateTime.now);
  yield* Ref.update(state.quitTrigger, (current) => current ?? { ...trigger, at });
});

export const reset = Effect.gen(function* () {
  const state = yield* DesktopState.DesktopState;
  yield* Ref.set(state.quitTrigger, undefined);
  yield* Ref.set(state.quitRecorded, false);
});

export const record = Effect.fn("desktop.lifecycle.recordQuit")(function* (fallback: QuitTrigger) {
  const state = yield* DesktopState.DesktopState;
  if (yield* Ref.getAndSet(state.quitRecorded, true)) return;
  yield* prepare(fallback);
  const trigger = (yield* Ref.get(state.quitTrigger))!;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const at = DateTime.formatIso(yield* DateTime.now);
  const context = classifyQuit({
    trigger: trigger.trigger,
    pid: process.pid,
    processStartedAt,
    now: Date.parse(at),
    toolRequest: readSmallJson(
      environment.path.join(environment.logDir, "desktop-quit-request.json"),
    ),
    native: readMacQuitContext(),
    ...(trigger.trigger === "signal" ? { signalParent: signalParent() } : {}),
  });
  yield* Effect.annotateCurrentSpan({ ...trigger, pid: process.pid });
  // Updater quits can bypass Effect's scope finalizers and its buffered trace
  // writer. Persist this one event synchronously before Electron can exit.
  yield* encodeQuitRecord({
    pid: process.pid,
    ...trigger,
    at,
    ...context,
  }).pipe(
    Effect.flatMap((line) =>
      Effect.try(() => {
        const file = environment.path.join(environment.logDir, "desktop-quits.ndjson");
        if (NodeFS.existsSync(file) && NodeFS.statSync(file).size >= 256 * 1024) {
          NodeFS.renameSync(file, `${file}.1`);
        }
        NodeFS.appendFileSync(file, `${line}\n`, { mode: 0o600 });
        const handoff = environment.path.join(environment.logDir, "desktop-last-quit.json");
        NodeFS.writeFileSync(`${handoff}.${process.pid}.tmp`, line, { mode: 0o600 });
        NodeFS.renameSync(`${handoff}.${process.pid}.tmp`, handoff);
      }),
    ),
    Effect.catch((cause) => logError("failed to persist desktop quit trigger", { cause })),
  );
});

function signalParent() {
  try {
    const name = NodeChildProcess.execFileSync(
      "/bin/ps",
      ["-p", String(process.ppid), "-o", "comm="],
      {
        encoding: "utf8",
        timeout: 200,
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .trim()
      .slice(0, 512);
    return { pid: process.ppid, ...(name ? { name } : {}) };
  } catch {
    return { pid: process.ppid };
  }
}
