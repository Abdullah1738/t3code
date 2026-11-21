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
      try { resolve(JSON.parse(output)); } catch { fail(messages.unavailable, "parse"); }
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
