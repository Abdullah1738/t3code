import { afterEach, describe, expect, test } from "bun:test"
import { createRecallPlugin } from "./recall"
import { fileURLToPath } from "node:url"

const note = "<recall>\nHistorical fixture: use main-dev [fixture#e1]\n</recall>"
const sources = [{ session_id: "fixture", event_id: 1 }]
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())) })

function harness(options: { store?: Map<string, unknown>; child?: boolean; old?: boolean; delay?: number; cited?: boolean; engineURL?: string } = {}) {
  const hooks = new Map<string, (e: any) => Promise<void>>()
  const store = options.store ?? new Map<string, unknown>()
  const requests: any[] = []
  const recallRuns: any[] = []
  const engineResults: any[] = []
  let mode = "on"
  const ctx = {
    session: {
      async get({ sessionID }: { sessionID: string }) { return { id: sessionID, parentID: options.child ? "parent" : undefined,
        outcome: options.old ? "succeeded" : undefined, time: {}, location: { directory: options.engineURL ? "/Users/test/trading-core" : "/fixture/trading-core" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } },
      async hook(name: string, callback: any) { hooks.set(name, callback); return { async dispose() { hooks.delete(name) } } },
    },
    tool: { async hook(name: string, callback: any) { hooks.set(name, callback); return { async dispose() { hooks.delete(name) } } } },
    storage: { async get(key: string) { return store.get(key) }, async set(key: string, value: any) { store.set(key, structuredClone(value)) } },
    event: { async *subscribe() {} },
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(new URL(req.url).pathname).toBe("/api/check")
    const body: any = await req.json(); requests.push(body)
    if (options.engineURL) {
      const response = await fetch(options.engineURL + "/api/check", { method: "POST", body: JSON.stringify(body), signal: req.signal })
      const result = await response.json()
      engineResults.push(result)
      return Response.json(result)
    }
    if (body.arguments?.command !== "git status") recallRuns.push(body)
    if (options.delay) await Bun.sleep(options.delay)
    const deny = body.trigger === "tool" && body.arguments.command === "git push origin HEAD:main"
    return Response.json({ decision: deny ? "deny" : "allow", reason: deny ? "Push trading-core to main-dev, never main" : "",
      note: deny || body.trigger !== "tool" ? note : null, sources: options.cited === false ? [] : sources })
  } })
  cleanups.push(async () => { server.stop(true) })
  const plugin = createRecallPlugin({ config: async () => ({ mode, url: `http://127.0.0.1:${server.port}` }), log: () => {} })
  const setup = async () => { const stop = await plugin.setup(ctx); cleanups.push(stop); return stop }
  const context = (text = "Investigate deployment", id = "first") => ({ sessionID: "fixture", messages: [{ id, role: "user", content: [{ type: "text", text }, { type: "media", media: { fixture: true } }] }] })
  const tool = (command: string) => ({ sessionID: "fixture", id: command, messageID: "assistant1", tool: "shell", input: { command } })
  return { hooks, store, requests, recallRuns, engineResults, setup, context, tool, ctx, mode: (value: string) => { mode = value } }
}

