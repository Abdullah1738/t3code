// offbox heavy-command classifier, TypeScript port of classify.py (worker C).
// Same rule set (../heavy-rules.json) and same vectors; tests/classify.test.ts
// checks the two stay in lockstep. No dependencies; sync fs only for the
// optional go.mod lookup (cached).
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, normalize } from "node:path"

export type Verdict = {
  heavy: boolean
  rule?: string
  class?: string
  size?: string
  why?: string
  rules?: string[]
  rewrite?: string
  error?: string
}
type Hit = { rule: string; class: string; size: string; why: string; start: number | null; envs: string[] }
type Ctx = { cwd: string | null; env: Record<string, string> }
type Word = [string, number]

const HOME = homedir()
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"])
const SKIP_SEG = new Set(["for", "case", "select", "function", "fi", "done", "esac", "in"])
const OPCH = new Set([";", "&", "|", "(", ")", "<", ">"])
const VAR = "\u0000"
const full = (re: string) => new RegExp(`^(?:${re})$`)

let SPEC: any = null
const repoCache = new Map<string, string | null>()

export function loadRules(path: string) {
  const raw = JSON.parse(readFileSync(path, "utf8"))
  for (const r of [...raw.rules, ...raw.wrappers]) {
    r._cmd = full(r.cmd)
    r._sub = (r.sub ?? []).map(full)
    r._vf = new Set(r.value_flags ?? [])
    if (r.skip_re) r._skip = full(r.skip_re)
    if (r.node_script_re) r._node = new RegExp(r.node_script_re)
  }
  raw._thr = new RegExp(raw.throwaway_cwd_re ?? "$^")
  SPEC = raw
  return raw
}

// ---------------------------------------------------------------- lexer

function balanced(s: string, i: number): number {
  let depth = 1
  const n = s.length
  while (i < n) {
    const c = s[i]
    if (c === "\\") { i += 2; continue }
    if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? n : j + 1; continue }
    if (c === '"') {
      i += 1
      while (i < n && s[i] !== '"') i += s[i] === "\\" ? 2 : 1
      i += 1
      continue
    }
    if (c === "(") depth++
    else if (c === ")") { depth--; if (depth === 0) return i + 1 }
    i++
  }
  return n
}

function dollar(s: string, i: number, buf: string[], subs: string[]): number {
  const n = s.length
  if (s.startsWith("$(", i)) {
    const j = balanced(s, i + 2)
    subs.push(s.slice(i + 2, j - 1))
    buf.push(s.slice(i, j))
    return j
  }
  if (s.startsWith("${", i)) {
    let j = s.indexOf("}", i)
    if (j < 0) j = n - 1
    const name = s.slice(i + 2, j)
    buf.push(/^[A-Za-z_]\w*$/.test(name) ? `${VAR}${name}${VAR}` : s.slice(i, j + 1))
    return j + 1
  }
  const m = /^[A-Za-z_]\w*/.exec(s.slice(i + 1, i + 200))
  if (m) { buf.push(`${VAR}${m[0]}${VAR}`); return i + 1 + m[0].length }
  buf.push("$")
  return i + 1
}

function word(s: string, i: number, subs: string[]): [string, number] {
  const n = s.length
  const buf: string[] = []
  if (s[i] === "~" && (i + 1 === n || " \t\n;&|)/".includes(s[i + 1]))) { buf.push(HOME); i++ }
  while (i < n) {
    const c = s[i]
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || OPCH.has(c)) break
    if (c === "\\") {
      if (i + 1 < n && s[i + 1] !== "\n") buf.push(s[i + 1])
      i += 2
    } else if (c === "'") {
      let j = s.indexOf("'", i + 1)
      if (j < 0) j = n
      buf.push(s.slice(i + 1, j))
      i = j + 1
    } else if (c === '"') {
      i++
      while (i < n && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < n) {
          buf.push('"\\$`'.includes(s[i + 1]) ? s[i + 1] : s.slice(i, i + 2))
          i += 2
        } else if (s[i] === "$") i = dollar(s, i, buf, subs)
        else if (s[i] === "`") {
          let j = s.indexOf("`", i + 1)
          if (j < 0) j = n
          subs.push(s.slice(i + 1, j))
          i = j + 1
        } else { buf.push(s[i]); i++ }
      }
      i++
    } else if (c === "$") i = dollar(s, i, buf, subs)
    else if (c === "`") {
      let j = s.indexOf("`", i + 1)
      if (j < 0) j = n
      subs.push(s.slice(i + 1, j))
      i = j + 1
    } else { buf.push(c); i++ }
  }
  return [buf.join(""), i]
}

