// Lydia checklist ticks: a tiny write/read API + Moni's history page, backed by SQLite.
// Public via the named Cloudflare tunnel lydia-ticks -> https://lydia.abdullah.fund -> 127.0.0.1:18820.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const DIR = process.env.LYDIA_DIR ?? join(HOME, ".local/share/lydia-ticks");
const APP = process.env.LYDIA_APP ?? join(HOME, ".local/share/imessage-apps/lydia");
const PORT = Number(process.env.LYDIA_PORT ?? 18820);
const TZ = "Asia/Dubai";
const ALLOWED_ORIGINS = new Set(["https://cards.abdullah.fund"]);
const LISTS = new Set(["daily", "weekly", "away"]);

// ---- history token (unguessable, 128 bits) ----
const tokenFile = join(DIR, "history-token");
if (!existsSync(tokenFile)) {
  writeFileSync(tokenFile, Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") + "\n", { mode: 0o600 });
}
const HISTORY_TOKEN = readFileSync(tokenFile, "utf8").trim();

// ---- database ----
const db = new Database(join(DIR, "ticks.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  at_ms INTEGER NOT NULL,          -- when it was tapped (client clock, clamped)
  received_ms INTEGER NOT NULL,    -- when the server got it
  at_dubai TEXT NOT NULL,          -- 'YYYY-MM-DD HH:MM:SS' Asia/Dubai
  date TEXT NOT NULL,              -- Dubai date of the tap
  period TEXT NOT NULL,            -- date (daily/away) or Monday of the week (weekly)
  list TEXT NOT NULL,              -- daily | weekly | away
  task_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  task_en TEXT NOT NULL,
  task_am TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('tick','untick')),
  device TEXT,
  event_key TEXT UNIQUE            -- client-generated id so a retried send is stored once
);
CREATE INDEX IF NOT EXISTS events_period ON events(list, period, at_ms);
CREATE INDEX IF NOT EXISTS events_date ON events(date);`);

// ---- task list, read from the site's own data block ----
type Task = { id: string; en: string; am: string; times?: number };
type Data = Record<string, Task[]>;
let data: Data = {};
let dataMtime = 0;
function tasks(): Data {
  const file = join(APP, "index.html");
  const m = statSync(file).mtimeMs;
  if (m !== dataMtime) {
    const html = readFileSync(file, "utf8");
    const match = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
    if (match) { data = JSON.parse(match[1]); dataMtime = m; }
  }
  return data;
}
const findTask = (list: string, id: string) => (tasks()[list] ?? []).find(t => t.id === id);

// ---- time helpers ----
function parts(ms: number) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}
const dayOf = (ms: number) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const dubaiStamp = (ms: number) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };
function weekOf(ms: number) {
  const [y, m, d] = dayOf(ms).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}
const periodOf = (list: string, ms: number) => (list === "weekly" ? weekOf(ms) : dayOf(ms));

// ---- rate limit: per IP and overall ----
const buckets = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter(t => now - t < windowMs);
  if (hits.length >= max) { buckets.set(key, hits); return true; }
  hits.push(now); buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();
  return false;
}

const insert = db.prepare(`INSERT OR IGNORE INTO events (at_ms, received_ms, at_dubai, date, period, list, task_id, slot, task_en, task_am, action, device, event_key)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const periodEvents = db.prepare(`SELECT list, task_id, slot, action, at_ms FROM events WHERE list = ? AND period = ? ORDER BY at_ms, id`);

function currentState() {
  const now = Date.now();
  const out: Record<string, unknown> = { day: dayOf(now), week: weekOf(now) };
  for (const list of LISTS) {
    const state: Record<string, number> = {};
    for (const e of periodEvents.all(list, periodOf(list, now)) as any[]) {
      const k = `${e.task_id}:${e.slot}`;
      if (e.action === "tick") state[k] = e.at_ms; else delete state[k];
    }
    out[list] = state;
  }
  return out;
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" };
  if (ALLOWED_ORIGINS.has(origin)) { h["Access-Control-Allow-Origin"] = origin; h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"; h["Access-Control-Allow-Headers"] = "Content-Type"; h["Access-Control-Max-Age"] = "86400"; }
  return h;
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

const ID = /^[a-z0-9-]{1,40}$/;
const EVENT_KEY = /^[A-Za-z0-9_-]{8,40}$/;
const DEVICE = /^[A-Za-z0-9_-]{4,40}$/;

async function postTick(req: Request, ip: string) {
  if (limited(`ip:${ip}`, 120, 10 * 60_000) || limited("all", 3000, 24 * 60 * 60_000)) return json(req, { error: "slow down" }, 429);
  const text = await req.text();
  if (text.length > 1024) return json(req, { error: "too big" }, 413);
  let b: any;
  try { b = JSON.parse(text); } catch { return json(req, { error: "bad json" }, 400); }
  const items = Array.isArray(b?.events) ? b.events : [b];
  if (items.length < 1 || items.length > 8) return json(req, { error: "1-8 events" }, 400);
  const now = Date.now();
  const results: unknown[] = [];
  for (const e of items) {
    if (!e || typeof e !== "object") return json(req, { error: "bad event" }, 400);
    const { list, id, on } = e;
    if (!LISTS.has(list) || typeof id !== "string" || typeof on !== "boolean") return json(req, { error: "need list, id, on" }, 400);
    const [taskId, slotStr, extra] = id.split(":");
    const slot = Number(slotStr);
    if (extra !== undefined || !ID.test(taskId ?? "") || !/^\d{1,2}$/.test(slotStr ?? "")) return json(req, { error: "bad id" }, 400);
    const task = findTask(list, taskId);
    if (!task || slot >= (task.times ?? 1)) return json(req, { error: "unknown task" }, 400);
    if (e.key !== undefined && (typeof e.key !== "string" || !EVENT_KEY.test(e.key))) return json(req, { error: "bad key" }, 400);
    if (e.device !== undefined && (typeof e.device !== "string" || !DEVICE.test(e.device))) return json(req, { error: "bad device" }, 400);
    // Queued offline taps keep their own time, but only within the last 8 days and never in the future.
    let at = Number.isFinite(e.at) ? Math.round(e.at) : now;
    if (at > now + 60_000 || at < now - 8 * 86_400_000) at = now;
    if (at > now) at = now;
    const r = insert.run(at, now, dubaiStamp(at), dayOf(at), periodOf(list, at), list, taskId, slot, task.en, task.am, on ? "tick" : "untick", e.device ?? null, e.key ?? null);
    results.push({ id, stored: r.changes === 1 });
  }
  return json(req, { ok: true, results, state: currentState() });
}

// ---- Moni's history page ----
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const hm = (ms: number) => { const p = parts(ms); return `${p.hour}:${p.minute}`; };
const niceDate = (d: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(d + "T00:00:00Z"));

type Done = { id: string; task: string; slot: number; times: number; at: number };
function history(days: number) {
  const now = Date.now();
  const since = dayOf(now - days * 86_400_000);
  const rows = db.prepare(`SELECT * FROM events WHERE date >= ? ORDER BY at_ms, id`).all(since) as any[];
  // Replay each list's period; whatever is ticked at the end counts, at the time it was (last) ticked.
  const finals = new Map<string, Map<string, any>>();
  const untickCount = new Map<string, number>();
  for (const e of rows) {
    const pk = `${e.list}|${e.period}`;
    if (!finals.has(pk)) finals.set(pk, new Map());
    const k = `${e.task_id}:${e.slot}`;
    if (e.action === "tick") finals.get(pk)!.set(k, e); else { finals.get(pk)!.delete(k); untickCount.set(e.date, (untickCount.get(e.date) ?? 0) + 1); }
  }
  const byDate = new Map<string, { daily: Done[]; weekly: Done[]; away: Done[] }>();
  const dayRow = (d: string) => { if (!byDate.has(d)) byDate.set(d, { daily: [], weekly: [], away: [] }); return byDate.get(d)!; };
  const timesOf = (list: string, id: string) => findTask(list, id)?.times ?? 1;
  for (const [pk, m] of finals) {
    const list = pk.split("|")[0] as "daily" | "weekly" | "away";
    for (const e of m.values()) dayRow(e.date)[list].push({ id: e.task_id, task: e.task_en, slot: e.slot, times: timesOf(list, e.task_id), at: e.at_ms });
  }
  const today = dayOf(now);
  dayRow(today);
  const dates = [...byDate.keys()].sort().reverse();
  const allDaily = tasks().daily ?? [];
  return { dates, byDate, today, allDaily, untickCount, rows: rows.length };
}

function historyPage(): string {
  const { dates, byDate, today, allDaily, untickCount } = history(30);
  const daysHtml = dates.map(d => {
    const r = byDate.get(d)!;
    const sort = (a: Done, b: Done) => a.at - b.at;
    const slots = new Map<string, number>();
    for (const x of r.daily) slots.set(x.id, (slots.get(x.id) ?? 0) + 1);
    const missed = allDaily.filter(t => (slots.get(t.id) ?? 0) < (t.times ?? 1));
    const item = (x: Done) => `<li><span class="t">${hm(x.at)}</span><span>${esc(x.task)}${x.times > 1 ? ` <span class="muted">(${x.slot + 1} of ${x.times})</span>` : ""}</span></li>`;
    const block = (title: string, list: Done[]) => list.length ? `<h3>${title}</h3><ul class="done">${list.sort(sort).map(item).join("")}</ul>` : "";
    const total = allDaily.reduce((a, t) => a + (t.times ?? 1), 0), n = r.daily.length;
    const unt = untickCount.get(d);
    return `<section class="day${d === today ? " today" : ""}">
  <div class="day-head"><h2>${d === today ? "Today" : esc(niceDate(d))}${d === today ? `<span class="sub">${esc(niceDate(d))}</span>` : ""}</h2><span class="count${n === total && total ? " all" : ""}">${n} / ${total}</span></div>
  ${n === 0 && !r.weekly.length && !r.away.length ? `<p class="none">Nothing ticked${d === today ? " yet" : ""}.</p>` : ""}
  ${block("Daily", r.daily)}${block("Weekly", r.weekly)}${block("Dogs, while away", r.away)}
  ${missed.length && n > 0 ? `<details><summary>Not ticked (${missed.length})</summary><ul class="missed">${missed.map(t => `<li>${esc(t.en)}</li>`).join("")}</ul></details>` : ""}
  ${unt ? `<p class="muted small">${unt} untick${unt > 1 ? "s" : ""} that day.</p>` : ""}
</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Lydia's ticks · history</title>
<meta name="description" content="What Lydia ticked on her checklist, day by day, with times.">
<meta property="og:title" content="Lydia's ticks · history">
<meta property="og:description" content="What Lydia ticked on her checklist, day by day, with times (Dubai).">
<meta property="og:image" content="https://lydia.abdullah.fund/h/${HISTORY_TOKEN}/preview.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#e9efe9">
<style>
:root { --ground:#fff; --surface:#eef3ee; --surface-2:#e3ebe3; --text:#1f201d; --muted:#636361; --accent:#1b6e66; --done:#dcefe9; --radius:22px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
@media (prefers-color-scheme: dark) { :root { --ground:#111312; --surface:#1b201d; --surface-2:#252b27; --text:#eef0ec; --muted:#a3a8a3; --accent:#4fb3a7; --done:#1d322d; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin:0; background:var(--ground); color:var(--text); font-family:var(--font); font-size:17px; line-height:1.5; }
.wrap { max-width:720px; margin:0 auto; padding: calc(28px + env(safe-area-inset-top)) 16px calc(48px + env(safe-area-inset-bottom)); }
h1 { font-size:30px; line-height:1.15; font-weight:650; letter-spacing:-0.02em; margin:0; }
.lede { margin:8px 0 0; color:var(--muted); font-size:16px; }
.day { background:var(--surface); border-radius:var(--radius); padding:18px 16px 12px; margin-top:16px; }
.day.today { background:var(--done); }
.day-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
h2 { font-size:21px; line-height:1.25; margin:0; font-weight:620; }
.sub { display:block; font-size:14px; font-weight:400; color:var(--muted); }
.count { font-variant-numeric:tabular-nums; color:var(--muted); font-size:17px; white-space:nowrap; }
.count.all { color:var(--accent); font-weight:650; }
h3 { font-size:15px; font-weight:600; color:var(--muted); margin:14px 0 6px; }
ul { list-style:none; margin:0; padding:0; }
.done li { display:grid; grid-template-columns:3.4em 1fr; gap:10px; padding:8px 12px; background:var(--ground); border-radius:14px; margin-bottom:6px; }
.t { font-variant-numeric:tabular-nums; font-weight:600; color:var(--accent); }
.muted { color:var(--muted); }
.small { font-size:14px; margin:8px 0 4px; }
.none { margin:10px 0 6px; color:var(--muted); }
details { margin-top:10px; }
summary { cursor:pointer; color:var(--muted); font-size:15px; min-height:32px; display:flex; align-items:center; }
summary:focus-visible { outline:3px solid var(--accent); outline-offset:3px; border-radius:6px; }
.missed li { padding:4px 12px; color:var(--muted); font-size:15px; }
footer { margin-top:28px; color:var(--muted); font-size:14px; }
</style>
</head>
<body>
<div class="wrap">
  <header><h1>Lydia's ticks</h1><p class="lede">Last 30 days, newest first. Times are Dubai time. What's shown is what stayed ticked at the end of the day (or week, for weekly jobs).</p></header>
  <main>
${daysHtml}
  </main>
  <footer>Updated ${esc(dubaiStamp(Date.now()).slice(0, 16))}. Reload to refresh.</footer>
</div>
</body>
</html>`;
}

const page = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } });
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  maxRequestBodySize: 4096,
  async fetch(req) {
    const url = new URL(req.url);
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    const p = url.pathname;
    try {
      if (p === "/healthz") return new Response("ok\n", { headers: { "Cache-Control": "no-store" } });
      if (req.method === "OPTIONS" && p.startsWith("/api/")) return new Response(null, { status: 204, headers: cors(req) });
      if (p === "/api/state" && req.method === "GET") {
        if (limited(`r:${ip}`, 300, 10 * 60_000)) return json(req, { error: "slow down" }, 429);
        return json(req, currentState());
      }
      if (p === "/api/tick" && req.method === "POST") return await postTick(req, ip);
      const base = `/h/${HISTORY_TOKEN}`;
      if (p === base) return Response.redirect(`${url.origin}${base}/`, 308);
      if (p === `${base}/` && (req.method === "GET" || req.method === "HEAD")) return page(historyPage());
      if (p === `${base}/preview.png`) return new Response(Bun.file(join(APP, "preview.png")), { headers: { "Content-Type": "image/png", "Cache-Control": "max-age=3600" } });
      if (p === `${base}/history.json`) { const h = history(30); return json(req, { dates: h.dates.map(d => ({ date: d, ...h.byDate.get(d) })) }); }
      return notFound();
    } catch (err) {
      console.error(new Date().toISOString(), "error", p, err);
      return json(req, { error: "server error" }, 500);
    }
  },
});
console.log(new Date().toISOString(), `lydia-ticks listening on 127.0.0.1:${PORT}`);
