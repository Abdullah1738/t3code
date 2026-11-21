import { hook as toolLogHook } from "../lib/toollog";
import { classifierPhases, failureProps, runClassifier } from "../lib/classifier";
import { homedir } from "node:os";
import { join } from "node:path";

const classifier = join(homedir(), ".local/share/harness-hooks/src/quint_verify_guard.py");
type Input = { command?: unknown; cmd?: unknown; workdir?: string; cwd?: string; [key: string]: unknown };
type Event = { tool: string; sessionID?: string; input?: Input };
type Verdict = { denied: boolean; reason: string | null };

export function classify(command: string, cwd: string, script = classifier, python = "/opt/homebrew/bin/python3"): Promise<Verdict> {
  return runClassifier(python, script, { command, cwd }, { timeout: "Quint verify classifier timed out", unavailable: "Quint verify classifier unavailable" });
}

const shellTools = new Set(["shell", "bash", "Bash", "exec_command", "shell_command"]);
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function createGuardHook(directory: string, check = classify) {
  return async (event: Event) => {
    if (!shellTools.has(event.tool)) return;
    const input = event.input;
    const field = typeof input?.command === "string" ? "command" : "cmd";
    const command = input?.[field];
    if (!input || typeof command !== "string" || !command) return;
    // Like the existing OpenCode DB guard, rewrite before the shell executes.
    // The native hooks and this adapter share the same matcher.
    const started = performance.now();
    const cwd = input.workdir ?? input.cwd ?? directory;
    let verdict: Verdict;
    try { verdict = await check(command, cwd); }
    catch (error) { toolLogHook("quint-verify", "allowed", "classifier-unavailable", started, command, "hook.classifier_failed", {sessionId:event.sessionID}, {cwd}, failureProps(classifier, error, command, started), classifierPhases(error)); return; }
    toolLogHook("quint-verify", verdict.denied && verdict.reason ? "denied" : "allowed", "quint-verify", started, command, undefined, {sessionId:event.sessionID}, {cwd}, {}, classifierPhases(verdict));
    if (verdict.denied && verdict.reason) {
      event.input = { ...input, [field]: `printf '%s\\n' ${quote(verdict.reason)} >&2; exit 3`, background: false };
    }
  };
}

export default {
  id: "quint-verify-guard",
  setup: async (ctx: { location?: { directory?: string }; tool: { hook: (name: string, fn: ReturnType<typeof createGuardHook>) => Promise<unknown> } }) => {
    await ctx.tool.hook("execute.before", createGuardHook(ctx.location?.directory ?? process.cwd()));
  },
};
