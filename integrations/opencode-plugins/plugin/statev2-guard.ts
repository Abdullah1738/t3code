import { hook as toolLogHook } from "../lib/toollog";
import { spawn } from "node:child_process";
// Shared Python verdict, with the previous local checks retained for classifier failure.
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, isAbsolute } from "node:path"

const HOME = homedir()
const CFG = join(HOME, ".config/opencode/statev2-guard.json")
const SHELL_TOOLS = new Set(["shell", "bash"])
const classifier = join(HOME, ".local/share/harness-hooks/src/statev2_check.py")
type Verdict = { rule: string | null; detail: string | null }
type Input = { command?: unknown; workdir?: string; cwd?: string; [key: string]: unknown }
type Event = { tool: string; sessionID?: string; input?: Input }

// Readers can resolve relative paths against cwd; shell syntax can itself be
// unprovable. Keep those paths in the superset even without a database literal.
export function needsClassifier(command: string): boolean {
  return /statev2|state\.sqlite|opencode\.db|\.robob|\.t3|robob-data|userdata/i.test(command)
    || /\b(?:sqlite3?|python[\d.]*|node|bun|deno|duckdb|litecli|datasette|uv|uvx|bash|sh|zsh|dash|ksh|source|vp|npm|pnpm|yarn|offbox|ssh|env|cp|rsync|ditto|dd|cat|strings|grep|rg|jq|xxd|hexdump|tar|zip|restic|find|fd|fdfind|case)\b/.test(command)
    || /(?:^|\s)\.(?=\s|$)/.test(command)
    || /[$`\\<>{}();&|'"]|(?:^|\s)(?:\.{1,2}\/|[^\s;&|<>'"]+\.(?:py|mjs|cjs|js|ts|sh)\b)/.test(command)
}

export function classify(command: string, cwd: string | null, script = classifier, python = "/opt/homebrew/bin/python3"): Promise<Verdict> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "ignore"] })
    let output = ""
    const timer = setTimeout(() => { child.kill(); reject(new Error("State database classifier timed out")) }, 2000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { output += chunk })
    child.on("error", (error) => { clearTimeout(timer); reject(error) })
    child.stdin.on("error", () => {})
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error("State database classifier unavailable"))
      try {
        const verdict = JSON.parse(output)
        if (!verdict || typeof verdict !== "object"
          || !(verdict.rule === null || typeof verdict.rule === "string" && verdict.rule.length > 0)
          || !(verdict.detail === null || typeof verdict.detail === "string")) {
          throw new Error("Invalid state database classifier verdict")
        }
        resolve(verdict)
      } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify({ command, cwd }))
  })
}

// Failure fallback: preserve the old matcher, plus OpenCode and the legacy T3 home.
const LIVE = /(\.robob\/userdata\/statev2|robob-data\/userdata\/statev2|\.robob\/userdata\/\*\.sqlite|opencode\.db|\.t3\/userdata\/state)/
// A command that names the DB is only blocked when it also opens or reads it
// (ls/stat/du/lsof on the path stay allowed).
const READER = /(?:^|[\s;&|(`])(?:\S*\/)?(sqlite3?|python[\d.]*|node|bun|deno|duckdb|litecli|datasette|uv|cp|rsync|ditto|dd|cat|strings|grep|rg|xxd|hexdump|tar|zip|restic)(?=[\s;&|)`]|$)/

let cfgCache: { mtime: number; mode: string } = { mtime: -2, mode: "enforce" }
function mode(): string {
  let m = -1
  try { m = statSync(CFG).mtimeMs } catch {}
  if (m !== cfgCache.mtime) {
    let v = "enforce"
    try { v = JSON.parse(readFileSync(CFG, "utf8"))?.mode ?? "enforce" } catch {}
    cfgCache = { mtime: m, mode: v }
  }
  return cfgCache.mode
}

// Scripts the command runs (python3 x.py, node x.mjs, bun x.ts, bash x.sh, ./x.py):
// read them and check whether they open the live DB.
const SCRIPT = /(?:^|[\s;&|(])(?:\S*python3?(?:\.\d+)?|node|bun|bash|zsh|sh|uv run(?: python)?)\s+(?:-[\w-]+\s+)*([^\s;&|<>'"]+\.(?:py|mjs|js|ts|sh))/g
const DIRECT = /(?:^|[\s;&|(])(\.?\.?\/[^\s;&|<>'"]+\.(?:py|mjs|js|ts|sh))/g

function scriptsIn(cmd: string, cwd: string | null): string[] {
  const out = new Set<string>()
  for (const re of [SCRIPT, DIRECT]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(cmd))) {
      let p = m[1].replace(/^~(?=\/)/, HOME).replace(/^\$HOME(?=\/)/, HOME)
      if (!isAbsolute(p) && cwd) p = resolve(cwd, p)
      if (isAbsolute(p)) out.add(p)
    }
  }
  return [...out]
}

function scriptTouchesLive(path: string): boolean {
  try {
    if (statSync(path).size > 2_000_000) return false
    const src = readFileSync(path, "utf8")
    return LIVE.test(src) || (/statev2\.sqlite/.test(src) && /\.robob|robob-data|userdata/.test(src))
  } catch {
    return false
  }
}

export function fallback(command: string, cwd: string | null): Verdict {
  if (LIVE.test(command) && READER.test(command)) {
    return { rule: "live-database-read", detail: "the command reads the live Robob database" }
  }
  for (const script of scriptsIn(command, cwd)) {
    if (scriptTouchesLive(script)) {
      return { rule: "live-database-read", detail: `the script ${script} opens the live Robob database` }
    }
  }
  return { rule: null, detail: null }
}

const shq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`
function denial(why: string): string {
  const lines = [
    "statev2 guard: this command was NOT run (owner incident 2026-11-05).",
    `Why: ${why}.`,
    "Reading Robob's live database (~/.robob/userdata/statev2.sqlite, 226 GB, single writer) from a shell",
    "starves Robob's writer: every board write and send fails with 'Board busy' while it runs.",
    "Use instead: Robob's own tools and APIs (board_* / card_* MCP tools, t3ctl, /api/ardud/control/*),",
    "the server traces in ~/.robob/userdata/logs/, or a copy of the database made off-peak with",
    "Abdullah's OK (sqlite3 <live> \"VACUUM INTO '<copy>'\" is itself a full read, so ask first).",
    "If you need numbers you can only get from the DB, write the exact queries into your report and stop.",
  ]
  return `printf '%s\\n' ${lines.map(shq).join(" ")} >&2; exit 3`
}

export function createGuardHook(directory: string | null, check = classify, getMode = mode, record = toolLogHook) {
  return async (e: Event) => {
    const started = performance.now()
    let decision = "allowed", rule = "no-policy", command: unknown, errorTag: string | undefined
    const input = e.input
    const cwd = input?.workdir ?? input?.cwd ?? directory
    try {
      if (!SHELL_TOOLS.has(e.tool)) return
      command = input?.command
      if (!input || typeof command !== "string" || !command) return
      const m = getMode()
      if (m === "off" || !needsClassifier(command)) return
      let verdict: Verdict
      try { verdict = await check(command, cwd) }
      catch {
        errorTag = "classifier.fallback"
        verdict = fallback(command, cwd)
      }
      if (!verdict.rule) return
      const deny = m === "enforce"
      decision = deny ? "denied" : "allowed"
      rule = verdict.rule
      if (deny) e.input = { ...input, command: denial(verdict.detail ?? "the command reads the live Robob database"), background: false }
    } catch {
      errorTag = "hook.error"
    } finally {
      if (typeof command === "string") record("statev2", decision, rule, started, command, errorTag, {sessionId:e.sessionID}, {cwd})
    }
  }
}

export default {
  id: "statev2-guard",
  setup: async (ctx: { location?: { directory?: string }; tool: { hook: (name: string, fn: ReturnType<typeof createGuardHook>) => Promise<unknown> } }) => {
    await ctx.tool.hook("execute.before", createGuardHook(ctx.location?.directory ?? null))
  },
}
