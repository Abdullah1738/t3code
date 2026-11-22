import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Harness } from "./runner.ts";
import { HarnessFailure, markSideEffect, stderrTail, type HarnessExit } from "./harness-failure.ts";
import { readRouterKey, routerConfig, startRouterGate, ROUTER_KEY_ERROR } from "./router-auth.ts";

/**
 * Antigravity (agy ACP server, the runtime Robob's Antigravity provider runs) as Moni's harness.
 * One agy process per turn speaks ACP over stdio; the turn resumes the runner's long-lived session.
 * Model calls go to the box router gate with gateway auth: agy gets a per-run bearer token only,
 * and the gate swaps in the 9router key, so neither agy nor its tools can read the key.
 * The session runs in agy's "default" mode: every edit and command asks permission first, and the
 * harness records a possible side effect before allowing it (the Claude PreToolUse hook's job).
 */
export const AGY_EXECUTABLE = "agy_acp_server.par";
export const AGY_HARNESS = "localharness_external";
const SETUP_MS = 300_000;
const CANCEL_GRACE_MS = 5_000;
// Tool kinds that change nothing; everything else counts as a possible side effect.
const READ_ONLY = new Set(["read", "search", "think"]);

type Rpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type PermissionOption = { optionId: string; kind?: string };

export function antigravityBinaries(dir: string) {
  return { executable: join(dir, AGY_EXECUTABLE), harness: join(dir, AGY_HARNESS) };
}

