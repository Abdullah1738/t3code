// bun test: the gate plugin's shell hook. The plugin imports the classifier
// relative to ~/.config/opencode/plugin, so it is loaded from a temp copy laid
// out the same way.
import { afterAll, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = join(import.meta.dir, "..", "..", "..")
const root = mkdtempSync(join(tmpdir(), "offbox-gate-"))
mkdirSync(join(root, "plugin"))
mkdirSync(join(root, "skills/remote-compute/scripts"), { recursive: true })
copyFileSync(join(repo, "plugin/offbox-gate.ts"), join(root, "plugin/offbox-gate.ts"))
copyFileSync(join(repo, "skill/scripts/classify.ts"), join(root, "skills/remote-compute/scripts/classify.ts"))
process.env.OFFBOX_STATE_DIR = join(root, "state")
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
