import { spawn } from "node:child_process";
import { basename } from "node:path";
import { cmdKind, runSource } from "./toollog";

const ms = (value: number) => Math.round(value * 1000) / 1000;

// Messages are the caller's fixed strings and errorClass is a short code, so
// neither can carry command text, classifier output or a secret into the log.
export class ClassifierError extends Error {
  constructor(message: string, readonly errorClass: string, readonly spawnMs: number, readonly classifyMs: number) {
    super(message);
  }
}

type Timing = { spawnMs: number; classifyMs: number };
// Successful verdicts are plain JSON; their timings ride beside them, not in them.
const verdictTimings = new WeakMap<object, Timing>();

/**
 * Measured phases of one classifier call for a slow hook row: spawn (the synchronous fork)
 * and classify (until the child's close or the 2 s timer callback ran, so a blocked event
 * loop lands here). Outcomes that did not come from runClassifier give no phases.
 */
/** Keeps a verdict's timings on an object a guard derived from it. */
export function carryTimings<T extends object>(from: unknown, to: T): T {
  const timing = from !== null && typeof from === "object" ? verdictTimings.get(from) : undefined;
  if (timing) verdictTimings.set(to, timing);
  return to;
}

export function classifierPhases(outcome: unknown) {
  const timing = outcome instanceof ClassifierError ? outcome : outcome !== null && typeof outcome === "object" ? verdictTimings.get(outcome) : undefined;
  return timing ? { spawn_ms: timing.spawnMs, classify_ms: timing.classifyMs } : {};
}

type Messages = { timeout: string; unavailable: string; outputLimit?: number };

/** Run one Python guard classifier: JSON on stdin, one JSON verdict on stdout, 2 s budget. */
export function runClassifier<T>(python: string, script: string, payload: unknown, messages: Messages): Promise<T> {
  return new Promise((resolve, reject) => {
    const begun = performance.now();
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "ignore"] });
    // spawn() forks synchronously; on a loaded Mac that alone can outlast the timer.
    const spawned = performance.now();
    const fail = (message: string, errorClass: string) =>
      reject(new ClassifierError(message, errorClass, ms(spawned - begun), ms(performance.now() - spawned)));
    let output = "";
    // A late timer (classifyMs well past 2000) means OpenCode's event loop was blocked.
    const timer = setTimeout(() => { child.kill(); fail(messages.timeout, "timeout"); }, 2000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (messages.outputLimit && output.length > messages.outputLimit) { child.kill(); fail(messages.unavailable, "output-limit"); }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(messages.unavailable, "spawn:" + (typeof error.code === "string" ? error.code : error.constructor.name));
    });
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return fail(messages.unavailable, code === null ? "signal:" + (signal ?? "unknown") : "exit:" + code);
      let verdict: unknown;
      try { verdict = JSON.parse(output); } catch { return fail(messages.unavailable, "parse"); }
      if (verdict !== null && typeof verdict === "object") verdictTimings.set(verdict, { spawnMs: ms(spawned - begun), classifyMs: ms(performance.now() - spawned) });
      resolve(verdict as T);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Props for a hook.classifier_failed row. */
export function failureProps(script: string, error: unknown, command: unknown, started: number, failMode: "open" | "fallback" = "open") {
  const known = error instanceof ClassifierError ? error : undefined;
  return {
    classifier: basename(script).replace(/\.py$/, ""),
    failMode,
    errorClass: known?.errorClass ?? (error instanceof Error ? error.constructor.name : typeof error),
    errorMessage: known?.message ?? "unclassified",
    spawnMs: known?.spawnMs,
    classifyMs: known?.classifyMs,
    totalMs: ms(performance.now() - started),
    cmdKind: cmdKind(command),
    source: runSource(),
  };
}
