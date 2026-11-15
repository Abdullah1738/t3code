import { join } from "node:path";
import type { Harness } from "./runner.ts";

export function claudeHarness(root: string, executable: string, model: string): Harness {
  return { async run(input) {
    const child = Bun.spawn([executable, "-p", "--output-format", "json", "--model", model,
      "--permission-mode", "bypassPermissions", "--system-prompt", input.system,
      ...(input.resume ? ["--resume", input.session] : ["--session-id", input.session])], {
      cwd: join(root, "work"), env: { HOME: process.env.HOME, PATH: process.env.PATH,
        CLAUDE_CONFIG_DIR: join(root, "claude"), MONI_RUNNER_CONFIG: process.env.MONI_RUNNER_CONFIG },
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    child.stdin.write(input.text); child.stdin.end();
    let output: string, exit: number;
    try { [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]); }
    finally { input.signal?.removeEventListener("abort", abort); }
    if (exit !== 0) throw new Error("Harness failed");
    const result = JSON.parse(output);
    if (result.is_error || typeof result.result !== "string") throw new Error("Invalid harness output");
    return result.result;
  } };
}
