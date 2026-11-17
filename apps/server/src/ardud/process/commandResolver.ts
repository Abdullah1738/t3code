// @effect-diagnostics nodeBuiltinImport:off -- serialized resolver runs only in the native spawn worker.
import type * as NodeFS from "node:fs";
import type * as NodePath from "node:path";
import type * as NodeChildProcess from "node:child_process";

// Self-contained for the bundled worker's toString bootstrap. Keep filesystem
// probes off the main thread along with posix_spawn itself.
export function createCommandResolver(fs: typeof NodeFS, path: typeof NodePath) {
  const workingDirectory = (options: NodeChildProcess.SpawnOptions) => {
    const cwd = String(options.cwd ?? process.cwd());
    return path.isAbsolute(cwd) ? cwd : `${process.cwd()}/${cwd}`;
  };
  return {
    resolve(command: string, options: NodeChildProcess.SpawnOptions) {
      if (
        // oxlint-disable-next-line t3code/no-global-process-runtime -- Serialized worker has no Effect runtime.
        process.platform === "win32" ||
        options.shell ||
        command.includes("/") ||
        command === "" ||
        (options.cwd !== undefined && typeof options.cwd !== "string")
      )
        return command;
      const env = options.env ?? process.env;
      const cwd = workingDirectory(options);
      for (const directory of (env.PATH ?? "/usr/bin:/bin").split(":")) {
        // Do not normalize `..`: a preceding symlink changes what it means to
        // the kernel, so lexical normalization could select a different tool.
        const base = path.isAbsolute(directory)
          ? directory
          : directory
            ? `${cwd}/${directory}`
            : cwd;
        const candidate = `${base.endsWith("/") ? base : `${base}/`}${command}`;
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          if (!fs.statSync(candidate).isFile()) continue;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") continue;
          // Let native lookup report unusual filesystem failures in PATH order.
          return command;
        }
        return candidate;
      }
      return command;
    },
  };
}
