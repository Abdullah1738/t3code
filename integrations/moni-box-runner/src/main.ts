import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../spectrum-bridge/src/store.ts";
import { Shares, cloudflaredTunnel, shareRoute } from "../../spectrum-bridge/src/share.ts";
import { BoxRunner, type RunnerConfig } from "./runner.ts";
import { claudeHarness } from "./claude.ts";

export function loadRunnerConfig(path: string) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const secret = (key: string) => readFileSync(config[key], "utf8").trim();
  return { ...config, token: secret("tokenFile"), callbackToken: secret("callbackTokenFile"),
    privateKey: secret("privateKeyFile"), system: secret("systemFile") } as RunnerConfig & { port: number; claude: string; model: string; cloudflared: string };
}
export async function startShareMaintenance(shares: Pick<Shares, "restore" | "sweep">, log: (code: string) => void,
  schedule: (tick: () => Promise<void>, ms: number) => unknown = (tick, ms) => setInterval(() => void tick(), ms)) {
  try { await shares.restore(); } catch { log("share-restore-error"); }
  schedule(async () => { try { await shares.sweep(); } catch { log("share-sweep-error"); } }, 30_000);
}
if (import.meta.main) {
  const config = loadRunnerConfig(process.env.MONI_RUNNER_CONFIG!);
  for (const dir of ["work", "claude", "apps"]) mkdirSync(join(config.root, dir), { recursive: true, mode: 0o700 });
  const shares = new Shares({ store: new Store(join(config.root, "shares.sqlite")), appsRoot: join(config.root, "apps"), startTunnel: cloudflaredTunnel(config.cloudflared), log: () => {} });
  process.once("exit", () => shares.killAll());
  await startShareMaintenance(shares, code => console.log(JSON.stringify({ code })));
  const runner = new BoxRunner(config, claudeHarness(config.root, config.claude, config.model), {
    log: (code, ms) => console.log(JSON.stringify({ code, ms })),
    share: async (path, body) => { const result = await shareRoute(shares, path, body); if (result.status >= 400) throw new Error("Share failed"); return result.body; },
  });
  Bun.serve({ hostname: "127.0.0.1", port: config.port, maxRequestBodySize: 28 * 1024 * 1024, fetch: runner.handle });
  setInterval(() => void runner.tick(), 1_000);
}
