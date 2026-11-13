// bun test: the gate plugin's shell hook. The plugin imports the classifier
// relative to ~/.config/opencode/plugin, so it is loaded from a temp copy laid
// out the same way.
import { afterAll, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { join } from "node:path"

const repo = join(import.meta.dir, "..", "..", "..")
const root = mkdtempSync(join(tmpdir(), "offbox-gate-"))
mkdirSync(join(root, "plugin"))
mkdirSync(join(root, "lib"))
copyFileSync(join(repo, "lib/toollog.ts"), join(root, "lib/toollog.ts"))
mkdirSync(join(root, "skills/remote-compute/scripts"), { recursive: true })
copyFileSync(join(repo, "plugin/offbox-gate.ts"), join(root, "plugin/offbox-gate.ts"))
copyFileSync(join(repo, "skill/scripts/classify.ts"), join(root, "skills/remote-compute/scripts/classify.ts"))
const fixtureHome = join(root, 'home')
mkdirSync(join(fixtureHome, '.config/opencode/skills/remote-compute'), {recursive:true})
copyFileSync(join(repo, 'skill/heavy-rules.json'), join(fixtureHome, '.config/opencode/skills/remote-compute/heavy-rules.json'))
mkdirSync(join(fixtureHome, '.local/bin'), {recursive:true})
writeFileSync(join(fixtureHome, '.local/bin/offbox'), 'fixture')
process.env.OFFBOX_STATE_DIR = join(root, "state")
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function registeredHooks() {
  const {default: plugin} = await import(join(root, "plugin/offbox-gate.ts"))
  const hooks: Record<string, (e: any) => unknown> = {}
  const on = (name: string) => ({ hook: async (event: string, fn: any) => { hooks[`${name}:${event}`] = fn } })
  await plugin.setup({ tool: on("tool"), shell: on("shell"), session: {...on("session"), get:async()=>null} })
  return hooks
}

async function shellHook() { return (await registeredHooks())["shell:create.before"] }

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

test('offbox decisions log both allowed and denied without command arguments', () => {
  const script = `
    const {default:plugin} = await import(${JSON.stringify(join(root,'plugin/offbox-gate.ts'))});
    for (const mode of ['observe','enforce']) {
      process.env.OFFBOX_GATE_MODE=mode;
      let before;
      await plugin.setup({tool:{hook:async(_,fn)=>{before=fn}},shell:{hook:async()=>{}},session:{hook:async()=>{},get:async()=>null}});
      await before({tool:'shell',sessionID:'fixture-session',input:{command:'go test ./... -run FixtureSecretArgument',workdir:${JSON.stringify(root)}}});
    }
  `
  const result = spawnSync(process.execPath, ['-e', script], {encoding:'utf8',env:{...process.env,HOME:fixtureHome,TOOLLOG_ROOT:join(root,'logs')}})
  expect(result.status).toBe(0)
  const lines=readFileSync(join(root,'logs/agent-tools',new Date().toISOString().slice(0,10)+'.ndjson'),'utf8')
  const rows=lines.trim().split('\n').map(line=>JSON.parse(line))
  expect(rows.filter(row=>row.props?.guard==='offbox-gate').map(row=>row.props.decision)).toEqual(['allowed','denied'])
  expect(lines).not.toContain('FixtureSecretArgument')
})