const REDIR_OPS = ["<<<", "<<-", "<<", "<>", "<&", ">&", ">>", ">|", "&>>", "&>", "<", ">"]

function redirect(s: string, i: number, heredocs: [string, boolean][], subs: string[]): number {
  const n = s.length
  while (i < n && s[i] >= "0" && s[i] <= "9") i++
  if (s.startsWith("<(", i) || s.startsWith(">(", i)) {
    const j = balanced(s, i + 2)
    subs.push(s.slice(i + 2, j - 1))
    return j
  }
  let op = ""
  for (const o of REDIR_OPS) if (s.startsWith(o, i)) { op = o; i += o.length; break }
  while (i < n && (s[i] === " " || s[i] === "\t")) i++
  if (i >= n || "\n;|()".includes(s[i])) return i
  const [target, j] = word(s, i, [])
  if (op === "<<" || op === "<<-") heredocs.push([target.split(VAR).join(""), op === "<<-"])
  return j
}

export function lex(s: string): [Word[][], string[]] {
  const segs: Word[][] = []
  const subs: string[] = []
  let cur: Word[] = []
  let heredocs: [string, boolean][] = []
  let i = 0
  const n = s.length
  while (i < n) {
    const c = s[i]
    if (c === "\n") {
      if (cur.length) segs.push(cur)
      cur = []
      i++
      for (const [delim] of heredocs) {
        while (i < n) {
          let j = s.indexOf("\n", i)
          if (j < 0) j = n
          const line = s.slice(i, j).trim()
          i = j + 1
          if (line === delim) break
        }
      }
      heredocs = []
    } else if (c === " " || c === "\t" || c === "\r") i++
    else if (c === "\\" && s.startsWith("\\\n", i)) i += 2
    else if (c === "#") { const j = s.indexOf("\n", i); i = j < 0 ? n : j }
    else if (c === "<" || c === ">" || (c === "&" && s.startsWith("&>", i)) || (c >= "0" && c <= "9" && /^\d+[<>]/.test(s.slice(i, i + 6))))
      i = redirect(s, i, heredocs, subs)
    else if (";&|()".includes(c)) {
      if (cur.length) segs.push(cur)
      cur = []
      i += ["&&", "||", ";;", "|&"].includes(s.slice(i, i + 2)) ? 2 : 1
    } else {
      const start = i
      const [w, j] = word(s, i, subs)
      i = j
      cur.push([w, start])
    }
  }
  if (cur.length) segs.push(cur)
  return [segs, subs]
}

// ---------------------------------------------------------------- evaluation

const expand = (w: string, env: Record<string, string>) =>
  w.includes(VAR) ? w.replace(new RegExp(`${VAR}(\\w+)${VAR}`, "g"), (_m, k) => env[k] ?? `$${k}`) : w

function chdir(cwd: string | null, args: string[]): string | null {
  const a = args.filter((x) => !x.startsWith("-") || x === "-")
  if (!a.length) return HOME
  const t = a[0]
  if (t.includes("$") || t === "-") return null
  if (isAbsolute(t)) return normalize(t).replace(/(.)\/$/, "$1")
  return cwd ? normalize(join(cwd, t)).replace(/(.)\/$/, "$1") : null
}

function has(flags: string[], wanted: string[]): boolean {
  for (const f of flags)
    for (const w of wanted)
      if (f === w || f.startsWith(w + "=") || (w.length === 2 && w[1] !== "-" && !f.startsWith("--") && f.startsWith(w))) return true
  return false
}

