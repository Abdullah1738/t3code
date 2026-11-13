import { randomUUID } from 'node:crypto';
import { readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This symlink is the global, non-expiring manual/automatic recovery lease.
// Its target is metadata, not a filesystem path. symlink() publishes owner and
// exclusivity atomically, even if the process dies immediately after acquiring.
export const DEFAULT_LEASE = join(dirname(fileURLToPath(import.meta.url)), 'recovery.lease');
const SELF = fileURLToPath(import.meta.url);

function acquireUnlocked(path, kind, id) {
  const owner = { version: 1, kind, id };
  try { symlinkSync(JSON.stringify(owner), path); }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  return owner;
}

export function leaseOwner(path) {
  try {
    const value = JSON.parse(readlinkSync(path, 'utf8'));
    if (value?.version !== 1 || !['manual', 'auto'].includes(value.kind) || typeof value.id !== 'string') return { kind: 'unknown' };
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'EINVAL' || e instanceof SyntaxError) return { kind: 'unknown' };
    throw e;
  }
}

function releaseUnlocked(path, owner) {
  const current = leaseOwner(path);
  if (!current || current.kind !== owner.kind || current.id !== owner.id) return false;
  unlinkSync(path);
  return true;
}

// The shell locks its own inherited fd and execs the mutation process, so the
// process doing the mutation owns the same open-file-description lock. There
// is no lock-holding wrapper that can die while an unlocked child survives.
// Never timeout-kill a wrapper: the watcher already kills its process group.
function guarded(path, operation, owner) {
  const script = 'guard=$1; shift; exec 9>>"$guard" || exit 70; /usr/bin/lockf -s -t 0 9 || exit 75; exec "$@"';
  const p = spawnSync('/bin/sh', ['-c', script, 'lease-guard', `${path}.guard`, process.execPath, SELF, '_guarded', path, operation, JSON.stringify(owner)], { encoding: 'utf8' });
  if (p.error || p.status !== 0) throw new Error('lease serialization unavailable');
  try { return JSON.parse(p.stdout); } catch { throw new Error('invalid lease result'); }
}
export function acquireLease(path, kind, id = randomUUID()) { return guarded(path, 'acquire', { kind, id }); }
export function releaseLease(path, owner) { return guarded(path, 'release', owner); }

if (process.argv[1] && SELF === process.argv[1]) {
  try {
    const [action, id, operation, encoded] = process.argv.slice(2);
    if (action === '_guarded') {
      const owner = JSON.parse(encoded);
      if (!['manual', 'auto'].includes(owner?.kind) || typeof owner.id !== 'string' || !owner.id) throw new Error('invalid owner');
      const result = operation === 'acquire' ? acquireUnlocked(id, owner.kind, owner.id) : operation === 'release' ? releaseUnlocked(id, owner) : undefined;
      if (result === undefined) throw new Error('invalid operation');
      process.stdout.write(JSON.stringify(result));
    } else if (action === 'status') {
      process.stdout.write(JSON.stringify(leaseOwner(DEFAULT_LEASE)) + '\n');
    } else if (action === 'acquire-manual') {
      const owner = acquireLease(DEFAULT_LEASE, 'manual');
      if (!owner) { process.stderr.write('Recovery lease is held; do not start another login.\n'); process.exitCode = 2; }
      else process.stdout.write(owner.id + '\n');
    } else if (action === 'release-manual' && id) {
      if (!releaseLease(DEFAULT_LEASE, { kind: 'manual', id })) throw new Error('not lease owner');
    } else { process.stderr.write('Usage: node lease.mjs status | acquire-manual | release-manual OWNER_ID\n'); process.exitCode = 2; }
  } catch { process.stderr.write('Lease operation failed; leave it held and inspect manually.\n'); process.exitCode = 1; }
}
