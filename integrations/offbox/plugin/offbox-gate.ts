// offbox gate (worker C, 2026-10-13). Heavy agent compute (test suites,
// installs, local containers) runs on boat.dev boxes through `offbox run --`.
// Every shell tool call is classified with remote-compute/heavy-rules.json.
//   observe: allow, append a line to ~/.local/share/offbox/gate.jsonl
//   enforce: heavy + not exempt + offbox usable -> the call is rewritten to a
//            short script that prints the reason and exits 3 (the agent sees
//            the message as the command output and retries via offbox).
// Mode comes from ~/.config/opencode/offbox-gate.json (mtime-cached, so a flip
// needs no restart). OFFBOX_GATE_MODE in the server env overrides it (tests).
// The shell create hook puts remote-compute/scripts/blockers first on PATH
// (docker shim) and exports OFFBOX_GATE=1. Fails open on every error.
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { classify, loadRules } from "../skills/remote-compute/scripts/classify.ts"

const HOME = homedir()
const SKILL = join(HOME, ".config/opencode/skills/remote-compute")
const RULES = join(SKILL, "heavy-rules.json")
const BLOCKERS = join(SKILL, "scripts/blockers")
const GATE_CFG = process.env.OFFBOX_GATE_CONFIG ?? join(HOME, ".config/opencode/offbox-gate.json")
const STATE = process.env.OFFBOX_STATE_DIR ?? join(HOME, ".local/share/offbox")
const LOG = join(STATE, "gate.jsonl")
const EXEMPT = join(STATE, "exemptions.json")
const CAP = join(STATE, "cap.json")
const OFFBOX_BIN = [join(HOME, ".local/bin/offbox"), join(SKILL, "scripts/offbox.py")]
const SHELL_TOOLS = new Set(["shell", "bash"])
const CONTEXT_LINE = "Heavy tests/installs/docker: run via `offbox run -- <cmd>` (remote-compute skill)."

type Cached<T> = { mtime: number; value: T; checked: number }
const cache = new Map<string, Cached<any>>()

// stat at most every 500 ms per file; re-read only when mtime changes
function cachedJson<T>(path: string, fallback: T, now = Date.now()): T {
  const c = cache.get(path)
  if (c && now - c.checked < 500) return c.value
  let mtime = -1
  try { mtime = statSync(path).mtimeMs } catch {}
  if (c && c.mtime === mtime) { c.checked = now; return c.value }
  let value = fallback
  if (mtime >= 0) {
    try { value = JSON.parse(readFileSync(path, "utf8")) } catch { value = c?.value ?? fallback }
  }
  cache.set(path, { mtime, value, checked: now })
  return value
}

let rulesMtime = -1
function ensureRules() {
  let m = -1
  try { m = statSync(RULES).mtimeMs } catch {}
  if (m !== rulesMtime) { loadRules(RULES); rulesMtime = m }
}

function mode(): "observe" | "enforce" | "off" {
  const env = process.env.OFFBOX_GATE_MODE
  if (env === "observe" || env === "enforce" || env === "off") return env
  const m = cachedJson<any>(GATE_CFG, { mode: "observe" })?.mode
  return m === "enforce" || m === "off" ? m : "observe"
}

function exempt(ids: string[]): any | null {
  const list = cachedJson<any[]>(EXEMPT, [])
  if (!Array.isArray(list)) return null
  const now = Date.now()
  for (const e of list) {
    if (!e || !ids.includes(e.session_id)) continue
    const exp = e.expires_at ? Date.parse(e.expires_at) || Number(e.expires_at) * 1000 : Infinity
    if (exp > now) return e
  }
  return null
}

let offboxSeen = { at: 0, ok: false }
function offboxAvailable(): boolean {
  const now = Date.now()
  if (now - offboxSeen.at < 30_000) return offboxSeen.ok
  let ok = false
  for (const p of OFFBOX_BIN) { try { statSync(p); ok = true; break } catch {} }
  offboxSeen = { at: now, ok }
  return ok
}

function capped(): boolean {
  return cachedJson<any>(CAP, {})?.capped === true
}

function log(rec: Record<string, unknown>) {
  try {
    mkdirSync(STATE, { recursive: true })
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n")
  } catch {}
}

