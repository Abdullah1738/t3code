import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const WINDOW_MS = 10 * 60_000;

export function planNotification(report, state, now = Date.now()) {
  if (state.pending) return state;
  const hour = new Date(now).toISOString().slice(0, 13);
  if (report.lag.severeMinutes >= 3 && state.lastAlertHour !== hour) {
    return { ...state, pending: { kind: "alert", key: `robob-stall:${hour}`, text: report.summary, at: now } };
  }
  if (state.active && now - state.active.at >= WINDOW_MS && report.verdict === "healthy" && report.lag.status === "complete" && report.lag.stalls5s === 0 && report.connection.status === "ok" && report.roundTrip.status === "ok" && report.roundTrip.ms < 2000) {
    return { ...state, pending: { kind: "recovered", key: `${state.active.key}:recovered`, text: "Robob recovered: 10 min with no stalls >=5s; state read under 2s.", at: now } };
  }
  return state;
}

export function accepted(state, now = Date.now()) {
  const { pending, ...rest } = state;
  return pending.kind === "alert"
    ? { ...rest, active: { key: pending.key, at: pending.at }, lastAlertHour: new Date(now).toISOString().slice(0, 13) }
    : { ...rest, active: null };
}

export function notify(pending, run = execFileSync) {
  const cli = process.env.ROBOB_WATCH_TELEGRAM_CLI ?? path.join(os.homedir(), ".local/share/telegram-bridge/src/cli.ts");
  const result = JSON.parse(run(path.join(os.homedir(), ".bun/bin/bun"), [cli, "notify", "--source", "Robob stalls", "--severity", pending.kind === "alert" ? "attention" : "info", `--text=${pending.text}`, `--key=${pending.key}`], { encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024, env: { ...process.env, BUN_INSPECT: "" } }));
  if (!/^notify:[a-f0-9]{64}$/.test(result?.id) || typeof result.created !== "boolean") throw new Error("Telegram did not accept the notification");
}

export async function tick({ report, dir, send = notify, now = Date.now() }) {
  const file = path.join(dir, "stall-state.json");
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const save = state => {
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const state = planNotification(report, previous, now);
  if (!state.pending) return;
  // Persist the exact key/text before sending: a lost acknowledgement replays
  // the identical payload, which Telegram's durable queue deduplicates.
  save(state);
  await send(state.pending);
  save(accepted(state, now));
}

export function isLiveRun(env = process.env) {
  return Boolean(env.WATCH_RUN && !env.WATCH_RUN.startsWith("prime-") && !env.ROBOB_TEST && !env.PYTEST_CURRENT_TEST && env.NODE_ENV !== "test");
}

async function main() {
  const cli = process.env.ROBOB_T3CTL ?? path.join(os.homedir(), ".local/bin/t3ctl");
  let output;
  try {
    output = execFileSync(process.execPath, [cli, "health", "--deep", "--json"], { encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024 });
  } catch (error) {
    if (![1, 2].includes(error.status)) throw error;
    output = error.stdout;
  }
  const report = JSON.parse(output);
  if (typeof report.summary !== "string" || !report.lag || !report.roundTrip || !report.connection) throw new Error("Invalid health report");
  // Prime runs have a prime- id; scratch tests have no run id. Neither may send.
  if (!isLiveRun()) {
    console.error(`dry run: ${report.summary}`);
    return;
  }
  await tick({ report, dir: process.env.WATCH_DIR });
  // Empty stdout is deliberate: this check sends Telegram directly, never wakes an agent.
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("robob-stall check failed; pending notification retained"); process.exitCode = 1; });
}
