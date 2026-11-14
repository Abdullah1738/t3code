import { hook as toolLogHook } from "../lib/toollog";
// statev2 guard (2026-11-05). Robob keeps all its state in one SQLite file
// (~/.robob/userdata/statev2.sqlite, 226 GB on the external SSD) with a single
// writer. Agents running their own sqlite3 / python / node reads against the
// live file (db-measure.py for #467, analyze.py for #456, ad-hoc sqlite3
// queries) starved that writer: every board write waited 20-70 s and returned
// "Board busy: not written" on all boards (5 Nov, 10:09-10:37Z).
//
// This blocks shell commands that name the live database, and scripts that
// open it, and tells the agent to work on a copy instead. Fails open on errors.
// Off switch: ~/.config/opencode/statev2-guard.json {"mode":"off"} (no restart).
import { appendFileSync, readFileSync, statSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, isAbsolute } from "node:path"

const HOME = homedir()
const CFG = join(HOME, ".config/opencode/statev2-guard.json")
const LOGDIR = join(HOME, ".local/share/statev2-guard")
const LOG = join(LOGDIR, "guard.jsonl")
const SHELL_TOOLS = new Set(["shell", "bash"])

// Any reference to the live Robob state DB (both paths resolve to the same file).
const LIVE = /(\.robob\/userdata\/statev2|robob-data\/userdata\/statev2|\.robob\/userdata\/\*\.sqlite)/
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

function log(o: Record<string, unknown>) {
  try {
    mkdirSync(LOGDIR, { recursive: true })
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n")
  } catch {}
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

export default {
  id: "statev2-guard",
  setup: async (ctx: any) => {
    await ctx.tool.hook("execute.before", async (e: any) => {
      const started = performance.now()
      let decision = 'allowed', rule = 'no-policy', command: unknown, errorTag: string | undefined
      try {
        if (!SHELL_TOOLS.has(e.tool)) return
        const input = e.input as any
        const cmd = input?.command
        command = cmd
        if (typeof cmd !== "string" || !cmd) return
        const m = mode()
        if (m === "off") return
        const cwd = input.workdir ?? ctx.location?.directory ?? null
        let why: string | null = null
        if (LIVE.test(cmd) && READER.test(cmd)) why = "the command reads the live Robob database"
        else {
          for (const s of scriptsIn(cmd, cwd)) {
            if (scriptTouchesLive(s)) { why = `the script ${s} opens the live Robob database`; break }
          }
        }
        if (!why) return
        const deny = m === "enforce"
        decision = deny ? 'denied' : 'allowed'
        rule = 'live-database-read'
        if (deny) e.input = { ...input, command: denial(why), background: false }
      } catch (err) {
        errorTag = 'hook.error'
      } finally {
        if (typeof command === 'string') toolLogHook('statev2', decision, rule, started, command, errorTag, {sessionId:e.sessionID}, {cwd:e.input?.workdir ?? e.input?.cwd ?? ctx.location?.directory})
      }
    })
  },
}
