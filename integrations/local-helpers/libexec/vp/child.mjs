import { spawn } from "node:child_process";
import { constants } from "node:os";

export function runChild(file, args, options = {}, onMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", ...options });
    if (onMessage) child.on("message", onMessage);
    const handlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (status, signal) => {
      cleanup();
      resolve(status ?? (signal ? 128 + constants.signals[signal] : 1));
    });
  });
}