function repoFile(cwd: string | null, file: string, pat: string): boolean {
  if (!cwd) return false
  let d = cwd
  for (let k = 0; k < 12; k++) {
    const p = join(d, file)
    if (!repoCache.has(p)) {
      try { repoCache.set(p, readFileSync(p, "utf8").slice(0, 400_000)) } catch { repoCache.set(p, null) }
    }
    const txt = repoCache.get(p)
    if (txt != null) return new RegExp(pat).test(txt)
    const nd = dirname(d)
    if (nd === d) break
    d = nd
  }
  return false
}

function readCached(p: string): string | null {
  if (!repoCache.has(p)) {
    try { repoCache.set(p, readFileSync(p, "utf8").slice(0, 400_000)) } catch { repoCache.set(p, null) }
  }
  return repoCache.get(p) ?? null
}

function goModule(cwd: string): [string | null, string | null] {
  let d = cwd
  for (let k = 0; k < 12; k++) {
    const txt = readCached(join(d, "go.mod"))
    if (txt != null) {
      const m = /^module\s+(\S+)/m.exec(txt)
      return m ? [d, m[1]] : [null, null]
    }
    const nd = dirname(d)
    if (nd === d) break
    d = nd
  }
  return [null, null]
}

const scanCache = new Map<string, [boolean, string[]] | null>()
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function scan(d: string, rx: RegExp, ext: string, mod: string | null): [boolean, string[]] | null {
  const key = JSON.stringify([d, rx.source, ext, mod])
  if (!scanCache.has(key)) {
    let names: string[] | null
    try { names = readdirSync(d).filter((n) => n.endsWith(ext)).sort() } catch { names = null }
    let res: [boolean, string[]] | null = null
    if (names !== null) {
      let hit = false
      const imps = new Set<string>()
      const irx = mod ? new RegExp(`"(${reEscape(mod)}/[^"\\s]+)"`, "g") : null
      for (const n of names.slice(0, 400)) {
        let txt: string
        try { txt = readFileSync(join(d, n), "utf8").slice(0, 200_000) } catch { hit = true; break }
        if (rx.test(txt)) { hit = true; break }
        if (irx) for (const m of txt.matchAll(irx)) imps.add(m[1])
      }
      res = [hit, [...imps].sort()]
    }
    scanCache.set(key, res)
  }
  return scanCache.get(key) ?? null
}

const PKG_SCAN_MAX = 60
const normDir = (p: string) => normalize(p).replace(/(.)\/$/, "$1")

// A target package dir (or, with go_imports, any package of the same module it transitively imports) has an
// `ext` file matching re. Unresolvable targets or more than PKG_SCAN_MAX dirs count as a match (stay heavy).
// Mirrors classify.py _pkg_mentions.
function pkgMentions(cwd: string | null, pos: string[], c: any): boolean {
  if (!cwd) return true
  const rx = new RegExp(c.re)
  const [root, mod] = c.go_imports ? goModule(cwd) : [null, null]
  const todo: string[] = []
  for (const t of pos.length ? pos : ["."]) {
    if (t.includes(VAR) || t.includes("$") || t.includes("...") || !(t.startsWith(".") || t.startsWith("/"))) return true
    todo.push(normDir(isAbsolute(t) ? t : join(cwd, t)))
  }
  const seen = new Set<string>()
  while (todo.length) {
    const d = todo.shift()!
    if (seen.has(d)) continue
    seen.add(d)
    if (seen.size > PKG_SCAN_MAX) return true
    const r = scan(d, rx, c.ext, mod)
    if (r === null || r[0]) return true
    for (const imp of r[1]) todo.push(normDir(join(root!, imp.slice(mod!.length + 1))))
  }
  return false
}

