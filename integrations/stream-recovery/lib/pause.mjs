import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const isRecoveryPaused = (err) => err?.code === 'RECOVERY_PAUSED';
const pausedError = (message = 'automatic recovery is paused') => Object.assign(new Error(message), { code: 'RECOVERY_PAUSED' });

export function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text ?? '');
  const ms = match && Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[match[2]];
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('bad --for: use a positive duration such as 30m, 2h or 1d');
  return ms;
}

export function loadControl(dataDir) {
  try {
    const control = JSON.parse(readFileSync(join(dataDir, 'control.json'), 'utf8'));
    if (!Array.isArray(control.intervals) || !control.intervals.every((p, i, all) =>
      Number.isSafeInteger(p.start) && (p.end === null || (Number.isSafeInteger(p.end) && p.end >= p.start))
      && (i === 0 || (all[i - 1].end !== null && all[i - 1].end <= p.start)))
      || !(control.reason === null || typeof control.reason === 'string')) throw new Error('invalid control');
    return control;
  } catch (err) {
    if (err.code === 'ENOENT') return { intervals: [], reason: null };
    // A corrupt/unreadable control file must never silently enable recovery.
    throw pausedError('recovery control is unreadable; repair control.json before resuming');
  }
}

export function controlStatus(control, now = Date.now()) {
  const last = control.intervals.at(-1);
  const paused = Boolean(last && last.start <= now && (last.end === null || last.end > now));
  return { paused, until: paused && last.end !== null ? new Date(last.end).toISOString() : null,
    reason: paused ? control.reason : null };
}

// Intervals also survive resume/expiry. Otherwise a scan resuming after a long
// pause would age pending incidents out of its lookback and eligibility window.
export function pausedMs(control, start, now) {
  return control.intervals.reduce((total, p) => total + Math.max(0, Math.min(now, p.end ?? now) - Math.max(start, p.start)), 0);
}
export const recoveryElapsed = (io, start, now) => now - start - pausedMs(io.readControl?.() ?? { intervals: [] }, start, now);
export function recoveryFloor(io, now, age) {
  const intervals = io.readControl?.().intervals ?? [];
  let cursor = now, remaining = age;
  for (const p of [...intervals].reverse()) {
    const end = Math.min(cursor, p.end ?? cursor);
    if (p.start >= cursor) continue;
    const active = cursor - end;
    if (active >= remaining) return cursor - remaining;
    remaining -= active;
    cursor = p.start;
  }
  return cursor - remaining;
}

export function assertRecoveryActive(io) {
  if (controlStatus(io.readControl?.() ?? { intervals: [] }, io.now?.() ?? Date.now()).paused) throw pausedError();
}

// Fake IO and real IO share the same mutation gate. The real transports also
// check at the actual HTTP/WebSocket send, after any asynchronous setup.
export function guardRecoveryIo(io) {
  const guarded = { ...io };
  for (const name of ['sendToThread', 'dispatchCommand', 'interruptThread', 'ocInterrupt', 'telegram']) {
    if (io[name]) guarded[name] = (...args) => { assertRecoveryActive(io); return io[name](...args); };
  }
  return guarded;
}

async function editControl(dataDir, edit) {
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, 'control.lock');
  let fd;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const pid = Number(readFileSync(lock, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) { if (e.code === 'ESRCH') rmSync(lock, { force: true }); }
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (fd === undefined) throw new Error('recovery control is busy; retry the command');
  const tmp = join(dataDir, `control.${randomUUID()}.tmp`);
  try {
    const control = edit(loadControl(dataDir));
    writeFileSync(tmp, JSON.stringify(control, null, 2), { mode: 0o600 });
    renameSync(tmp, join(dataDir, 'control.json'));
    return control;
  } finally {
    closeSync(fd);
    rmSync(tmp, { force: true });
    rmSync(lock, { force: true });
  }
}

export async function pauseRecovery(dataDir, { durationMs = null, reason = null } = {}, now) {
  if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs <= 0
    || !Number.isSafeInteger((now ?? Date.now()) + durationMs) || (now ?? Date.now()) + durationMs > 8.64e15)) throw new Error('bad pause duration');
  return editControl(dataDir, (control) => {
    const at = now ?? Date.now();
    const last = control.intervals.at(-1);
    if (controlStatus(control, at).paused) last.end = at;
    control.intervals.push({ start: at, end: durationMs === null ? null : at + durationMs });
    control.reason = reason;
    return control;
  });
}
export async function resumeRecovery(dataDir, now) {
  return editControl(dataDir, (control) => {
    const at = now ?? Date.now();
    if (controlStatus(control, at).paused) control.intervals.at(-1).end = at;
    control.reason = null;
    return control;
  });
}
