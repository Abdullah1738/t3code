import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CAP = 50 * 1024 * 1024;
const seen = new Set();
const failurePhases = new WeakMap();
const props = new Set(['model','size','count','status','enabled','locked','limited','reloginNeeded','state','action','tag','dryRun','complete','cost','hour','exitCode','attempt','source','failed','total','fourxx','fivexx','phase','durationMaxMs','omitted']);
const ids = new Set(['account','connection','thread','incident','request','session']);
const token = v => typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,100}$/.test(v) && !/(sk-|bearer|password|secret|token|api.?key|otp|cookie|prompt|@)/i.test(v) ? v : undefined;
const errorTag = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) ? token(v) : undefined;
// Only fixed operational messages survive. Exception text can contain arbitrary
// provider output, credentials or a filesystem path, even after regex redaction.
const messages = new Set(['Robob replica is stale; recovery deferred', 'Robob replica is not ready',
  'thread is newer than Robob replica; recovery deferred', 'unverified Robob replica',
  'The operation was aborted due to timeout', 'The operation was aborted', 'fetch failed']);
const errorMessage = (value, tag) => messages.has(value) ? value.slice(0, 300) : tag;
// Replica metadata is untrusted. Invalid values become an explicit unknown.
const replicaProps = value => Object.fromEntries(['replicaGeneration', 'replicaAgeMs', 'threadAheadMs', 'deferredThreads', 'maxThreadAheadMs']
  .filter(key => value?.[key] !== undefined)
  .map(key => [key, Number.isFinite(value[key]) ? value[key] : 'unknown']));
function failure(value, result = false) {
  try {
    const fetchFailed = !result && value?.name === 'TypeError' && value?.message === 'fetch failed';
    const causedAbort = !result && ['AbortError', 'TimeoutError'].includes(value?.name) && value?.cause;
    const causeTag = fetchFailed || causedAbort
      ? errorTag(value?.cause?.code) ?? errorTag(value?.cause?.name) ?? 'FETCH_FAILED' : undefined;
    const tag = causeTag ?? (result ? errorTag(value?.tag) : undefined) ?? errorTag(value?.code)
      ?? (result ? undefined : errorTag(value?.name)) ?? 'operation_failed';
    return { tag, message: errorMessage(value?.message, tag) };
  } catch { return { tag: 'operation_failed', message: 'operation_failed' }; }
}
// Keep metadata off caller-owned errors, including frozen errors. Only the
// operation identifier is retained; arguments and exception text stay out.
export function tagFailurePhase(error, phase) {
  if (error !== null && ['object', 'function'].includes(typeof error) && token(phase)) failurePhases.set(error, phase);
  return error;
}
export function clean(event, now = new Date()) {
  const name = token(event.name), component = token(event.component);
  if (!name || !component || !['event','perf','error'].includes(event.kind)) return null;
  const row = { ts: now.toISOString(), tool: '9router', component, kind: event.kind, name };
  if (Number.isFinite(event.durationMs) && event.durationMs >= 0) row.durationMs = Math.round(event.durationMs * 1000) / 1000;
  if (typeof event.ok === 'boolean') row.ok = event.ok;
  const safeIds = Object.fromEntries(Object.entries(event.ids ?? {}).filter(([k,v]) => ids.has(k) && ['string','number'].includes(typeof v)).map(([k,v]) => [k,createHash('sha256').update(String(v)).digest('hex').slice(0,16)]));
  const safeProps = Object.fromEntries(Object.entries(event.props ?? {}).filter(([k,v]) => props.has(k) && (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || token(v))));
  Object.assign(safeProps, replicaProps(event.props));
  if (Object.keys(safeIds).length) row.ids = safeIds;
  if (Object.keys(safeProps).length) row.props = safeProps;
  if (event.error) { const tag = token(event.error.tag) ?? 'unknown'; row.error = { tag, message: errorMessage(event.error.message, tag) }; }
  return row;
}
export function emit(component, name, fields = {}) {
  try {
    const now = new Date(), day = now.toISOString().slice(0,10);
    const row = clean({ ...fields, component, name, kind: fields.kind ?? 'event' }, now);
    if (!row) return;
    const root = process.env.ROUTER_LOG_DIR ?? join(homedir(), '.robob/logs/tools/9router');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const key = `${root}/${day}`;
    if (!seen.has(key)) {
      try {
        fs.closeSync(fs.openSync(join(root, `.retention-${day}`), 'wx', 0o600));
        const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0,10);
        for (const file of fs.readdirSync(root)) {
          const match = /^(?:rollup-|\.cap-|\.retention-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json)?$/.exec(file);
          if (match && match[1] < cutoff) fs.unlinkSync(join(root, file));
        }
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      seen.add(key);
    }
    const fd = fs.openSync(join(root, `${day}.ndjson`), 'a', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      if (fs.fstatSync(fd).size >= CAP) {
        try {
          fs.closeSync(fs.openSync(join(root, `.cap-${day}`), 'wx', 0o600));
          fs.writeSync(fd, JSON.stringify(clean({ component:'logger', name:'log.cap', kind:'error', error:{tag:'daily_cap'} }, now)) + '\n');
        } catch (e) { if (e.code !== 'EEXIST') throw e; }
        if (row.kind !== 'error') return;
      }
      fs.writeSync(fd, JSON.stringify(row) + '\n');
    } finally { fs.closeSync(fd); }
  } catch { /* Logging must never change tool behavior. */ }
}
export async function observed(component, name, work, fields = {}) {
  const start = performance.now();
  let result;
  try {
    result = await work();
  } catch (error) {
    try { emit(component, name, { ...fields, props:{...fields.props, ...replicaProps(error), ...(failurePhases.has(error) ? {phase:failurePhases.get(error)} : {})}, kind:'error', ok:false, durationMs:performance.now()-start, error:failure(error) }); } catch {}
    throw error;
  }
  try {
    const ok = result?.ok !== false && (!fields.exitCodeResult || result === 0);
    emit(component, name, { ...fields, kind: ok ? 'perf' : 'error', ok, durationMs:performance.now()-start, ...(ok ? {} : { error: failure(result, true) }) });
  } catch { /* Caller-owned metadata must not change a successful result. */ }
  return result;
}
