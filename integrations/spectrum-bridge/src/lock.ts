import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

/** Kernel ownership survives socket cleanup and is released automatically on process death. */
export function acquireLock(path: string): () => void {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const info = fstatSync(fd);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    closeSync(fd);
    throw new Error("Unsafe bridge lock file");
  }
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  if (library.symbols.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    library.close();
    throw new Error("Bridge is already running");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    library.close();
  };
}
