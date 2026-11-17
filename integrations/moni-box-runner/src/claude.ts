import { join } from "node:path";
import type { Harness } from "./runner.ts";
import { readRouterKey, routerConfig, routerSettings, startRouterGate, ROUTER_KEY_ERROR } from "./router-auth.ts";

export function claudeHarness(root: string, executable: string, model: string, config: Parameters<typeof routerConfig>[0], log: (code: string) => void = () => {}): Harness {
  const router = routerConfig(config);
  let refused = false;
  const unavailable = () => { if (!refused) log(ROUTER_KEY_ERROR); refused = true; };
  const ready = () => {
    try { readRouterKey(router.routerKeyFile); refused = false; return true; }
    catch { unavailable(); return false; }
  };
  return { ready, async run(input) {
    if (!ready()) throw new Error(ROUTER_KEY_ERROR);
    const settings = routerSettings(root, router.routerKeyFile);
    const gate = startRouterGate(router, unavailable);
    try {
    const child = Bun.spawn([executable, "-p", "--output-format", "json", "--model", model,
      "--setting-sources", "", "--settings", settings,
      "--permission-mode", "bypassPermissions", "--system-prompt", input.system,
      ...(input.resume ? ["--resume", input.session] : ["--session-id", input.session])], {
      cwd: join(root, "work"), env: { HOME: process.env.HOME, PATH: process.env.PATH,
        CLAUDE_CONFIG_DIR: join(root, "claude"), MONI_RUNNER_CONFIG: process.env.MONI_RUNNER_CONFIG,
        ANTHROPIC_BASE_URL: gate.url.origin,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
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
    } finally { gate.stop(true); }
  } };
}
