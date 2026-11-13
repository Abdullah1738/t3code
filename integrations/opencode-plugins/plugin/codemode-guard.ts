import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { neverSettles } from "../lib/codemode-never-settles.mjs";

export { neverSettles };

const config = join(homedir(), ".config/opencode/codemode-guard.json");
const state = join(homedir(), ".local/share/opencode-plugins");
const denial = "codemode-guard: this code awaits a promise that never resolves (e.g. new Promise(r=>r)). Code Mode has no timers. This execute call was not run. To wait, end this execute call and poll again in a separate call (e.g. dia_page_state), or loop over a bounded number of tool calls.";
let cached: { mtime: number; mode: string } | undefined;

export function mode(): string {
  let mtime = -1;
  try { mtime = statSync(config).mtimeMs; } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (cached?.mtime === mtime) return cached.mode;
  const value = mtime < 0 ? {} : JSON.parse(readFileSync(config, "utf8"));
  const next = value?.mode === "off" ? "off" : "enforce";
  cached = { mtime, mode: next };
  return next;
}

function log(record: Record<string, unknown>) {
  try {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    appendFileSync(join(state, "codemode-guard.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", { mode: 0o600 });
  } catch {}
}

type Event = { tool: string; sessionID?: string; input?: { code?: unknown; [key: string]: unknown } };
type Dependencies = { mode: () => string; log: (record: Record<string, unknown>) => void };

export function createGuardHook(deps: Dependencies = { mode, log }) {
  return async (e: Event) => {
    try {
      if (e.tool !== "execute") return;
      const input = e.input;
      if (typeof input?.code !== "string" || deps.mode() === "off" || !neverSettles(input.code)) return;
      deps.log({ event: "deny", session: e.sessionID, code: input.code.slice(0, 300) });
      e.input = { ...input, code: `throw new Error(${JSON.stringify(denial)});` };
    } catch (err) {
      try { deps.log({ event: "hook-error", session: e?.sessionID, error: String(err) }); } catch {}
    }
  };
}

export default {
  id: "codemode-guard",
  setup: async (ctx: { tool: { hook: (event: string, fn: ReturnType<typeof createGuardHook>) => Promise<unknown> } }) => {
    try { await ctx.tool.hook("execute.before", createGuardHook()); } catch {}
  },
};
