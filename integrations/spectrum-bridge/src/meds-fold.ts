import { toolLog } from "./toollog.ts";
import type { ReplyMode } from "./config.ts";
import { stripInternalText } from "./formatting.ts";

const COMMAND = ["/usr/bin/python3", "/Users/ardud/.local/share/robob-watch/watchers/meds-nag/check.py", "--fold"];
export type FoldOptions = { cmd?: string[]; timeoutMs?: number; env?: Record<string, string | undefined>; replyMode?: ReplyMode };
export type FoldResult = { outcome: "appended" | "empty" | "error" | "timeout"; line?: string; durationMs: number };

export function foldSkipped(reason: "background" | "no_text" | "already_folded", replyMode: ReplyMode): void {
  toolLog.write({ component: "meds-fold", kind: "event", name: "meds.fold.skipped", props: { reason, replyMode } });
}

function labelCount(line: string): number {
  const labels = line.replace(/^💊 Still need:\s*/, "").replace(/\. Text me when done\.$/, "");
  let count = labels.trim() ? 1 : 0;
  let depth = 0;
  // Carry-forward labels have commas inside parenthesized notes.
  for (const char of labels) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) count++;
  }
  return count;
}

export async function foldMedsLine(opts: FoldOptions = {}): Promise<FoldResult> {
  const start = performance.now();
  const replyMode = opts.replyMode ?? "final";
  const result = (outcome: FoldResult["outcome"], extra: { line?: string; reason?: string; exitCode?: number } = {}): FoldResult => {
    const durationMs = performance.now() - start;
    const labels = extra.line === undefined ? undefined : labelCount(extra.line);
    toolLog.write({ component: "meds-fold", kind: outcome === "error" ? "error" : "event", name: `meds.fold.${outcome}`,
      durationMs, props: { replyMode, ...(labels === undefined ? {} : { labels }),
        ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }) },
      ...(outcome === "error" ? { error: { tag: `meds.fold.${extra.reason}`, message: "" } } : {}) });
    return { outcome, durationMs, ...(extra.line ? { line: extra.line } : {}) };
  };
  // Mac tests previously spawned the live watcher and polluted its health log and state.
  if (!opts.cmd && process.env.NODE_ENV === "test") return result("error", { reason: "test_default_command" });
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const env = { ...process.env, ...opts.env };
    delete env.WATCH_DIR;
    delete env.MEDS_NOW;
    child = Bun.spawn(opts.cmd ?? COMMAND, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env });
    const spawned = child;
    const output = (async () => {
      const reader = spawned.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 8192) throw new Error("output_limit");
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf8").trim();
      } finally { void reader.cancel().catch(() => {}); }
    })();
    const completed = Promise.all([spawned.exited, output]);
    const timeout = new Promise<"timeout"> (resolve => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? 2000);
    });
    const done = await Promise.race([completed, timeout]);
    if (done === "timeout") {
      spawned.kill("SIGKILL");
      return result("timeout");
    }
    const [exitCode, line] = done;
    if (exitCode !== 0) return result("error", { exitCode, reason: "exit" });
    if (!line) return result("empty");
    if (!line.startsWith("💊")) return result("error", { reason: "stdout" });
    return result("appended", { line });
  } catch {
    try { child?.kill("SIGKILL"); } catch { /* The child may already have exited. */ }
    return result("error", { reason: "hook" });
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function appendFold(texts: string[], line?: string): string[] {
  if (!line?.trim() || !texts.length) return texts;
  for (let index = texts.length - 1; index >= 0; index--) {
    const visible = stripInternalText(texts[index]!);
    if (!visible) continue;
    const copy = [...texts];
    copy[index] = `${visible}\n\n${line.trim()}`;
    return copy;
  }
  return texts;
}
