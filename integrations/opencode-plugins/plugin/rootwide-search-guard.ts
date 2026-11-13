import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const classifier = join(homedir(), ".local/share/harness-hooks/src/rootwide_search_guard.py");
type Input = { command?: unknown; cmd?: unknown; workdir?: string; cwd?: string; [key: string]: unknown };
type Event = { tool: string; input?: Input };
type Verdict = { root: string | null; reason: string | null };

export function classify(command: string, cwd: string, script = classifier): Promise<Verdict> {
  return new Promise((resolve, reject) => {
    const child = spawn("/opt/homebrew/bin/python3", [script], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("rootwide search classifier timed out")); }, 2000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("rootwide search classifier unavailable"));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ command, cwd }));
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
    // Like the existing OpenCode DB guard, rewrite before the shell executes.
    // The native hooks and this adapter share the exact operand parser.
    let verdict: Verdict;
    try { verdict = await check(command, input.workdir ?? input.cwd ?? directory); }
    catch { return; }
    if (verdict.root && verdict.reason) {
      event.input = { ...input, [field]: `printf '%s\\n' ${quote(verdict.reason)} >&2; exit 3`, background: false };
    }
  };
}

export default {
  id: "rootwide-search-guard",
  setup: async (ctx: { location?: { directory?: string }; tool: { hook: (name: string, fn: ReturnType<typeof createGuardHook>) => Promise<unknown> } }) => {
    await ctx.tool.hook("execute.before", createGuardHook(ctx.location?.directory ?? process.cwd()));
  },
};
