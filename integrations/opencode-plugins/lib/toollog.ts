import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const CAP_BYTES = 50 * 1024 * 1024;
export const HOOKS_CAP_BYTES = 35 * 1024 * 1024;
export const HOOK_SAMPLE_RATE = 128;
const label = /^[A-Za-z0-9_.:-]{1,120}$/;
const fields = new Set(['harness','guard','decision','rule','firstWord','commandLength','filesChanged','driftFound','differingCount','platform','billedMinutes','exitCode','failingStep','count','dryRun','toolCount','operation','status','cwdClass','matchedRoot','argv0Class','repeatCount','threadIdSource','sampleRate',
  'classifier','errorClass','errorMessage','failMode','spawnMs','classifyMs','totalMs','cmdKind','holder','adbVerb','source']);
// Callers build errorMessage from fixed strings only (lib/classifier.ts), so it may hold spaces.
const messageText = /^[A-Za-z0-9 _.:,()'\/-]{1,200}$/;
const idFields = new Set(['sessionId','threadId','cardNumber','serverId','home','sampleId']);
const words = new Set('git rg grep find ls cat cp mv rm python python3 node bun npm pnpm yarn vp go cargo rustc make docker offbox bash sh zsh curl sqlite3 terraform aws rcsim runcloud printf echo env sudo'.split(' '));
export function commandProps(command?: unknown) {
  if (typeof command !== 'string') return {};
  const match = /^\s*([A-Za-z0-9_./+-]+)(?=\s|$)/.exec(command);
  const word = match ? basename(match[1]) : '';
  const firstWord = words.has(word) ? word : 'other';
  const argv0Class = ['rg','grep','find'].includes(firstWord) ? 'search' :
    ['python','python3','node','bun','bash','sh','zsh'].includes(firstWord) ? 'interpreter' :
    ['npm','pnpm','yarn','vp'].includes(firstWord) ? 'package-manager' :
    ['go','cargo','rustc','make'].includes(firstWord) ? 'build' :
    ['git','docker','offbox','sqlite3'].includes(firstWord) ? firstWord : 'other';
  return {firstWord, argv0Class, commandLength: command.length};
}
// Agents usually prefix `cd <dir> &&` or VAR=value, which hides the program from firstWord.
// Only the program's basename, bucketed to the known words, is kept; never the command.
export function cmdKind(command?: unknown) {
  if (typeof command !== 'string') return undefined;
  let rest = command;
  for (let i = 0; i < 8; i++) {
    const next = rest.replace(/^\s*cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*(?:&&|;)/, '').replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;&|]*)\s+)+/, '');
    if (next === rest) break;
    rest = next;
  }
  const match = /^\s*([A-Za-z0-9_./+-]+)(?=\s|$)/.exec(rest);
  const word = match ? basename(match[1]) : '';
  return words.has(word) ? word : 'other';
}
// Until #185 tags test runs, test runners are told apart by their environment.
export function runSource() {
  return process.env.NODE_ENV === 'test' || process.env.ROBOB_TEST || process.env.PYTEST_CURRENT_TEST ? 'test' : 'real';
}
export function hookProps(props: Record<string, unknown>, error = false) {
  const result = {...props};
  if (error || !['allowed', 'rewritten'].includes(String(props.decision))) return result;
  const defaults: Record<string, unknown[]> = {argv0Class:['none',''], matchedRoot:['none',''],
    repeatCount:[0,1], firstWord:[''], commandLength:[0], cwdClass:['other','']};
  for (const [key, values] of Object.entries(defaults)) {
    if (result[key] == null || values.includes(result[key])) delete result[key];
  }
  // Independent sampling also works for one-shot native hook processes.
  result.sampleRate = HOOK_SAMPLE_RATE;
  return result;
}
const cwdCache = new Map<string, string>();
export function cwdClass(cwd?: unknown) {
  if (typeof cwd !== 'string' || !cwd) return 'other';
  const path = resolve(cwd.replace(/^~(?=\/|$)/, homedir()));
  const cached = cwdCache.get(path);
  if (cached) return cached;
  let current = path, result = path === homedir() || path.startsWith(homedir() + '/') ? 'home' : 'other';
  for (let i = 0; i < 32; i++) {
    try { const git = statSync(join(current, '.git')); result = git.isFile() ? 'worktree' : 'repo-root'; break; } catch {}
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (cwdCache.size >= 256) cwdCache.clear();
  cwdCache.set(path, result);
  return result;
}
export function matchedRoot(root?: unknown) {
  switch (root) {
    case '/': return 'filesystem';
    case '/Users/ardud': return 'home';
    case '/Volumes/ExternalSSD': return 'external';
    case '/Volumes/ExternalSSD/board-wt': return 'board-worktrees';
    case null: case undefined: return 'none';
    default: return 'other';
  }
}
function hookId(value: unknown) {
  if (typeof value !== 'string' || !value) return undefined;
  if (label.test(value) || value.startsWith('thread:project:') && /^[A-Za-z0-9_.:%-]{1,300}$/.test(value)) return value;
  return 'sha256:' + createHash('sha256').update(value).digest('hex').slice(0,32);
}
export function hookIds(ids: Record<string, unknown> = {}) {
  const sessionId = hookId(ids.sessionId);
  const threadId = hookId(ids.threadId ?? process.env.ROBOB_THREAD_ID);
  const result: Record<string, unknown> = {threadId:threadId ?? (sessionId ? 'native:opencode:' + sessionId : 'unknown:opencode')};
  if (sessionId) result.sessionId = sessionId;
  const card = ids.cardNumber ?? process.env.ROBOB_CARD_NUMBER;
  if (typeof card === 'number' && Number.isSafeInteger(card) && card > 0 || typeof card === 'string' && /^[1-9][0-9]{0,8}$/.test(card)) result.cardNumber = Number(card);
  return {ids:result, source:threadId ? 'robob' : sessionId ? 'native' : 'unknown'};
}
const repeats = new Map<string, {at:number; count:number}>();
function repeatCount(ids: Record<string, unknown>, guard: string, rule: string, word: string) {
  if (String(ids.threadId).startsWith('unknown:')) return 1;
  const key = JSON.stringify([ids.sessionId ?? ids.threadId, guard, rule, word]), now = Date.now();
  const old = repeats.get(key);
  const count = old && now - old.at >= 0 && now - old.at <= 60_000 ? old.count + 1 : 1;
  if (repeats.size >= 4096) for (const [key, value] of repeats) if (now - value.at > 60_000) repeats.delete(key);
  if (repeats.size >= 4096) repeats.delete(repeats.keys().next().value!);
  repeats.set(key, {at:now, count});
  return count;
}
function metadata(values: Record<string, unknown> | undefined, keys: Set<string>) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([key, value]) => keys.has(key) &&
    (typeof value === 'boolean' || keys === fields && key === 'errorMessage' && typeof value === 'string' && messageText.test(value) || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && (keys === idFields ? /^[A-Za-z0-9_.:%/-]{1,300}$/ : label).test(value))));
}
function privateDir(path: string) {
  if (existsSync(path)) return;
  privateDir(dirname(path));
  mkdirSync(path, {mode: 0o700});
}
function claim(path: string) {
  try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
}
type RecordOptions = {board?: string; durationMs?: number; ok?: boolean; ids?: Record<string, unknown>; props?: Record<string, unknown>; errorTag?: string};
export function emit(component: string, kind: 'event' | 'perf' | 'error', name: string, options: RecordOptions = {}) {
  try {
    const board = options.board ?? 'agent-tools';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(board) || !label.test(component) || !label.test(name)) return;
    const now = new Date(), day = now.toISOString().slice(0, 10);
    const root = process.env.TOOLLOG_ROOT ?? join(homedir(), '.robob/logs/tools');
    const dir = join(root, board);
    privateDir(dir);
    chmodSync(dir, 0o700);
    if (claim(join(dir, '.retained-' + day))) {
      const cutoff = new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
      for (const file of readdirSync(dir)) {
        const date = /^(?:rollup-|\.retained-|\.cap-(?:hooks-)?|\.repeat-)?(\d{4}-\d{2}-\d{2})(?:-[a-f0-9]{32})?(?:\.ndjson|\.json|\.bin)?$/.exec(file);
        if (date && date[1] < cutoff) { try { unlinkSync(join(dir, file)); } catch {} }
      }
    }
    const row: Record<string, unknown> = {ts: now.toISOString(), tool: board, component, kind, name};
    if (typeof options.durationMs === 'number' && Number.isFinite(options.durationMs) && options.durationMs >= 0) row.durationMs = Math.round(options.durationMs * 1000) / 1000;
    if (typeof options.ok === 'boolean') row.ok = options.ok;
    for (const [key, value] of [['ids', metadata(options.ids, idFields)], ['props', metadata(options.props, fields)]] as const) {
      if (Object.keys(value).length) row[key] = value;
    }
    if (options.errorTag) { const tag = label.test(options.errorTag) ? options.errorTag : 'other'; row.error = {tag, message: tag}; }
    const path = join(dir, day + '.ndjson');
    const append = (record: unknown) => { appendFileSync(path, JSON.stringify(record) + '\n', {mode: 0o600}); chmodSync(path, 0o600); };
    let size = 0;
    try { size = statSync(path).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const caps: [string, number, string][] = [['all', CAP_BYTES, '.cap-']];
    if (component === 'hooks') caps.push(['hooks', HOOKS_CAP_BYTES, '.cap-hooks-']);
    for (const [scope, cap, prefix] of caps) {
      if (size >= cap && claim(join(dir, prefix + day))) append({ts: row.ts, tool: board, component,
        kind: 'error', name: 'log.cap', ok: false, props: {component:scope, capBytes:cap},
        error: {tag:'log.cap', message:'Daily log cap reached'}});
    }
    if (kind !== 'error' && (size >= CAP_BYTES || component === 'hooks' && size >= HOOKS_CAP_BYTES)) return;
    const rate = options.props?.sampleRate;
    if (kind !== 'error' && typeof rate === 'number' && Number.isSafeInteger(rate) && rate > 1 && Math.random() >= 1 / rate) return;
    append(row);
  } catch {}
}
export function hook(guard: string, decision: string, rule: string, started: number, command?: unknown, errorTag?: string, ids?: Record<string, unknown>, context: {cwd?:unknown; matchedRoot?:unknown} = {}, extra: Record<string, unknown> = {}) {
  try {
    const identity = hookIds(ids), commandFields = commandProps(command);
    emit('hooks', decision === 'denied' || errorTag ? 'error' : 'perf', 'hook.decision', {
      durationMs: performance.now() - started, ok: decision !== 'denied' && !errorTag, ids:identity.ids,
      props: hookProps({...extra, harness:'opencode', guard, decision, rule, threadIdSource:identity.source,
        cwdClass:cwdClass(context.cwd), matchedRoot:matchedRoot(context.matchedRoot), argv0Class:'none',
        repeatCount:repeatCount(identity.ids, guard, rule, commandFields.firstWord ?? 'none'), ...commandFields}, decision === 'denied' || !!errorTag),
      errorTag: errorTag ?? (decision === 'denied' ? rule : undefined),
    });
  } catch {}
}
