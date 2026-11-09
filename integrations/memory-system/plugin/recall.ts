import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { createHash, randomUUID } from "node:crypto"

type Part = { type: string; text?: string; [key: string]: unknown }
type Message = { id?: string; role: string; content: readonly Part[]; [key: string]: unknown }
type Event = { sessionID: string; messages: Message[] }
type ToolEvent = { sessionID: string; tool: string; input: unknown; id: string; messageID: string }
type Info = { id: string; parentID?: string; fork?: unknown; outcome?: string; time: { idle?: number }; location: { directory: string }; tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }
type Registration = { dispose(): Promise<void> }
type JsonRecord = { [key: string]: unknown }
type Context = {
  session: { get(input: { sessionID: string }, options?: { signal: AbortSignal }): Promise<Info>; hook(name: "context" | "compaction", fn: (event: Event) => Promise<void>): Promise<Registration> }
  tool: { hook(name: "execute.before", fn: (event: ToolEvent) => Promise<void>): Promise<Registration> }
  event: { subscribe(options: { types: string[]; signal: AbortSignal }): AsyncIterable<{ id: string; type: string; data: { sessionID: string } }> }
  storage: { get(key: string): Promise<unknown>; set(key: string, value: JsonRecord): Promise<void> }
}
type Config = { mode: "on" | "observe" | "off"; url: string; dirs: string[] }
type Result = { decision: "allow" | "deny"; reason: string; note: string | null; sources: unknown[] }
type Saved = { first: boolean; compact: string | null; pendingCompact: string | null; notes: Array<{ note: string; anchor: string }> }
type Dependencies = { config?: () => Promise<unknown>; fetch?: typeof fetch; log?: (entry: JsonRecord) => void }
const object = (v: unknown): v is JsonRecord => v !== null && typeof v === "object" && !Array.isArray(v)
const SKIP = ["# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<permissions instructions>", "<turn_aborted>", "[Compressed conversation section]", "<shell id=", "<system-update>", "<skill_content", "<recall>", "<subagent sessionID=", "<dcp-system-reminder>", "You are a subagent spawned by another session", "This session is being continued from a previous conversation", "You are the worker for a card on the \"", "You are the reviewer for a card on the \"", "You are an evaluator on the \"", "[coord]", "[crw]", "[master hourly", "cell-triage", "[offbox]", "[Watcher event from robob-watch"]

function configuration(value: unknown): Config {
  const v = object(value) ? value : {}
  return { mode: v.mode === "off" || v.mode === "observe" ? v.mode : v.mode === "on" || v.mode === undefined ? "on" : "off",
    url: typeof v.url === "string" ? v.url : "http://127.0.0.1:18765",
    dirs: Array.isArray(v.only_dirs) ? v.only_dirs.filter((d): d is string => typeof d === "string" && d.startsWith("/")) : [] }
}

async function readConfig(): Promise<unknown> {
  try { return JSON.parse(await readFile(process.env.RECALL_PLUGIN_CONFIG ?? join(homedir(), ".config/opencode/recall.json"), "utf8")) }
  catch (e) { return object(e) && e.code === "ENOENT" ? {} : { mode: "off" } }
}

function log(entry: JsonRecord) {
  const path = process.env.RECALL_PLUGIN_LOG ?? join(homedir(), ".local/share/memory-system/logs/recall-plugin.jsonl")
  void mkdir(dirname(path), { recursive: true, mode: 0o700 }).then(() => appendFile(path,
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 })).catch(() => {})
}

function endpoint(origin: string): string | null {
  try { const u = new URL(origin); return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/" && u.port !== "0" ? `${u.origin}/api/check` : null }
  catch { return null }
}
const within = (dir: string, root: string) => dir === root || dir.startsWith(root.replace(/\/+$/, "") + "/")
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24)
function text(m: Message): string { return m.content.filter(p => p.type === "text" && typeof p.text === "string" && !p.text.startsWith("<recall>")).map(p => p.text).join("\n").trim() }
function first(event: Event, info: Info): Message | null {
  const t = info.tokens
  if (info.parentID || info.fork || info.outcome || info.time?.idle !== undefined || !t || !t.cache || ![t.input, t.output, t.reasoning, t.cache.read, t.cache.write].every(n => n === 0)) return null
  if (event.messages.some(m => m.role === "assistant" || m.role === "tool" || m.content.some(p => p.type === "compaction" || /^\[Compressed conversation section\]|^This session is being continued/.test(p.text ?? "")))) return null
  const users = event.messages.filter(m => m.role === "user" && !m.id?.startsWith("msg_dcp_"))
  return users.length === 1 && users[0].id && text(users[0]) && !SKIP.some(p => text(users[0]).startsWith(p)) ? users[0] : null
}

