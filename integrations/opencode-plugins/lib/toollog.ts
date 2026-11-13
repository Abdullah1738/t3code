import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const CAP_BYTES = 50 * 1024 * 1024;
const label = /^[A-Za-z0-9_.:-]{1,120}$/;
const fields = new Set(['harness','guard','decision','rule','firstWord','commandLength','filesChanged','driftFound','differingCount','platform','billedMinutes','exitCode','failingStep','count','dryRun','toolCount','operation','status']);
const idFields = new Set(['sessionId','threadId','serverId','home','sampleId']);
const words = new Set('git rg grep find ls cat cp mv rm python python3 node bun npm pnpm yarn vp go cargo rustc make docker offbox bash sh zsh curl sqlite3 terraform aws rcsim runcloud printf echo env sudo'.split(' '));
export function commandProps(command?: unknown) {
  if (typeof command !== 'string') return {};
  const match = /^\s*([A-Za-z0-9_./+-]+)(?=\s|$)/.exec(command);
  const word = match ? basename(match[1]) : '';
  return {firstWord: words.has(word) ? word : 'other', commandLength: command.length};
}
function metadata(values: Record<string, unknown> | undefined, keys: Set<string>) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([key, value]) => keys.has(key) &&
    (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && (keys === idFields ? /^[A-Za-z0-9_.:%/-]{1,300}$/ : label).test(value))));
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
        const date = /^(?:rollup-|\.retained-|\.cap-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json)?$/.exec(file);
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
    if (existsSync(path) && statSync(path).size >= CAP_BYTES) {
      if (claim(join(dir, '.cap-' + day))) append({ts: row.ts, tool: board, component, kind: 'error', name: 'log.cap', ok: false, error: {tag:'log.cap', message:'Daily log cap reached'}});
      if (kind !== 'error') return;
    }
    append(row);
  } catch {}
}
export function hook(guard: string, decision: string, rule: string, started: number, command?: unknown, errorTag?: string, ids?: Record<string, unknown>) {
  emit('hooks', decision === 'denied' || errorTag ? 'error' : 'perf', 'hook.decision', {
    durationMs: performance.now() - started, ok: decision !== 'denied' && !errorTag, ids,
    props: {harness:'opencode', guard, decision, rule, ...commandProps(command)},
    errorTag: errorTag ?? (decision === 'denied' ? rule : undefined),
  });
}