let shellHookSeen = 0
const parents = new Map<string, string | null>()
async function parentOf(ctx: any, sessionID: string): Promise<string | null> {
  if (parents.has(sessionID)) return parents.get(sessionID)!
  let p: string | null = null
  try {
    const s: any = await Promise.race([
      ctx.session.get({ sessionID }),
      new Promise((_r, rej) => setTimeout(() => rej(new Error("timeout")), 250)),
    ])
    p = (s?.data ?? s)?.parentID ?? null
  } catch {}
  parents.set(sessionID, p)
  if (parents.size > 5000) parents.delete(parents.keys().next().value!)
  return p
}

const shq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`

function denial(cmd: string, v: any): string {
  const lines = [
    "offbox gate: this command was NOT run on the Mac (owner rule 2026-10-13, remote-compute skill).",
    `Why: ${v.why} [rule ${v.rule}].`,
    "Run it on a boat.dev box instead (same repo dir, output streams back, same exit code):",
    `  ${v.rewrite}`,
    "Narrow single tests stay local (go test -run X ./pkg, jest path/file.test.ts, pytest path::test).",
    'Only if it truly must run here (e.g. needs local creds/devices): offbox local --reason "<why>" [--ttl 2h], then rerun.',
  ]
  return `printf '%s\\n' ${lines.map(shq).join(" ")} >&2; exit 3`
}

export default {
  id: "offbox-gate",
  setup: async (ctx: any) => {
    try { ensureRules() } catch (e) { log({ event: "rules-load-error", error: String(e) }) }

    await ctx.tool.hook("execute.before", async (e: any) => {
      try {
        if (!SHELL_TOOLS.has(e.tool)) return
        const input = e.input as any
        const cmd = input?.command
        if (typeof cmd !== "string" || !cmd) return
        const m = mode()
        if (m === "off") return
        const t0 = performance.now()
        ensureRules()
        const v = classify(cmd, input.workdir ?? ctx.location?.directory ?? null)
        const ms = +(performance.now() - t0).toFixed(3)
        if (v.error) log({ event: "classify-error", session: e.sessionID, error: v.error })
        if (!v.heavy) return
        const ids = [e.sessionID]
        let ex = exempt(ids)
        if (!ex && m === "enforce") {
          const p = await parentOf(ctx, e.sessionID)
          if (p) { ids.push(p); ex = exempt(ids) }
        }
        const reason = ex ? "exempt" : !offboxAvailable() ? "no-offbox" : capped() ? "capped" : null
        const deny = m === "enforce" && !reason
        log({
          event: deny ? "deny" : "allow", mode: m, session: e.sessionID, rule: v.rule, class: v.class, size: v.size,
          would_deny: !ex, allow_reason: reason, cmd_hash: createHash("sha1").update(cmd).digest("hex").slice(0, 12),
          cmd: cmd.slice(0, 300), cwd: input.workdir ?? null, ms,
        })
        if (deny) e.input = { ...input, command: denial(cmd, v), background: false }
      } catch (err) {
        log({ event: "hook-error", session: e?.sessionID, error: String(err) })
      }
    })

    await ctx.shell.hook("create.before", (e: any) => {
      try {
        if (mode() === "off") return
        // OPENCODE_SESSION_ID is set by the shell tool after this hook runs, so it
        // can't be checked here; the shim itself passes through without it.
        const env = e.env ?? (e.env = {})
        if (process.env.OFFBOX_GATE_DEBUG || shellHookSeen++ < 3) log({ event: "shell-hook", cwd: e.cwd, has_env: !!e.env, keys: Object.keys(e) })
        const path = env.PATH ?? process.env.PATH ?? "/usr/bin:/bin"
        if (!path.split(":").includes(BLOCKERS)) env.PATH = `${BLOCKERS}:${path}`
        env.OFFBOX_GATE = "1"
      } catch (err) {
        log({ event: "shell-hook-error", error: String(err) })
      }
    })

    await ctx.session.hook("context", (e: any) => {
      try {
        if (mode() === "off") return
        const t = e.tools?.shell ?? e.tools?.bash
        if (t && typeof t.description === "string" && !t.description.includes("offbox run")) t.description += " " + CONTEXT_LINE
      } catch {}
    })
  },
}