function decoded(value: unknown): Result | null {
  if (!object(value) || !["allow", "deny"].includes(String(value.decision)) || !Array.isArray(value.sources)) return null
  const note = typeof value.note === "string" ? value.note : null
  return { decision: value.decision as Result["decision"], reason: typeof value.reason === "string" ? value.reason : "", note, sources: value.sources }
}
const cited = (sources: unknown[]) => sources.some(s => typeof s === "string" && !!s.trim() || object(s) && [s.citation, s.source, s.session_id].some(v => typeof v === "string" && !!v.trim()))

export function createRecallPlugin(deps: Dependencies = {}) {
  const loadConfig = deps.config ?? readConfig
  const request = deps.fetch ?? fetch
  const record = deps.log ?? log
  return { id: "recall", async setup(ctx: Context) {
    const active = new Set<AbortController>()
    const locks = new Map<string, Promise<unknown>>()
    const infos = new Map<string, Info>()
    const pendingNotes = new Map<string, Saved["notes"]>()
    let disposed = false
    const key = (sid: string) => `checks/v3/${sid}`
    const save = (sid: string, state: Saved) => ctx.storage.set(key(sid), state)
    const load = async (sid: string): Promise<Saved> => {
      const v = await ctx.storage.get(key(sid))
      return object(v) ? { first: v.first === true, compact: typeof v.compact === "string" ? v.compact : null, pendingCompact: typeof v.pendingCompact === "string" ? v.pendingCompact : null,
        notes: Array.isArray(v.notes) ? v.notes.filter((n): n is { note: string; anchor: string } => object(n) && typeof n.note === "string" && typeof n.anchor === "string") : [] } : { first: false, compact: null, pendingCompact: null, notes: [] }
    }
    async function bounded<T>(ms: number, fn: (signal: AbortSignal, alive: () => boolean) => Promise<T>): Promise<T | undefined> {
      const ctl = new AbortController(); active.add(ctl)
      const end = Date.now() + ms
      let timer: ReturnType<typeof setTimeout> | undefined
      const alive = () => !disposed && !ctl.signal.aborted && Date.now() < end
      const expired = new Promise<undefined>(resolve => { timer = setTimeout(() => { record({ event: "deadline", budget_ms: ms }); ctl.abort(); resolve(undefined) }, ms) })
      try { return await Promise.race([fn(ctl.signal, alive).catch(() => undefined), expired]) }
      finally { if (timer) clearTimeout(timer); ctl.abort(); active.delete(ctl) }
    }
    async function info(sid: string, signal: AbortSignal): Promise<Info> {
      const known = infos.get(sid)
      if (known) return known
      const value = await ctx.session.get({ sessionID: sid }, { signal })
      if (value.id !== sid || !value.location?.directory) throw new Error("unknown session")
      if (infos.size >= 512) infos.delete(infos.keys().next().value!)
      infos.set(sid, value)
      return value
    }
    async function check(c: Config, body: JsonRecord, signal: AbortSignal): Promise<Result | null> {
      const url = endpoint(c.url)
      if (!url) return null
      const started = Date.now()
      const response = await request(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal })
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 1048576) return null
      if (!response.body) return null
      const reader = response.body.getReader()
      let bodyText = "", size = 0
      const decoder = new TextDecoder()
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.length
          if (size > 1048576) return null
          bodyText += decoder.decode(part.value, { stream: true })
        }
        const value: unknown = JSON.parse(bodyText + decoder.decode())
        const result = decoded(value)
        record({ trigger: body.trigger, tool: body.tool, decision: result?.decision ?? "invalid", ms: Date.now() - started, note: !!result?.note,
          p: object(value) ? value.p : null, cost: object(value) ? value.cost : null, recall_ran: object(value) ? value.recall_ran : false,
          sources: result?.decision === "deny" ? result.sources : [] })
        return result
      } finally { void reader.cancel().catch(() => {}) }
    }
    const serial = async (sid: string, fn: () => Promise<void>) => {
      if (locks.size >= 512 && !locks.has(sid)) return
      // No queue behind hung storage. A later hook can read the durable state when this finishes.
      if (locks.has(sid)) return
      const current = Promise.resolve().then(fn)
      locks.set(sid, current)
      try { await current } finally { if (locks.get(sid) === current) locks.delete(sid) }
    }
    const events = new AbortController()
    const eventLoop = (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.compaction.failed", "session.moved", "session.deleted"], signal: events.signal })) {
        if (disposed) continue
        if (event.type === "session.moved" || event.type === "session.deleted") { infos.delete(event.data.sessionID); continue }
        if (event.type !== "session.compaction.failed") continue
        await bounded(500, async (_signal, alive) => serial(event.data.sessionID, async () => {
          const state = await load(event.data.sessionID)
          if (!alive()) return
          state.pendingCompact = null
          await save(event.data.sessionID, state)
        }))
      }
    })().catch(() => {})
    const registrations = await Promise.all([
      ctx.session.hook("compaction", async event => {
        await bounded(500, async (_signal, alive) => serial(event.sessionID, async () => {
          const state = await load(event.sessionID)
          if (!alive()) return
          // The next agent-loop context runs after compaction; no request is made from this hook.
          state.first = true; state.pendingCompact = randomUUID()
          state.notes = []
          pendingNotes.delete(event.sessionID)
          await save(event.sessionID, state)
        }))
      }),
      ctx.session.hook("context", async event => {
        if (disposed || !event.messages.length) return
        await bounded(500, async (signal, alive) => serial(event.sessionID, async () => {
          const c = configuration(await loadConfig())
          if (!alive() || c.mode === "off") return
          const state = await load(event.sessionID)
          if (!alive()) return
          let trigger: "first_prompt" | "compaction" | null = null
          let token = state.pendingCompact
          let prompt: Message | null = null
          if (token && token !== state.compact) trigger = "compaction"
          if (!state.first || trigger) {
            const session = await info(event.sessionID, signal)
            if (!alive()) return
            if (!trigger) { prompt = first(event, session); state.first = true; trigger = prompt ? "first_prompt" : null; token = prompt?.id ?? null }
            if (trigger === "compaction") { state.compact = token; state.pendingCompact = null; state.first = true }
            // A terminal latch is committed before any external check; failures are not retried.
            await save(event.sessionID, state)
            if (!alive()) return
            if (trigger && (!c.dirs.length || c.dirs.some(d => within(session.location.directory, d)))) {
              const result = await check(c, { trigger, token, request_id: `${event.sessionID}:${trigger}:${token}`,
                compaction_id: trigger === "compaction" ? token : null, session_id: event.sessionID, caller_native: event.sessionID,
                parent_id: session.parentID,
                cwd: session.location.directory, prompt: prompt ? text(prompt).slice(0, 6000) : event.messages.filter(m => m.role === "user").map(text).slice(-1).join("").slice(0, 6000) }, signal)
              if (!alive()) return
              const anchor = event.messages.at(-1)?.id
              if (result?.note && c.mode === "on" && anchor) {
                if (!state.notes.some(n => n.anchor === anchor && n.note === result.note)) state.notes.push({ note: result.note, anchor })
                await save(event.sessionID, state)
              }
            }
          }
          const pending = pendingNotes.get(event.sessionID) ?? []
          for (const entry of pending) if (!state.notes.some(n => n.anchor === entry.anchor && n.note === entry.note)) state.notes.push(entry)
          if (pending.length && alive()) {
            await save(event.sessionID, state)
            if (alive() && pendingNotes.get(event.sessionID) === pending) pendingNotes.delete(event.sessionID)
          }
          if (!alive() || c.mode !== "on" || !state.notes.length || configuration(await loadConfig()).mode !== "on" || !alive()) return
          for (const entry of state.notes) {
            const index = event.messages.findLastIndex(m => m.id === entry.anchor)
            if (index < 0) continue
            const id = `recall_${hash(entry.anchor + entry.note)}`
            let after = index + 1
            while (after < event.messages.length && (event.messages[after].role === "tool" || event.messages[after].id?.startsWith("recall_"))) after++
            if (!event.messages.some(m => m.id === id)) event.messages.splice(after, 0, { id, role: "user", content: [{ type: "text", text: entry.note }] })
          }
        }))
      }),
      ctx.tool.hook("execute.before", async event => {
        if (disposed) return
        const result = await bounded(3000, async (signal, alive) => {
          const c = configuration(await loadConfig())
          if (!alive() || c.mode === "off") return
          const session = await info(event.sessionID, signal)
          if (!alive() || c.dirs.length && !c.dirs.some(d => within(session.location.directory, d))) return
          const response = await check(c, { trigger: "tool", token: event.id, request_id: `${event.sessionID}:tool:${event.id}`,
            tool_call_id: event.id, tool: event.tool, arguments: object(event.input) ? event.input : { input: event.input },
            cwd: session.location.directory, session_id: event.sessionID, parent_id: session.parentID, caller_native: event.sessionID }, signal)
          if (!alive() || configuration(await loadConfig()).mode !== "on" || !alive()) return
          if (response?.decision === "deny" && response.reason && cited(response.sources)) return response
          if (response?.note) {
            const pending = pendingNotes.get(event.sessionID) ?? []
            if (!pending.some(n => n.anchor === event.messageID && n.note === response.note)) {
              pendingNotes.set(event.sessionID, [...pending, { note: response.note, anchor: event.messageID }])
            }
            await serial(event.sessionID, async () => {
            const state = await load(event.sessionID)
            if (!alive()) return
            if (!state.notes.some(n => n.anchor === event.messageID && n.note === response.note)) state.notes.push({ note: response.note!, anchor: event.messageID })
            await save(event.sessionID, state)
            }).catch(() => {})
          }
          return alive() && c.mode === "on" ? response : undefined
        })
        if (result?.decision === "deny" && result.reason && cited(result.sources)) {
          throw new Error(result.reason)
        }
      }),
    ])
    return async () => { disposed = true; events.abort(); for (const ctl of active) ctl.abort(); await Promise.all(registrations.map(r => r.dispose())); void eventLoop; infos.clear(); pendingNotes.clear() }
  } }
}

export default createRecallPlugin()
