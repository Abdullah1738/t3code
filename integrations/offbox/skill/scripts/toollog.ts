// The OpenCode gate shares the Python logger's on-disk contract without spawning a process per decision.
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const days = new Set<string>()
const GATE_LIGHT_SAMPLE = 20
export function gateLog(decision: "allowed" | "denied" | "local-override", commandClass: string, durationMs: number, failed = false) {
  try {
    const sampled = !failed && decision === "allowed" && commandClass === "light"
    if (sampled && !(Math.random() < 1 / GATE_LIGHT_SAMPLE)) return
    const root = process.env.OFFBOX_TOOL_LOG_DIR ?? join(homedir(), ".robob/logs/tools/offbox")
    const now = new Date(), day = now.toISOString().slice(0, 10)
    mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
    const key = root + day
    if (!days.has(key)) {
      const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10)
      for (const file of readdirSync(root)) {
        const match = /^(?:rollup-)?(\d{4}-\d{2}-\d{2})\.(?:ndjson|json|cap)$/.exec(file)
        if (match && match[1] < cutoff) unlinkSync(join(root, file))
      }
      days.add(key)
    }
    const line = { ts: now.toISOString(), tool: "offbox", component: "gate", kind: failed ? "error" : "perf", name: "gate.decision",
      ok: !failed, durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
      props: { decision, harness: "opencode", commandClass: ["cargo", "evm", "go-build", "go-test", "gradle", "js-test", "lint", "make-test", "pytest", "typecheck", "light", "heavy", "test", "install", "build", "docker", "opaque", "cpu"].includes(commandClass) ? commandClass : "unknown",
        ...(sampled ? { sample: GATE_LIGHT_SAMPLE } : {}) },
      ...(failed ? { error: { tag: "gate_failed", message: "gate failed" } } : {}) }
    const fd = openSync(join(root, day + ".ndjson"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o600)
    try {
      fchmodSync(fd, 0o600)
      if (fstatSync(fd).size >= 50 * 1024 * 1024) {
        try {
          const marker = openSync(join(root, day + ".cap"), "wx", 0o600); closeSync(marker)
          writeSync(fd, JSON.stringify({ ts: line.ts, tool: "offbox", component: "gate", kind: "error", name: "log.cap", error: { tag: "log_cap", message: "daily log cap" } }) + "\n")
        } catch {}
        if (!failed) return
      }
      writeSync(fd, JSON.stringify(line) + "\n")
    } finally { closeSync(fd) }
  } catch {}
}
