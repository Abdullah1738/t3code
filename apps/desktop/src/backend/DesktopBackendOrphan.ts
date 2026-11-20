// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import * as NodeTimersPromises from "node:timers/promises";
import {
  processIdentity,
  sameProcess,
  signalIdentity,
  type ProcessIdentity,
} from "@t3tools/shared/ownedProcessTree";
import { reportBackendProcessAction } from "./DesktopBackendProcess.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export interface BackendListenerIdentity {
  readonly process: ProcessIdentity;
  readonly executable: string;
  readonly argv: readonly string[];
}
export interface BackendOrphanOwner {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly executable: string;
  readonly entryPath: string;
  readonly homeDir: string;
}

export function isOwnOrphan(owner: BackendOrphanOwner, listener: BackendListenerIdentity) {
  const argv = listener.argv;
  // Match the entry as a positional script, never a substring or a --require value.
  let script = 1;
  if (argv[script] === "--require") script += 2;
  return (
    owner.isPackaged &&
    !owner.isDevelopment &&
    listener.process.pid > 1 &&
    listener.process.ppid === 1 &&
    listener.executable === owner.executable &&
    argv[script] === owner.entryPath &&
    argv[script + 1] === "--base-dir" &&
    argv[script + 2] === owner.homeDir &&
    argv[script + 3] === "--bootstrap-fd" &&
    argv[script + 4] === "3" &&
    argv.length === script + 5
  );
}

const macArgv = String.raw`
import ctypes, json, struct, sys
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
mib=(ctypes.c_int*3)(1,49,int(sys.argv[1])); size=ctypes.c_size_t(1024*1024); buf=ctypes.create_string_buffer(size.value)
if lib.sysctl(mib,3,buf,ctypes.byref(size),None,0): raise OSError(ctypes.get_errno(),'KERN_PROCARGS2 failed')
data=buf.raw[:size.value]; argc=struct.unpack_from('i',data)[0]; pos=data.index(b'\0',4)+1
while pos<len(data) and data[pos]==0: pos+=1
args=[]
for _ in range(argc):
 end=data.index(b'\0',pos); args.append(data[pos:end].decode()); pos=end+1
print(json.dumps(args))
`;

async function inspectBackendListener(
  pid: number,
  signal: AbortSignal,
  platform: NodeJS.Platform,
): Promise<BackendListenerIdentity | undefined> {
  const before = await processIdentity(pid, signal);
  if (!before) return undefined;
  let executable: string;
  let argv: string[];
  if (platform === "linux") {
    executable = await NodeFSP.readlink(`/proc/${pid}/exe`);
    argv = (await NodeFSP.readFile(`/proc/${pid}/cmdline`, { signal })).toString().split("\0");
    if (argv.at(-1) === "") argv.pop();
  } else {
    executable = before.executable ?? "";
    const { stdout } = await exec("/usr/bin/python3", ["-I", "-c", macArgv, String(pid)], {
      timeout: 2000,
      signal,
    });
    argv = JSON.parse(stdout) as string[];
  }
  if (!sameProcess(before, await processIdentity(pid, signal))) return undefined;
  return { process: before, executable, argv };
}

async function listenerPids(port: number, signal: AbortSignal) {
  try {
    const { stdout } = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
      timeout: 2000,
      signal,
    });
    return [
      ...new Set(
        stdout
          .split("\n")
          .filter((line) => /^p\d+$/.test(line))
          .map((line) => Number(line.slice(1))),
      ),
    ];
  } catch (error) {
    if ((error as { code?: number }).code === 1) return [];
    throw error;
  }
}

export async function reclaimBackendPort(
  owner: BackendOrphanOwner & {
    readonly port: number;
    readonly isPortFree: () => Promise<boolean>;
  },
) {
  if (
    !owner.isPackaged ||
    owner.isDevelopment ||
    (owner.platform !== "darwin" && owner.platform !== "linux")
  )
    return;
  if (await owner.isPortFree()) return;
  const startedAt = performance.now();
  const signal = AbortSignal.timeout(10_000);
  const pids = await listenerPids(owner.port, signal);
  const refuse = (reason: string): never => {
    reportBackendProcessAction({
      message: "refused backend port reclaim",
      pid: pids[0] ?? 0,
      elapsedMs: performance.now() - startedAt,
      signals: [],
      evidence: { port: owner.port, pids, reason },
    });
    throw new Error(
      `Desktop backend port ${owner.port} is held by PID ${pids.join(", ") || "unknown"}: ${reason}.`,
    );
  };
  if (pids.length !== 1) return refuse("cannot prove exclusive ownership");
  const pid = pids[0]!;
  let listener: BackendListenerIdentity | undefined;
  try {
    listener = await inspectBackendListener(pid, signal, owner.platform);
  } catch {
    return refuse("process identity unavailable");
  }
  if (!listener || !isOwnOrphan(owner, listener))
    return refuse("listener is not this app's orphaned backend");
  const verified = listener;
  const signals: string[] = [];
  const send = async (name: "SIGTERM" | "SIGKILL") => {
    const current = await inspectBackendListener(pid, signal, owner.platform);
    if (!current) return;
    if (!sameProcess(verified.process, current.process) || !isOwnOrphan(owner, current))
      return refuse("listener identity changed");
    await signalIdentity(current.process, name, signal);
    signals.push(name);
  };
  try {
    await send("SIGTERM");
    const graceEnds = performance.now() + 5000;
    while (!(await owner.isPortFree())) {
      signal.throwIfAborted();
      if (performance.now() >= graceEnds) {
        await send("SIGKILL");
        break;
      }
      await NodeTimersPromises.setTimeout(50, undefined, { signal });
    }
    while (!(await owner.isPortFree())) {
      signal.throwIfAborted();
      await NodeTimersPromises.setTimeout(50, undefined, { signal });
    }
  } catch (error) {
    return refuse(String(error));
  }
  reportBackendProcessAction({
    message: "reclaimed orphaned backend",
    pid,
    elapsedMs: performance.now() - startedAt,
    signals,
    evidence: { port: owner.port, ...verified, homeDir: owner.homeDir },
  });
}
