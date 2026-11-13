// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { setTimeout as sleep } from "node:timers/promises";

export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly start: string;
  readonly protected?: boolean;
  readonly version?: number;
  readonly executable?: string;
}
const exec = promisify(execFile);
// proc_bsdinfo includes microsecond start time. lstart alone has only second
// precision and cannot distinguish rapid PID reuse. Refuse if libproc fails.
const darwinTable = String.raw`
import ctypes, json, subprocess, sys
class BSD(ctypes.Structure):
 _fields_ = [(x,ctypes.c_uint32) for x in ['flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','rfu']] + [('comm',ctypes.c_char*16),('name',ctypes.c_char*32)] + [(x,ctypes.c_uint32) for x in ['nfiles','pgid','pjobc','tdev','tpgid','nice']] + [('sec',ctypes.c_uint64),('usec',ctypes.c_uint64)]
class Unique(ctypes.Structure):
 _fields_=[('uuid',ctypes.c_ubyte*16),('unique',ctypes.c_uint64),('parent_unique',ctypes.c_uint64),('version',ctypes.c_int32),('parent_version',ctypes.c_int32),('r2',ctypes.c_uint64),('r3',ctypes.c_uint64)]
lib=ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
rows=[]
for p in (sys.argv[1:] or subprocess.check_output(['/bin/ps','-axo','pid=']).split()):
 b=BSD(); u=Unique(); after=Unique(); pid=int(p)
 if (lib.proc_pidinfo(pid,17,0,ctypes.byref(u),ctypes.sizeof(u)) == ctypes.sizeof(u) and
     lib.proc_pidinfo(pid,3,0,ctypes.byref(b),ctypes.sizeof(b)) == ctypes.sizeof(b) and b.status != 5 and
     lib.proc_pidinfo(pid,17,0,ctypes.byref(after),ctypes.sizeof(after)) == ctypes.sizeof(after) and u.unique == after.unique):
  token=(ctypes.c_uint32*8)(0,0,0,0,0,pid,0,u.version); exe=ctypes.create_string_buffer(4096)
  lib.proc_pidpath_audittoken(ctypes.byref(token),exe,4096)
  rows.append(dict(pid=pid,ppid=b.ppid,pgid=b.pgid,start=str(b.sec*1000000+b.usec),version=u.version,executable=exe.value.decode(errors='replace')))
print(json.dumps(rows))
`;
async function protectedPids(signal?: AbortSignal) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,tty=,comm="], {
    timeout: 2000,
    signal,
    maxBuffer: 4 * 1024 * 1024,
  });
  return new Set(
    stdout
      .trim()
      .split("\n")
      .flatMap((line) => {
        const [pid, tty, ...command] = line.trim().split(/\s+/);
        return (tty !== "??" && tty !== "?") || /(?:^|\/)tmux$/.test(command.join(" "))
          ? [Number(pid)]
          : [];
      }),
  );
}
export async function processTable(signal?: AbortSignal): Promise<ProcessIdentity[]> {
  const protectedIds = await protectedPids(signal);
  if (process.platform === "darwin") {
    const { stdout } = await exec("/usr/bin/python3", ["-c", darwinTable], {
      timeout: 2000,
      signal,
      maxBuffer: 4 * 1024 * 1024,
    });
    return (JSON.parse(stdout) as ProcessIdentity[]).map((r) => ({
      ...r,
      protected: protectedIds.has(r.pid),
    }));
  }
  if (process.platform !== "linux")
    throw new Error("Process identity is unsupported on this platform");
  const rows = await Promise.all(
    (await readdir("/proc"))
      .filter((p) => /^\d+$/.test(p))
      .map(async (p) => {
        try {
          const raw = await readFile(`/proc/${p}/stat`, "utf8");
          const fields = raw
            .slice(raw.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);
          if (fields[0] === "Z") return null;
          return {
            pid: Number(p),
            ppid: Number(fields[1]),
            pgid: Number(fields[2]),
            start: fields[19]!,
            protected: protectedIds.has(Number(p)),
          };
        } catch {
          return null;
        }
      }),
  );
  return rows.flatMap((row) => (row === null ? [] : [row]));
}
export async function processIdentity(
  pid: number,
  signal?: AbortSignal,
): Promise<ProcessIdentity | undefined> {
  if (process.platform === "darwin") {
    const { stdout } = await exec("/usr/bin/python3", ["-c", darwinTable, String(pid)], {
      timeout: 2000,
      signal,
    });
    return (JSON.parse(stdout) as ProcessIdentity[])[0];
  }
  if (process.platform !== "linux") throw new Error("Process identity is unsupported");
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === "Z") return undefined;
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19]! };
  } catch {
    return undefined;
  }
}
export const sameProcess = (a: ProcessIdentity, b: ProcessIdentity | undefined) =>
  b !== undefined && a.pid === b.pid && a.start === b.start && a.version === b.version;

