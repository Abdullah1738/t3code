import { hook as toolLogHook, runSource } from "../lib/toollog";
import { failureProps, runClassifier } from "../lib/classifier";
import { homedir } from "node:os";
import { join } from "node:path";

const classifier = join(homedir(), ".local/share/harness-hooks/src/phone_adb_guard.py");
type Input = { command?: unknown; cmd?: unknown; workdir?: string; cwd?: string; [key: string]: unknown };
type Event = { tool: string; sessionID?: string; input?: Input };
type Verdict = { matched: boolean; reason: string | null; rule: string | null; error: string | null; holder?: string | null; adbVerb?: string | null };

export function classify(command: string, script = classifier, python = "/opt/homebrew/bin/python3"): Promise<Verdict> {
  return runClassifier(python, script, { command }, { timeout: "phone classifier unavailable", unavailable: "phone classifier unavailable", outputLimit: 4096 });
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
    catch (error) {
      toolLogHook("phone-adb", "allowed", "phone-adb-unavailable", started, command, "hook.classifier_failed", { sessionId: event.sessionID }, { cwd },
        failureProps(classifier, error, command, started));
      return;
    }
    if (verdict.matched || verdict.error) {
      toolLogHook("phone-adb", verdict.reason ? "denied" : "allowed", verdict.rule ?? "phone-adb-unavailable", started, command, verdict.error ?? undefined, { sessionId: event.sessionID }, { cwd },
        { holder: verdict.holder, adbVerb: verdict.adbVerb, source: runSource() });
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
