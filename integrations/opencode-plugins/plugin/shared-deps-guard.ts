import { hook as toolLogHook } from "../lib/toollog";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const classifier = join(homedir(), ".local/share/harness-hooks/src/shared_deps_guard.py");
type Input = {
  command?: unknown;
  cmd?: unknown;
  workdir?: string;
  cwd?: string;
  [key: string]: unknown;
};
type Event = { tool: string; sessionID?: string; input?: Input };
type Verdict = { denied: boolean; reason: string | null };

export function classify(
  command: string,
  cwd: string,
  script = classifier,
  python = "/opt/homebrew/bin/python3",
): Promise<Verdict> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Shared dependencies classifier timed out"));
    }, 2000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("Shared dependencies classifier unavailable"));
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
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
    // The native hooks and this adapter share the same matcher.
    const started = performance.now();
    const cwd = input.workdir ?? input.cwd ?? directory;
    let verdict: Verdict;
    try {
      verdict = await check(command, cwd);
    } catch {
      toolLogHook(
        "shared-dependencies",
        "allowed",
        "classifier-unavailable",
        started,
        command,
        "hook.classifier_failed",
        { sessionId: event.sessionID },
        { cwd },
      );
      return;
    }
    toolLogHook(
      "shared-dependencies",
      verdict.denied && verdict.reason ? "denied" : "allowed",
      "shared-dependencies",
      started,
      command,
      undefined,
      { sessionId: event.sessionID },
      { cwd },
    );
    if (verdict.denied && verdict.reason) {
      event.input = {
        ...input,
        [field]: `printf '%s\\n' ${quote(verdict.reason)} >&2; exit 3`,
        background: false,
      };
    }
  };
}

export default {
  id: "shared-dependencies-guard",
  setup: async (ctx: {
    location?: { directory?: string };
    tool: { hook: (name: string, fn: ReturnType<typeof createGuardHook>) => Promise<unknown> };
  }) => {
    await ctx.tool.hook(
      "execute.before",
      createGuardHook(ctx.location?.directory ?? process.cwd()),
    );
  },
};
