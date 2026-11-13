// bun test: the TS classifier must pass the same vectors as classify.py,
// and agree with it on a corpus of real commands when one is provided
// (OFFBOX_PARITY=<jsonl of {cmd,cwd,v}> written by classify.py --batch).
import { expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { classify, loadRules } from "../classify.ts"

const RULES = process.env.OFFBOX_RULES || join(import.meta.dir, "..", "..", "heavy-rules.json")
const FIXTURES = join(import.meta.dir, "fixtures")
const spec = loadRules(RULES)
const vcwd = (v: any) => (v.cwd ? v.cwd.replace("$FIXTURES", FIXTURES) : null)

test("embedded vectors", () => {
  const failures: string[] = []
  for (const v of spec.vectors) {
    const r = classify(v.cmd, vcwd(v))
    let ok = r.heavy === v.heavy && (!v.heavy || !v.rule || r.rule === v.rule)
    if (v.rewrite !== undefined) ok = ok && r.rewrite === v.rewrite
    if (v.why !== undefined) ok = ok && r.why === v.why
    if (!ok) failures.push(`${JSON.stringify(v)} -> ${JSON.stringify(r)}`)
  }
  if (failures.length) console.log(failures.join("\n"))
  expect(failures.length).toBe(0)
  console.log(`${spec.vectors.length}/${spec.vectors.length} vectors pass (ts)`)
})

test("Python and TypeScript agree on verdicts, reasons and rewrites for every vector", () => {
  const rows = spec.vectors.map((v: any) => ({ cmd: v.cmd, cwd: vcwd(v) }))
  const py = spawnSync("/usr/bin/python3", [join(import.meta.dir, "..", "classify.py"), "--batch"], {
    input: rows.map((r: any) => JSON.stringify(r)).join("\n") + "\n", encoding: "utf8",
  })
  expect(py.status).toBe(0)
  const verdicts = py.stdout.trim().split("\n").map((line) => JSON.parse(line))
  expect(verdicts.length).toBe(rows.length)
  for (let i = 0; i < rows.length; i++) expect(classify(rows[i].cmd, rows[i].cwd)).toEqual(verdicts[i])
})

test("gate refusal names the glob or file count and says nothing ran", async () => {
  // The plugin's deployed import is relative to the OpenCode config tree.
  const root = mkdtempSync(join(tmpdir(), "offbox-denial-"))
  try {
    mkdirSync(join(root, "plugin"))
    mkdirSync(join(root, "skills/remote-compute/scripts"), { recursive: true })
    copyFileSync(join(import.meta.dir, "../../../plugin/offbox-gate.ts"), join(root, "plugin/offbox-gate.ts"))
    copyFileSync(join(import.meta.dir, "../toollog.ts"), join(root, "skills/remote-compute/scripts/toollog.ts"))
    copyFileSync(join(import.meta.dir, "../classify.ts"), join(root, "skills/remote-compute/scripts/classify.ts"))
    const { denial } = await import(join(root, "plugin/offbox-gate.ts"))
    for (const [cmd, why] of [
      ["pytest tests/*.py", 'glob or expansion in positional "tests/*.py"; name test files explicitly'],
      ["jest a.test.ts b.test.ts c.test.ts d.test.ts", "names 4 test files; up to 3 run on this Mac"],
    ]) {
      const v = classify(cmd)
      const refusal = spawnSync("/bin/sh", ["-c", denial(cmd, v)], { encoding: "utf8" })
      expect(refusal.status).toBe(3)
      expect(refusal.stderr).toContain(`Why: ${why} [rule ${v.rule}].`)
      expect(refusal.stderr).toContain("Nothing in the refused command ran.")
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("fails open on garbage", () => {
  expect(classify("'unterminated \"$( ((( `", "/tmp").heavy).toBeBoolean()
  expect(classify("", null).heavy).toBe(false)
})

test("speed: under 2 ms per call", () => {
  const cmds = spec.vectors.map((v: any) => v.cmd)
  const t0 = performance.now()
  let n = 0
  for (let k = 0; k < 20; k++) for (const c of cmds) { classify(c, "/Volumes/ExternalSSD/coord-wt/x"); n++ }
  const per = (performance.now() - t0) / n
  console.log(`ts classify: ${per.toFixed(3)} ms/call over ${n} calls`)
  expect(per).toBeLessThan(2)
})

const parity = process.env.OFFBOX_PARITY
test.skipIf(!parity || !existsSync(parity))("parity with classify.py on real commands", () => {
  const lines = readFileSync(parity!, "utf8").split("\n").filter(Boolean)
  const diffs: string[] = []
  for (const l of lines) {
    const d = JSON.parse(l)
    const r = classify(d.cmd, d.cwd ?? null)
    const p = d.v
    if (r.heavy !== p.heavy || r.rule !== p.rule || r.rewrite !== p.rewrite || r.why !== p.why)
      diffs.push(`${JSON.stringify(d.cmd).slice(0, 200)}\n   py=${JSON.stringify(p)}\n   ts=${JSON.stringify(r)}`)
  }
  console.log(`parity: ${lines.length - diffs.length}/${lines.length} identical`)
  if (diffs.length) console.log(diffs.slice(0, 15).join("\n"))
  expect(diffs.length).toBe(0)
}, 600_000)