function cond(c: any, flags: string[], pos: string[], cwd: string | null): boolean {
  if (c.has_flag && !has(flags, c.has_flag)) return false
  if (c.lacks_flag && has(flags, c.lacks_flag)) return false
  if (c.min_pos !== undefined && pos.length < c.min_pos) return false
  if (c.max_pos !== undefined && pos.length > c.max_pos) return false
  if (c.pos_all_re && !pos.every((p) => new RegExp(c.pos_all_re).test(p))) return false
  if (c.pos_none_re && pos.some((p) => new RegExp(c.pos_none_re).test(p))) return false
  if (c.pos_any_re && !pos.some((p) => new RegExp(c.pos_any_re).test(p))) return false
  if (c.cwd_re) {
    const rx = c.cwd_re === "$throwaway" ? SPEC._thr : new RegExp(c.cwd_re)
    if (!cwd || !rx.test(cwd)) return false
  }
  if (c.repo_file && !repoFile(cwd, c.repo_file.file, c.repo_file.re)) return false
  if (c.pkg_mentions && !pkgMentions(cwd, pos, c.pkg_mentions)) return false
  return true
}

function match(rule: any, base: string, argv: string[]): [string[], string[]] | null {
  if (!rule._cmd.test(base)) return null
  const flags: string[] = []
  const pos: string[] = []
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--") { i++; continue }
    if (a.startsWith("-") && a.length > 1) { flags.push(a); i += rule._vf.has(a) ? 2 : 1; continue }
    pos.push(a)
    i++
  }
  const subs: RegExp[] = rule._sub
  if (pos.length < subs.length || subs.some((r, k) => !r.test(pos[k]))) return null
  const rest = pos.slice(subs.length).filter((p) => !ASSIGN.test(p) && !(rule._skip && rule._skip.test(p)))
  return [flags, rest]
}

function heavy(rule: any, flags: string[], pos: string[], cwd: string | null): boolean {
  if ((rule.force_heavy_when ?? []).some((c: any) => cond(c, flags, pos, cwd))) return true
  const hw = rule.heavy_when
  if (hw !== undefined && !hw.some((c: any) => cond(c, flags, pos, cwd))) return false
  return !(rule.local_when ?? []).some((c: any) => cond(c, flags, pos, cwd))
}

function peel(argv: string[], ctx: Ctx, start: number | null, out: Hit[], depth: number): string[] | null {
  for (let round = 0; round < 10; round++) {
    while (argv.length && ASSIGN.test(argv[0])) argv = argv.slice(1)
    if (!argv.length) return null
    const base = basename(argv[0])
    const w = SPEC.wrappers.find(
      (w: any) => w._cmd.test(base) && argv.length > w._sub.length && w._sub.every((r: RegExp, k: number) => r.test(argv[k + 1])),
    )
    if (!w) return argv
    if (w._node) {
      const rest = argv.slice(1).filter((a) => !a.startsWith("-"))
      const m = rest.length ? w._node.exec(rest[0]) : null
      if (!m) return argv
      argv = [m[1], ...argv.slice(argv.indexOf(rest[0]) + 1)]
      continue
    }
    if (w.cmd === "perl" && !argv.slice(1).some((a) => a === "-e" || a === "-E")) return argv
    let rest = argv.slice(1 + w._sub.length)
    let i = 0
    const sflags = new Set<string>(w.script_flags ?? [])
    while (i < rest.length && rest[i].startsWith("-") && rest[i] !== "-") {
      const a = rest[i]
      if (a === "--") { i++; break }
      const eq = a.indexOf("=")
      if (sflags.has(a) || (w.script_cluster && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))) {
        if (i + 1 < rest.length) analyze(rest[i + 1], { cwd: ctx.cwd, env: { ...ctx.env } }, depth + 1, out, start)
        return null
      }
      if (eq > 0 && sflags.has(a.slice(0, eq))) {
        analyze(a.slice(eq + 1), { cwd: ctx.cwd, env: { ...ctx.env } }, depth + 1, out, start)
        return null
      }
      i += w._vf.has(a) ? 2 : 1
    }
    rest = rest.slice(i)
    while (rest.length && ASSIGN.test(rest[0])) rest = rest.slice(1)
    argv = rest.slice(w.skip_pos ?? 0)
  }
  return argv
}

