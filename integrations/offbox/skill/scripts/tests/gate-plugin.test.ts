// bun test: the gate plugin's shell hook. The plugin imports the classifier
// relative to ~/.config/opencode/plugin, so it is loaded from a temp copy laid
// out the same way.
import { afterAll, expect, mock, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = join(import.meta.dir, "..", "..", "..")
const root = mkdtempSync(join(tmpdir(), "offbox-gate-"))
mkdirSync(join(root, "plugin"))
mkdirSync(join(root, "skills/remote-compute/scripts"), { recursive: true })
copyFileSync(join(repo, "plugin/offbox-gate.ts"), join(root, "plugin/offbox-gate.ts"))
copyFileSync(join(repo, "skill/scripts/classify.ts"), join(root, "skills/remote-compute/scripts/classify.ts"))
copyFileSync(join(repo, "skill/heavy-rules.json"), join(root, "skills/remote-compute/heavy-rules.json"))
copyFileSync(join(repo, "skill/scripts/toollog.ts"), join(root, "skills/remote-compute/scripts/toollog.ts"))
process.env.OFFBOX_TOOL_LOG_DIR = join(root, "tool-logs")
process.env.OFFBOX_STATE_DIR = join(root, "state")
const fixtureClassifier = await import(join(root, "skills/remote-compute/scripts/classify.ts"))
fixtureClassifier.loadRules(join(root, "skills/remote-compute/heavy-rules.json"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function shellHook() {
  const { default: plugin } = await import(join(root, "plugin/offbox-gate.ts"))
  const hooks: Record<string, (e: any) => unknown> = {}
  const on = (name: string) => ({ hook: async (event: string, fn: any) => { hooks[`${name}:${event}`] = fn } })
  await plugin.setup({ tool: on("tool"), shell: on("shell"), session: on("session") })
  return hooks["shell:create.before"]
}

for (const mode of ["observe", "enforce", "off"]) {
  test(`shells get bun's inspector turned off (gate ${mode})`, async () => {
    process.env.OFFBOX_GATE_MODE = mode
    process.env.BUN_INSPECT = "ws://127.0.0.1:49398/oc-inspect"
    try {
      const hook = await shellHook()
      const e: any = { cwd: root }
      hook(e)
      expect(e.env.BUN_INSPECT).toBe("")
      expect(e.env.OFFBOX_GATE).toBe(mode === "off" ? undefined : "1")
    } finally {
      delete process.env.BUN_INSPECT
      delete process.env.OFFBOX_GATE_MODE
    }
  })
}

test("a server without BUN_INSPECT leaves it alone", async () => {
  process.env.OFFBOX_GATE_MODE = "observe"
  try {
    const hook = await shellHook()
    const e: any = { cwd: root, env: { PATH: "/usr/bin:/bin" } }
    hook(e)
    expect("BUN_INSPECT" in e.env).toBe(false)
  } finally {
    delete process.env.OFFBOX_GATE_MODE
  }
})

test("shared gate log records allowed decisions and classifier failures without command text", async () => {
  process.env.OFFBOX_GATE_MODE = "observe"
  const { default: plugin } = await import(join(root, "plugin/offbox-gate.ts"))
  const hooks: Record<string, (e: any) => unknown> = {}
  const on = (name: string) => ({ hook: async (event: string, fn: any) => { hooks[`${name}:${event}`] = fn } })
  await plugin.setup({ tool: on("tool"), shell: on("shell"), session: on("session") })
  await hooks["tool:execute.before"]({ tool: "shell", sessionID: "fixture", input: { command: "echo private-prompt-text" } })
  await hooks["tool:execute.before"]({ tool: "shell", input: { get command() { throw new Error("private-token-value") } } })
  const { readFileSync, readdirSync } = await import("node:fs")
  const folder = join(root, "tool-logs")
  const text = readdirSync(folder).filter(f => f.endsWith(".ndjson")).map(f => readFileSync(join(folder, f), "utf8")).join("")
  const lines = text.trim().split("\n").map(line => JSON.parse(line))
  expect(lines.some(line => line.name === "gate.decision" && line.ok && line.props.decision === "allowed")).toBe(true)
  expect(lines.some(line => line.name === "gate.decision" && !line.ok && line.error.tag === "gate_failed")).toBe(true)
  expect(text).not.toContain("private-prompt-text")
  expect(text).not.toContain("private-token-value")
})


test("a returned classifier error is recorded as an error, never as a light success", async () => {
  process.env.OFFBOX_GATE_MODE = "observe"
  mock.module(join(root, "skills/remote-compute/scripts/classify.ts"), () => ({
    classify: () => ({ heavy: false, error: "private-classifier-body" }), loadRules: () => {},
  }))
  const { default: plugin } = await import(join(root, "plugin/offbox-gate.ts"))
  const hooks: Record<string, (e: any) => unknown> = {}
  const on = (name: string) => ({ hook: async (event: string, fn: any) => { hooks[`${name}:${event}`] = fn } })
  await plugin.setup({ tool: on("tool"), shell: on("shell"), session: on("session") })
  await hooks["tool:execute.before"]({ tool: "shell", input: { command: "true" } })
  const { readFileSync, readdirSync } = await import("node:fs")
  const folder = join(root, "tool-logs")
  const raw = readdirSync(folder).filter(f => f.endsWith(".ndjson")).map(f => readFileSync(join(folder, f), "utf8")).join("")
  expect(JSON.parse(raw.trim().split("\n").at(-1)!)).toMatchObject({ name: "gate.decision", ok: false, error: { tag: "gate_failed" } })
  expect(raw).not.toContain("private-classifier-body")
})
