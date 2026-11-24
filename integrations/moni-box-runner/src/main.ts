import { BoxWatchers } from "./watchers.ts";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../spectrum-bridge/src/store.ts";
import { Shares, cloudflaredTunnel, shareRoute } from "../../spectrum-bridge/src/share.ts";
import { BoxRunner, type RunnerConfig } from "./runner.ts";
import { claudeHarness } from "./claude.ts";
import { antigravityHarness } from "./antigravity.ts";
import { moniSystemPrompt } from "./prompt.ts";
import { createRouterReadinessTracker, routerConfig, routerReady } from "./router-auth.ts";

export function loadRunnerConfig(path: string) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const secret = (key: string) => readFileSync(config[key], "utf8").trim();
  const harness = config.harness ?? "claude";
  if (harness !== "claude" && harness !== "antigravity") throw new Error("Invalid harness");
  if (harness === "antigravity" && (typeof config.antigravity !== "string" || !config.antigravity.startsWith("/"))) throw new Error("Invalid antigravity directory");
  return { ...config, ...routerConfig(config), harness, model: config.model ?? (harness === "antigravity" ? "ag/gemini-4-neon-high" : "claude-opus-5-5"), token: secret("tokenFile"), callbackToken: secret("callbackTokenFile"),
    privateKey: secret("privateKeyFile"), system: moniSystemPrompt(secret("systemFile")) } as RunnerConfig & ReturnType<typeof routerConfig> & { port: number; harness: "claude" | "antigravity"; claude: string; antigravity: string; model: string; cloudflared: string };
}
export async function startShareMaintenance(shares: Pick<Shares, "restore" | "sweep">, log: (code: string) => void,
  schedule: (tick: () => Promise<void>, ms: number) => unknown = (tick, ms) => setInterval(() => void tick(), ms)) {
  try { await shares.restore(); } catch { log("share-restore-error"); }
  schedule(async () => { try { await shares.sweep(); } catch { log("share-sweep-error"); } }, 30_000);
}
if (import.meta.main) {
  const config = loadRunnerConfig(process.env.MONI_RUNNER_CONFIG!);
  for (const dir of ["work", "claude", "antigravity", "apps"]) mkdirSync(join(config.root, dir), { recursive: true, mode: 0o700 });
  const shares = new Shares({ store: new Store(join(config.root, "shares.sqlite")), appsRoot: join(config.root, "apps"), startTunnel: cloudflaredTunnel(config.cloudflared), log: () => {} });
  process.once("exit", () => shares.killAll());
  await startShareMaintenance(shares, code => console.log(JSON.stringify({ code })));
  const routerReadiness = createRouterReadinessTracker(event => console.log(JSON.stringify(event)));
  const harnessLog = (code: string, detail?: object) => console.log(JSON.stringify({ code, ...detail }));
  const harness = config.harness === "antigravity"
    ? antigravityHarness(config.root, config.antigravity, config.model, config, harnessLog)
    : claudeHarness(config.root, config.claude, config.model, config, harnessLog);
  console.log(JSON.stringify({ code: "harness", harness: config.harness, model: config.model }));
  const runner = new BoxRunner(config, harness, {
    log: (code, ms, detail) => console.log(JSON.stringify({ code, ms, ...detail })),
    modelReady: () => routerReady(config, routerReadiness),
    share: async (path, body) => { const result = await shareRoute(shares, path, body); if (result.status >= 400) throw new Error("Share failed"); return result.body; },
  });
  const watchers = new BoxWatchers(runner);
  runner.watch = async (body) => { if (body.remove) watchers.remove(String(body.remove)); else watchers.add(body as unknown as import("./watchers.ts").BoxWatch); };
  setInterval(() => void watchers.tick(), 1_000);
  Bun.serve({ hostname: "127.0.0.1", port: config.port, maxRequestBodySize: 28 * 1024 * 1024, fetch: runner.handle });
  setInterval(() => void runner.tick(), 1_000);
}