/** Maps the runner's session id to agy's own session id (agy chooses its ids on session/new). */
export class SessionMap {
  constructor(private readonly path: string) {}
  private read(): Record<string, string> {
    try { const data = JSON.parse(readFileSync(this.path, "utf8")); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; }
    catch { return {}; }
  }
  get(session: string): string | undefined { const value = this.read()[session]; return typeof value === "string" && value ? value : undefined; }
  set(session: string, agySession: string) {
    // Only the current session matters; older mappings are dropped with each rotation.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ [session]: agySession }), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export function antigravityHarness(root: string, dir: string, model: string, config: Parameters<typeof routerConfig>[0],
  log: (code: string, detail?: HarnessExit | Record<string, string | number | boolean | null>) => void = () => {}): Harness {
  const router = routerConfig(config);
  const bins = antigravityBinaries(dir);
  const home = join(root, "antigravity");
  const sessions = new SessionMap(join(home, "sessions.json"));
  let refused = false;
  const ready = () => {
    try {
      readRouterKey(router.routerKeyFile);
      accessSync(bins.executable, constants.X_OK); accessSync(bins.harness, constants.X_OK);
      refused = false; return true;
    } catch { if (!refused) log(ROUTER_KEY_ERROR); refused = true; return false; }
  };
  return { ready, async run(input) {
    input.signal?.throwIfAborted();
    if (!ready()) throw new Error(ROUTER_KEY_ERROR);
    for (const path of [home, join(home, "antigravity-acp")]) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
    writeFileSync(join(home, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "gateway" } }), { mode: 0o600 });
    // agy unpacks about 1 GB per launch into TMPDIR; keep it on disk (/tmp is a small tmpfs) and remove it after.
    const tmp = join(root, "antigravity-tmp", randomBytes(6).toString("hex"));
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const token = randomBytes(24).toString("hex");
    const gate = startRouterGate(router, () => { if (!refused) log(ROUTER_KEY_ERROR); refused = true; }, { bearer: token });
    const caBundle = ["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/certs/ca-bundle.crt", "/etc/pki/tls/certs/ca-bundle.crt"].find(existsSync);
    const child = Bun.spawn([bins.executable], {
      cwd: join(root, "work"),
      env: { HOME: process.env.HOME, PATH: process.env.PATH, MONI_RUNNER_CONFIG: process.env.MONI_RUNNER_CONFIG,
        GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: "1", ANTIGRAVITY_HARNESS_PATH: bins.harness,
        AGY_ACP_ENABLE_GATEWAY_AUTH: "1", AGY_LLM_GATEWAY_URL: gate.url.origin, AGY_LLM_GATEWAY_API_KEY: token,
        AGY_LLM_GATEWAY_MODELS: model, PYTHONUNBUFFERED: "1", TMPDIR: tmp, BROWSER: "/bin/false",
        ...(caBundle ? { SSL_CERT_FILE: caBundle } : {}) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const tail = stderrTail(child.stderr);
    let nextId = 0, sessionId: string | undefined, text = "", closed = false;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const failure = (code: string) => { const error = new Error(code); for (const p of pending.values()) p.reject(error); pending.clear(); };
    const write = (message: Rpc) => { if (!closed) { child.stdin.write(JSON.stringify(message) + "\n"); child.stdin.flush(); } };
    const call = (method: string, params: unknown, timeoutMs?: number) => new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new Error(`timeout:${method}`)); }, timeoutMs) : undefined;
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      write({ jsonrpc: "2.0", id, method, params });
    });
    const permission = (message: Rpc) => {
      const options: PermissionOption[] = Array.isArray(message.params?.options) ? message.params.options : [];
      const allow = options.find(o => o.kind === "allow_once") ?? options.find(o => o.kind?.startsWith("allow"));
      const reject = options.find(o => o.kind === "reject_once") ?? options.find(o => o.kind?.startsWith("reject"));
      // A question for the user (no allow option) has nobody to answer it in a headless turn.
      if (!allow) return { outcome: { outcome: "cancelled" } };
      if (!markSideEffect(root, input.id)) {
        log("side-effect-mark-failed");
        return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    };
    const handle = (message: Rpc) => {
      if (message.method === undefined && typeof message.id === "number") {
        const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id);
        if (message.error) entry.reject(new Error(`rpc:${message.error.code}`)); else entry.resolve(message.result);
        return;
      }
      if (message.method === "session/request_permission" && message.id !== undefined) {
        write({ jsonrpc: "2.0", id: message.id, result: permission(message) }); return;
      }
      if (message.method === "session/update") {
        const update = message.params?.update ?? {};
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") text += String(update.content.text ?? "");
        else if (update.sessionUpdate === "tool_call") {
          // Only the reply after the last tool call is the answer (Claude's `result` semantics).
          text = "";
          if (!READ_ONLY.has(String(update.kind ?? ""))) markSideEffect(root, input.id);
        }
        return;
      }
      // The client offers no file system or terminal; refuse anything else agy asks for.
      if (message.method !== undefined && message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    };
    const reading = (async () => {
      const decoder = new TextDecoder(); let buffer = "";
      try {
        for await (const chunk of child.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
            const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let message: Rpc; try { message = JSON.parse(line); } catch { continue; }
            handle(message);
          }
        }
      } finally { closed = true; failure("agy-exited"); }
    })();
    const abort = () => {
      if (sessionId) write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, CANCEL_GRACE_MS).unref?.();
      failure("aborted");
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    const stage = { name: "initialize" };
    try {
      await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, SETUP_MS);
      const known = input.resume ? sessions.get(input.session) : undefined;
      const sessionParams = { cwd: join(root, "work"), mcpServers: [] };
      let configOptions: any[] | undefined;
      if (known) {
        stage.name = "resume";
        try { configOptions = (await call("session/resume", { sessionId: known, ...sessionParams }, SETUP_MS))?.configOptions; sessionId = known; }
        catch (error) { if (input.signal?.aborted || closed) throw error; log("agy-resume-failed"); }
      } else if (input.resume) log("agy-session-new", { reason: "no-mapping" });
      if (!sessionId) {
        stage.name = "new";
        const created = await call("session/new", sessionParams, SETUP_MS);
        if (typeof created?.sessionId !== "string" || !created.sessionId) throw new Error("agy-no-session");
        sessionId = created.sessionId as string; configOptions = created.configOptions;
        sessions.set(input.session, sessionId);
      }
      stage.name = "mode";
      await call("session/set_mode", { sessionId, modeId: "default" }, SETUP_MS);
      const modelOption = configOptions?.find(o => o?.id === "model");
      if (modelOption && !(modelOption.options ?? []).some((o: any) => o?.value === model)) throw new Error("agy-model-unavailable");
      if (modelOption?.currentValue !== model) {
        stage.name = "model";
        await call("session/set_config_option", { sessionId, configId: "model", value: model }, SETUP_MS);
      }
      stage.name = "prompt";
      text = "";
      const prompt = [{ type: "text", text: `<system_instructions>\n${input.system}\n</system_instructions>` }, { type: "text", text: input.text }];
      const result = call("session/prompt", { sessionId, prompt });
      input.onStarted?.();
      const { stopReason } = (await result) ?? {};
      if (stopReason !== "end_turn") throw new Error(`agy-stop:${String(stopReason)}`);
      return text;
    } catch (error) {
      input.signal?.throwIfAborted();
      if (child.exitCode === null) child.kill("SIGTERM");
      const exitCode = await Promise.race([child.exited, Bun.sleep(CANCEL_GRACE_MS).then(() => null)]);
      const detail: HarnessExit = { exitCode: typeof exitCode === "number" ? exitCode : null, signal: child.signalCode ?? null, stderrBytes: (await Promise.race([tail, Bun.sleep(1_000).then(() => new Uint8Array())])).length };
      // Error text can quote private content; only the stage and a fixed code are logged.
      log("harness-exit", { ...detail, stage: stage.name, error: error instanceof Error ? error.message.split(":")[0]! : "unknown" });
      throw new HarnessFailure(detail);
    } finally {
      input.signal?.removeEventListener("abort", abort);
      closed = true;
      try { child.stdin.end(); } catch { /* already closed */ }
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(CANCEL_GRACE_MS)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await reading.catch(() => {});
      gate.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  } };
}
