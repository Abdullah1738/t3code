// Running read-only CLIs (gh, linctl, git) for the facts pack.
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

// LaunchAgents run with a bare PATH; Homebrew's bin holds gh and linctl.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];

const resolved = new Map();

/** Absolute path of `name` on PATH or in the Homebrew dirs, else `name`. */
export function which(name) {
  if (name.includes('/')) return name;
  if (resolved.has(name)) return resolved.get(name);
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_PATH];
  let found = name;
  for (const dir of dirs) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      found = join(dir, name);
      break;
    } catch {}
  }
  resolved.set(name, found);
  return found;
}

/**
 * Runs a command and resolves its stdout. Rejects with the command, exit code
 * and the start of stderr. stdin is /dev/null: linctl reads a piped stdin as
 * a second query and refuses.
 */
export function exec(cmd, args, { cwd, timeoutMs = 120_000, maxBuffer = 256 * 1024 * 1024, killGraceMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    // Its own process group, so a stop reaches whatever it started too.
    const child = spawn(which(cmd), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const out = [];
    const err = [];
    let size = 0;
    let failure = null;
    let settled = false;
    const timers = [];
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      fn();
    };
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        try {
          child.kill(name);
        } catch {}
      }
    };
    const failed = (code) => {
      const detail = (failure ?? Buffer.concat(err).toString('utf8')).trim().slice(0, 400);
      return new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (${code}): ${detail}`);
    };
    const fail = (why) => {
      if (failure || settled) return;
      failure = why;
      signal('SIGTERM');
      timers.push(setTimeout(() => signal('SIGKILL'), killGraceMs));
      // Something it started (even outside its group) may still hold the pipes
      // open: stop waiting, close our ends and let this process exit without it.
      timers.push(
        setTimeout(
          () =>
            settle(() => {
              child.stdout.destroy();
              child.stderr.destroy();
              child.unref();
              reject(failed('killed'));
            }),
          killGraceMs * 2,
        ),
      );
    };
    timers.push(setTimeout(() => fail(`timed out after ${timeoutMs} ms`), timeoutMs));
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) fail(`more than ${maxBuffer} bytes of output`);
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on('error', (error) => settle(() => reject(new Error(`${cmd} failed to start: ${error.message}`))));
    child.on('close', (code, sig) =>
      settle(() => {
        if (failure || code !== 0) reject(failed(code ?? sig));
        else resolve(Buffer.concat(out).toString('utf8'));
      }),
    );
  });
}

/** `exec` that parses JSON stdout. */
export async function execJson(exec_, cmd, args, opts) {
  const out = await exec_(cmd, args, opts);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}: output is not JSON: ${out.slice(0, 200)}`);
  }
}

/** `exec` whose stdout is one JSON value per line (gh --paginate with --jq). */
export async function execLines(exec_, cmd, args, opts) {
  const out = await exec_(cmd, args, opts);
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}: line is not JSON: ${line.slice(0, 200)}`);
      }
    });
}

/** Maps with at most `limit` calls in flight, keeping order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