function analyze(src: string, ctx: Ctx, depth: number, out: Hit[], outerStart: number | null) {
  if (depth > 5 || !src) return
  const [segs, subs] = lex(src)
  const env = ctx.env
  for (const seg of segs) {
    let words: Word[] = seg.map(([w, s]) => [expand(w, env), s])
    while (words.length && KEYWORDS.has(words[0][0])) words = words.slice(1)
    if (!words.length || SKIP_SEG.has(words[0][0])) continue
    let j = 0
    while (j < words.length && ASSIGN.test(words[j][0])) j++
    if (j === words.length) {
      for (const [w] of words) {
        const k = w.indexOf("=")
        env[w.slice(0, k).replace(/\+$/, "")] = w.slice(k + 1)
      }
      continue
    }
    let argv: string[] | null = words.slice(j).map(([w]) => w)
    const start = outerStart === null ? words[j][1] : outerStart
    const envs = outerStart === null ? words.slice(0, j).map(([w]) => w.slice(0, w.indexOf("=")).replace(/\+$/, "")) : []
    let base = basename(argv[0])
    if (base === "cd" || base === "pushd") { ctx.cwd = chdir(ctx.cwd, argv.slice(1)); continue }
    if (base === "export") {
      for (const w of argv.slice(1)) if (ASSIGN.test(w)) { const k = w.indexOf("="); env[w.slice(0, k)] = w.slice(k + 1) }
      continue
    }
    argv = peel(argv, ctx, start, out, depth)
    if (!argv || !argv.length || basename(argv[0]) === "offbox") continue
    base = basename(argv[0])
    for (const rule of SPEC.rules) {
      const m = match(rule, base, argv)
      if (m && heavy(rule, m[0], m[1], ctx.cwd)) {
        out.push({ rule: rule.id, class: rule.class, size: rule.size, why: rule.why, start, envs })
        break
      }
    }
  }
  for (const s of subs) analyze(s, { cwd: ctx.cwd, env: { ...env } }, depth + 1, out, -1)
}

const shQuote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`)
const maxSize = (sizes: string[]) => sizes.reduce((a, b) => (SPEC.sizes.indexOf(b) > SPEC.sizes.indexOf(a) ? b : a))

function rewrite(cmd: string, hits: Hit[], size: string): string {
  const sz = (s: string) => (s === "default" ? "" : `--size ${s} `)
  if (hits.some((h) => h.start === null || h.start < 0)) return `offbox run ${sz(size)}-- bash -c ${shQuote(cmd)}`
  let s = cmd
  const starts = [...new Set(hits.map((h) => h.start as number))].sort((a, b) => b - a)
  for (const st of starts) {
    const mine = hits.filter((h) => h.start === st)
    const envs = [...new Set(mine.flatMap((h) => h.envs))].map((e) => `--env ${e} `).join("")
    s = s.slice(0, st) + "offbox run " + sz(maxSize(mine.map((h) => h.size))) + envs + "-- " + s.slice(st)
  }
  return s
}

export function classify(cmd: string, cwd?: string | null): Verdict {
  const out: Hit[] = []
  try {
    if (!SPEC) throw new Error("rules not loaded")
    const env: Record<string, string> = { HOME, TMPDIR: process.env.TMPDIR ?? "/tmp/" }
    analyze(cmd, { cwd: cwd ? normalize(cwd).replace(/(.)\/$/, "$1") : null, env }, 0, out, null)
  } catch (e: any) {
    return { heavy: false, error: `${e?.name ?? "Error"}: ${e?.message ?? e}` }
  }
  if (!out.length) return { heavy: false }
  const size = maxSize(out.map((h) => h.size))
  return {
    heavy: true, rule: out[0].rule, class: out[0].class, size, why: out[0].why,
    rules: [...new Set(out.map((h) => h.rule))].sort(), rewrite: rewrite(cmd, out, size),
  }
}