export function ownedTree(
  rows: readonly ProcessIdentity[],
  root: ProcessIdentity,
  excluded: ReadonlySet<number> = new Set(),
) {
  const owned = new Map<number, ProcessIdentity>();
  if (
    !sameProcess(
      root,
      rows.find((r) => r.pid === root.pid),
    )
  )
    return owned;
  owned.set(root.pid, root);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (
        !excluded.has(row.pid) &&
        !row.protected &&
        !owned.has(row.pid) &&
        owned.has(row.ppid) &&
        BigInt(row.start) >= BigInt(owned.get(row.ppid)!.start)
      ) {
        owned.set(row.pid, row);
        changed = true;
      }
    }
  }
  return owned;
}
export interface OwnedTree {
  readonly root: ProcessIdentity;
  readonly members: Map<number, ProcessIdentity>;
  readonly groups: Map<number, ProcessIdentity>;
  readonly excluded: Set<number>;
}
export async function captureOwnedTree(
  rootPid: number,
  excluded: ReadonlySet<number> = new Set(),
  signal?: AbortSignal,
  executable?: string,
): Promise<OwnedTree> {
  const rows = await processTable(signal);
  const root = rows.find((r) => r.pid === rootPid);
  if (!root || root.pid <= 1 || (executable !== undefined && root.executable !== executable))
    throw new Error("Cannot capture process ownership");
  const blocked = new Set(excluded);
  for (const row of rows) if (row.protected) blocked.add(row.pid);
  // Exclude the full ancestry of restart-surviving PTYs/tmux, even if their
  // descendants have closed their terminal or started another process group.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows)
      if (blocked.has(row.ppid) && !blocked.has(row.pid)) {
        blocked.add(row.pid);
        changed = true;
      }
  }
  const members = ownedTree(rows, root, blocked);
  const groups = new Map(
    [...members.values()]
      .filter((r) => r.pid === r.pgid && !excluded.has(r.pid))
      .map((r) => [r.pgid, r]),
  );
  return { root, members, groups, excluded: blocked };
}
// Retain ancestry snapshots after reparenting/leader exit. PGID is recorded for
// identity checks, but membership alone never grants ownership of a new PID.
export function refreshOwnedTree(tree: OwnedTree, rows: readonly ProcessIdentity[]) {
  for (const row of rows) if (row.protected) tree.excluded.add(row.pid);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows)
      if (tree.excluded.has(row.ppid) && !tree.excluded.has(row.pid)) {
        tree.excluded.add(row.pid);
        changed = true;
      }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (row.protected || tree.excluded.has(row.pid) || tree.members.has(row.pid)) continue;
      const parent = tree.members.get(row.ppid);
      if (
        parent &&
        sameProcess(
          parent,
          rows.find((p) => p.pid === parent.pid),
        ) &&
        BigInt(row.start) >= BigInt(parent.start)
      ) {
        tree.members.set(row.pid, row);
        changed = true;
      }
    }
  }
}
// Kernel-bound signalling closes the identity-check/numeric-kill race. On macOS
// the captured audit PID version is checked by proc_find_ident in the kernel.
// Linux opens a pidfd before re-reading start ticks and signals only that handle.
export async function signalIdentity(
  record: ProcessIdentity,
  signal: NodeJS.Signals,
  abort?: AbortSignal,
) {
  await signalIdentities([record], signal, abort);
}
async function signalIdentities(
  records: ProcessIdentity[],
  signal: NodeJS.Signals,
  abort?: AbortSignal,
) {
  const source =
    process.platform === "darwin"
      ? String.raw`
import ctypes, json, signal, sys, errno
sig=getattr(signal,sys.argv[1]); lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
for r in json.load(sys.stdin):
 if r.get('version') is None: raise RuntimeError('Missing audit PID version')
 token=(ctypes.c_uint32*8)(0,0,0,0,0,r['pid'],0,r['version'])
 if lib.proc_signal_with_audittoken(ctypes.byref(token),sig) != 0 and ctypes.get_errno()!=errno.ESRCH: raise OSError(ctypes.get_errno(),'audit-token signal failed')
`
      : String.raw`
import os, signal, json, sys, errno
for r in json.load(sys.stdin):
 fd=None
 try:
  fd=os.pidfd_open(r['pid'])
  with open('/proc/'+str(r['pid'])+'/stat') as f: raw=f.read()
  fields=raw[raw.rindex(')')+2:].split()
  if fields[19]==r['start']: signal.pidfd_send_signal(fd,getattr(signal,sys.argv[1]))
 except (ProcessLookupError,FileNotFoundError): pass
 except OSError as e:
  if e.errno != errno.EINVAL: raise
  # An exiting thread-group leader can refuse pidfd_open. Never fall back
  # to numeric kill; a still-live target remains in the survivor report.
 finally:
  if fd is not None: os.close(fd)
`;
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Identity signalling unsupported");
  const pending = exec("/usr/bin/python3", ["-c", source, signal], {
    timeout: 2000,
    signal: abort,
  });
  // stdin avoids command-line length limits and keeps process details off ps.
  pending.child.stdin?.on("error", () => {});
  pending.child.stdin?.end(JSON.stringify(records));
  await pending;
}
export async function signalOwned(
  tree: OwnedTree,
  signal: NodeJS.Signals,
  includeRoot = false,
  io: {
    table: typeof processTable;
    kill?: typeof process.kill;
    observe?: typeof processIdentity;
    abort?: AbortSignal;
  } = { table: processTable, observe: processIdentity },
) {
  io.abort?.throwIfAborted();
  refreshOwnedTree(tree, await io.table(io.abort));
  const records = [...tree.members.values()]
    .reverse()
    .filter(
      (record) =>
        !tree.excluded.has(record.pid) &&
        record.pid > 1 &&
        record.pid !== process.pid &&
        (includeRoot || record.pid !== tree.root.pid),
    );
  if (!io.kill) {
    await signalIdentities(records, signal, io.abort);
    return;
  }
  for (const record of records) {
    io.abort?.throwIfAborted();
    if (
      tree.excluded.has(record.pid) ||
      record.pid <= 1 ||
      record.pid === process.pid ||
      (!includeRoot && record.pid === tree.root.pid)
    )
      continue;
    // Read immediately before every signal; never signal a numeric process group.
    if (
      !sameProcess(
        record,
        io.observe
          ? await io.observe(record.pid, io.abort)
          : (await io.table()).find((r) => r.pid === record.pid),
      )
    )
      continue;
    try {
      if (io.kill) io.kill(record.pid, signal);
      else await signalIdentity(record, signal, io.abort);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
export async function survivingOwned(tree: OwnedTree, includeRoot = false, signal?: AbortSignal) {
  const rows = await processTable(signal);
  refreshOwnedTree(tree, rows);
  return [...tree.members.values()].filter(
    (r) =>
      !tree.excluded.has(r.pid) &&
      (includeRoot || r.pid !== tree.root.pid) &&
      sameProcess(
        r,
        rows.find((p) => p.pid === r.pid),
      ),
  );
}
export async function cleanupOwnedTree(
  tree: OwnedTree,
  graceMs = 250,
  includeRoot = false,
  timeoutMs = 1500,
) {
  const controller = new AbortController();
  const timer = Effect.runFork(
    Effect.sleep(timeoutMs).pipe(
      Effect.andThen(
        Effect.sync(() => controller.abort(new Error("Process cleanup deadline exceeded"))),
      ),
    ),
  );
  const io = { table: processTable, observe: processIdentity, abort: controller.signal };
  try {
    await signalOwned(tree, "SIGTERM", includeRoot, io);
    const deadline = performance.now() + graceMs;
    while (
      (await survivingOwned(tree, includeRoot, controller.signal)).length &&
      performance.now() < deadline
    ) {
      controller.signal.throwIfAborted();
      await sleep(25, undefined, { signal: controller.signal });
    }
    await signalOwned(tree, "SIGKILL", includeRoot, io);
  } finally {
    await Effect.runPromise(Fiber.interrupt(timer));
  }
}
