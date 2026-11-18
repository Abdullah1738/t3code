// @effect-diagnostics nodeBuiltinImport:off - once-per-minute native libproc adapter, shared by the Promise-based sampler.
import * as NodeChildProcess from "node:child_process";

// resourceUsage().fsRead counts input operations, and is zero on Darwin. libproc
// supplies actual bytes for this PID, including its workers, excluding children.
const darwinSample = `import ctypes,json,sys
class Usage(ctypes.Structure):
 _fields_=[('uuid',ctypes.c_ubyte*16)]+[(name,ctypes.c_uint64) for name in 'user system idle interrupts pageins wired resident footprint start exit childuser childsystem childidle childinterrupts childpageins childelapsed read written'.split()]
usage=Usage()
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
if lib.proc_pid_rusage(int(sys.argv[1]),2,ctypes.byref(usage)) != 0: raise OSError('proc_pid_rusage')
print(json.dumps({'bytes':usage.read,'identity':str(usage.start)}))`;

export interface DiskReadSample {
  readonly bytes: number;
  readonly identity: string;
}

export async function sampleProcessDiskRead(
  platform: NodeJS.Platform,
): Promise<DiskReadSample | undefined> {
  // Linux /proc/<pid>/io includes waited-for children, whose historical reads
  // cannot be assigned to this interval. Report unavailable outside libproc.
  if (platform !== "darwin") return undefined;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(
        "/usr/bin/python3",
        ["-I", "-c", darwinSample, String(process.pid)],
        { timeout: 2000, maxBuffer: 4096 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const value: unknown = JSON.parse(stdout);
    if (
      typeof value === "object" &&
      value !== null &&
      "bytes" in value &&
      "identity" in value &&
      typeof value.bytes === "number" &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0 &&
      typeof value.identity === "string"
    )
      return { bytes: value.bytes, identity: value.identity };
  } catch {
    // A missing sampler never reports a fabricated zero-byte interval.
  }
  return undefined;
}

export function diskReadDelta(
  previous: DiskReadSample | undefined,
  current: DiskReadSample | undefined,
) {
  return previous !== undefined &&
    current !== undefined &&
    previous.identity === current.identity &&
    current.bytes >= previous.bytes
    ? current.bytes - previous.bytes
    : undefined;
}
