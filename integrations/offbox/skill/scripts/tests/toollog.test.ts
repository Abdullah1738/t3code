import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gateLog } from "../toollog.ts"

const roots: string[] = []
const oldRoot = process.env.OFFBOX_TOOL_LOG_DIR
beforeEach(() => { spyOn(Math, "random").mockReturnValue(0) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "offbox-tool-log-")); roots.push(root)
  process.env.OFFBOX_TOOL_LOG_DIR = join(root, "logs")
  return process.env.OFFBOX_TOOL_LOG_DIR
}
afterEach(() => {
  mock.restore()
  if (oldRoot === undefined) delete process.env.OFFBOX_TOOL_LOG_DIR
  else process.env.OFFBOX_TOOL_LOG_DIR = oldRoot
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test.each([0, 0.049, 0.05, 0.99])("light allowed sampling at draw %s", draw => {
  const root = fixture()
  spyOn(Math, "random").mockReturnValue(draw)
  gateLog("allowed", "light", 1)
  if (draw >= 0.05) {
    expect(readdirSync(roots.at(-1)!)).toEqual([])
  } else {
    const row = JSON.parse(readFileSync(join(root, new Date().toISOString().slice(0, 10) + ".ndjson"), "utf8"))
    expect(row.props).toEqual({ decision: "allowed", harness: "opencode", commandClass: "light", sample: 20 })
  }
})

test("all other decisions bypass sampling", () => {
  const root = fixture()
  const random = spyOn(Math, "random").mockReturnValue(0.99)
  for (const [decision, commandClass, failed] of [
    ["allowed", "js-test", false], ["denied", "js-test", false], ["local-override", "js-test", false],
    ["denied", "light", false], ["local-override", "light", false], ["allowed", "light", true],
    ["allowed", "unknown", true], ["allowed", "unknown", false],
  ] as const) gateLog(decision, commandClass, 1, failed)
  const rows = readFileSync(join(root, new Date().toISOString().slice(0, 10) + ".ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  expect(rows).toHaveLength(8)
  expect(rows.every(row => !("sample" in row.props))).toBe(true)
  expect(rows.filter(row => row.kind === "error").map(row => row.error.tag)).toEqual(["gate_failed", "gate_failed"])
  expect(random).not.toHaveBeenCalled()
})

test("sampling errors never escape", () => {
  fixture()
  spyOn(Math, "random").mockImplementation(() => { throw new Error("fixture") })
  expect(() => gateLog("allowed", "light", 1)).not.toThrow()
})

test("gate format, private modes and allowlisted class", () => {
  const root = fixture()
  gateLog("allowed", "password=private-text", 1.5)
  const file = join(root, readdirSync(root).find(f => f.endsWith(".ndjson"))!)
  const raw = readFileSync(file, "utf8"), row = JSON.parse(raw)
  expect(row).toMatchObject({ tool: "offbox", name: "gate.decision", kind: "perf", durationMs: 1.5,
    props: { decision: "allowed", harness: "opencode", commandClass: "unknown" } })
  expect(raw).not.toContain("private-text")
  expect(statSync(root).mode & 0o777).toBe(0o700)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test("one cap marker, no further perf lines, errors survive", () => {
  const root = fixture()
  gateLog("allowed", "light", 0)
  const file = join(root, readdirSync(root).find(f => f.endsWith(".ndjson"))!)
  const cap = 50 * 1024 * 1024
  truncateSync(file, cap)
  gateLog("allowed", "light", 0)
  gateLog("allowed", "light", 0)
  gateLog("allowed", "unknown", 0, true)
  const fd = openSync(file, "r"), bytes = Buffer.alloc(statSync(file).size - cap)
  try { readSync(fd, bytes, 0, bytes.length, cap) } finally { closeSync(fd) }
  expect(bytes.toString().trim().split("\n").map(s => JSON.parse(s).name)).toEqual(["log.cap", "gate.decision"])
})

test("a failed log write never escapes", () => {
  const root = fixture()
  writeFileSync(root, "not a directory")
  expect(() => gateLog("allowed", "light", 1)).not.toThrow()
})

test("retention removes old day files but preserves other files", () => {
  const root = fixture(); mkdirSync(root)
  writeFileSync(join(root, "2000-01-01.ndjson"), "")
  writeFileSync(join(root, "2000-01-01.cap"), "")
  writeFileSync(join(root, "unrelated"), "")
  gateLog("allowed", "light", 1)
  expect(readdirSync(root)).toContain("unrelated")
  expect(readdirSync(root)).not.toContain("2000-01-01.ndjson")
  expect(readdirSync(root)).not.toContain("2000-01-01.cap")
})