describe("recall V2 thin adapter", () => {
  test("real pre-tool adapter denies cited main and allows main-dev; status never runs recall", async () => {
    const h = harness(); await h.setup()
    const before = h.hooks.get("execute.before")!
    await expect(before(h.tool("git push origin HEAD:main"))).rejects.toThrow("main-dev")
    await before(h.tool("git push origin HEAD:main-dev"))
    const count = h.recallRuns.length
    await before(h.tool("git status"))
    expect(h.recallRuns.length).toBe(count)
    expect(h.requests[0].tool_call_id).toBe("git push origin HEAD:main")
    expect(h.requests[0].request_id).toBeTruthy()
  })

  test("uncited deny is advisory, not a block", async () => {
    const h = harness({ cited: false }); await h.setup()
    await h.hooks.get("execute.before")!(h.tool("git push origin HEAD:main"))
  })

  async function acceptanceEngine(rulePreflight: boolean) {
    const env: Record<string, string | undefined> = { ...process.env, RECALL_RULE_PREFLIGHT: rulePreflight ? "1" : "" }
    const engine = Bun.spawn(["python3", fileURLToPath(new URL("../tests/acceptance_engine.py", import.meta.url)), "--serve"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env })
    cleanups.push(async () => { engine.kill(); await engine.exited })
    const reader = engine.stdout.getReader()
    let line = ""
    while (!line.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(await new Response(engine.stderr).text())
      line += new TextDecoder().decode(chunk.value)
    }
    return JSON.parse(line).url as string
  }

  test("by default the shared engine never blocks or adds rule notes (rule index off)", async () => {
    const h = harness({ engineURL: await acceptanceEngine(false) }); await h.setup()
    await h.hooks.get("execute.before")!(h.tool("git push origin HEAD:main"))
    expect(h.engineResults[0].decision).toBe("allow")
    expect(h.engineResults[0].note).toBeNull()
  })

  test("source-derived rules flow through shared engine to real OpenCode pre-tool adapter (RECALL_RULE_PREFLIGHT=1)", async () => {
    const h = harness({ engineURL: await acceptanceEngine(true) }); await h.setup()
    const before = h.hooks.get("execute.before")!
    await expect(before(h.tool("git push origin HEAD:main"))).rejects.toThrow("push to main-dev")
    expect(h.engineResults[0].sources.length).toBeGreaterThan(0)
    expect(h.engineResults[0].reason).toContain("SKILL.md#L7")
    await before(h.tool("git push origin HEAD:main-dev"))
    await before(h.tool("git status"))
    expect(h.engineResults.at(-1).decision).toBe("allow")
    expect(h.engineResults.at(-1).recall_ran).toBe(false)
  })

  test("first prompt checks once across turns and reload; transient note preserves media", async () => {
    const h = harness(); const stop = await h.setup()
    const event = h.context(); const original = structuredClone(event.messages[0])
    await h.hooks.get("context")!(event)
    expect(event.messages[0]).toEqual(original)
    expect(event.messages[1].content[0].text).toBe(note)
    await h.hooks.get("context")!(event)
    expect(event.messages.length).toBe(2)
    const later = h.context("Another task", "second")
    await h.hooks.get("context")!(later)
    expect(h.requests.length).toBe(1)
    await stop()
    const reloaded = harness({ store: h.store }); await reloaded.setup()
    await reloaded.hooks.get("context")!(reloaded.context("Another task", "second"))
    expect(reloaded.requests.length).toBe(0)
  })

  test("old/child/board first prompts skip, but their outward tools remain checked", async () => {
    for (const options of [{ old: true }, { child: true }, {}]) {
      const h = harness(options); await h.setup()
      await h.hooks.get("context")!(h.context('You are the reviewer for a card on the "Fixture" Missions board.'))
      expect(h.requests.length).toBe(0)
      await expect(h.hooks.get("execute.before")!(h.tool("git push origin HEAD:main"))).rejects.toThrow("main-dev")
    }
  })

  test("each compaction checks at next context, never periodic work", async () => {
    const h = harness(); await h.setup()
    const event = h.context()
    await h.hooks.get("context")!(event)
    for (let i = 0; i < 2; i++) {
      await h.hooks.get("compaction")!({ sessionID: "fixture", messages: event.messages })
      const after = h.context("Summary", `summary${i}`)
      await h.hooks.get("context")!(after)
      await h.hooks.get("context")!(after)
    }
    expect(h.requests.map(r => r.trigger)).toEqual(["first_prompt", "compaction", "compaction"])
    expect(h.requests[1].compaction_id).not.toBe(h.requests[2].compaction_id)
    for (let i = 0; i < 12; i++) await h.hooks.get("context")!(event)
    expect(h.requests.length).toBe(3)
  })

  test("first timeout returns within budget, latches failure, ignores late note", async () => {
    const h = harness({ delay: 700 }); await h.setup()
    const event = h.context(); const start = performance.now()
    await h.hooks.get("context")!(event)
    expect(performance.now() - start).toBeLessThan(650)
    expect(event.messages.length).toBe(1)
    await Bun.sleep(250)
    await h.hooks.get("context")!(event)
    expect(event.messages.length).toBe(1)
    expect(h.requests.length).toBe(1)
  })

  test("off mode and storage failure fail open without requests", async () => {
    const h = harness(); h.ctx.storage.get = async () => { throw new Error("fixture") }; await h.setup()
    await h.hooks.get("context")!(h.context())
    expect(h.requests.length).toBe(0)
    h.mode("off")
    await h.hooks.get("execute.before")!(h.tool("git push origin HEAD:main"))
    expect(h.requests.length).toBe(0)
  })

  test("read/edit/generic code-mode tools all reach shared classifier", async () => {
    const h = harness(); await h.setup()
    for (const tool of ["read", "edit", "glob", "grep", "functions.execute", "mcp__generic__execute"]) await h.hooks.get("execute.before")!({ ...h.tool("git status"), tool })
    expect(h.requests.map(r => r.tool)).toEqual(["read", "edit", "glob", "grep", "functions.execute", "mcp__generic__execute"])
  })

  test("tool notes are not evicted after eight calls and appear after tool results", async () => {
    const h = harness(); await h.setup()
    h.store.set("checks/v3/fixture", { first: true, compact: null, pendingCompact: null,
      notes: Array.from({ length: 12 }, (_, i) => ({ note: `rule ${i}`, anchor: "assistant1" })) })
    const event: any = { sessionID: "fixture", messages: [
      { id: "assistant1", role: "assistant", content: [] },
      { id: "result1", role: "tool", content: [{ type: "text", text: "result" }] },
    ] }
    await h.hooks.get("context")!(event)
    expect(event.messages[1].role).toBe("tool")
    expect(event.messages.filter((m: any) => m.id.startsWith("recall_")).length).toBe(12)
  })
})
