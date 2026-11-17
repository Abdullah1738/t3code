import { hook as toolLogHook } from "../lib/toollog";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const classifier = join(homedir(), ".local/share/harness-hooks/src/phone_adb_guard.py");
type Input = { command?: unknown; cmd?: unknown; workdir?: string; cwd?: string; [key: string]: unknown };
type Event = { tool: string; sessionID?: string; input?: Input };
type Verdict = { matched: boolean; reason: string | null; rule: string | null; error: string | null };

export function classify(command: string, script = classifier, python = "/opt/homebrew/bin/python3"): Promise<Verdict> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("phone classifier unavailable")); }, 2000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 4096) { child.kill(); reject(new Error("phone classifier output limit")); }
    });
    child.on("error", () => { clearTimeout(timer); reject(new Error("phone classifier unavailable")); });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("phone classifier unavailable"));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("phone classifier unavailable")); }
    });
    child.stdin.end(JSON.stringify({ command }));
  });
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
    const started = performance.now();
    const cwd = input.workdir ?? input.cwd ?? directory;
    let verdict: Verdict;
    try { verdict = await check(command); }
    catch {
      toolLogHook("phone-adb", "allowed", "phone-adb-unavailable", started, command, "hook.classifier_failed", { sessionId: event.sessionID }, { cwd });
      return;
    }
    if (verdict.matched || verdict.error) {
      toolLogHook("phone-adb", verdict.reason ? "denied" : "allowed", verdict.rule ?? "phone-adb-unavailable", started, command, verdict.error ?? undefined, { sessionId: event.sessionID }, { cwd });
    }
    if (verdict.reason) {
      event.input = { ...input, [field]: `printf '%s\\n' ${quote(verdict.reason)} >&2; exit 5`, background: false };
    }
  };
}

export default {
  id: "phone-adb-guard",
  setup: async (ctx: { location?: { directory?: string }; tool: { hook: (name: string, fn: ReturnType<typeof createGuardHook>) => Promise<unknown> } }) => {
    await ctx.tool.hook("execute.before", createGuardHook(ctx.location?.directory ?? process.cwd()));
  },
};
