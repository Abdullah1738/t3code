import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandTelemetry } from "../src/log-format.ts";

if (process.env.HEALTH_TIMING_CHILD !== "1") {
  test("health timing assertions run with isolated runner imports", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, BUN_INSPECT: undefined, HEALTH_TIMING_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
    const [code, stdout, stderr] = await Promise.all([child.exited, output, error]);
    expect(code, stdout + stderr).toBe(0);
  }, 30_000);
} else {

const sandbox = mkdtempSync(join(tmpdir(), "health-timing-"));
const runtime = resolve(process.env.HEALTH_TIMING_RUNTIME ?? join(import.meta.dir, ".."));
const root = join(sandbox, "root");
const healthLogs = join(sandbox, "health");
const toolLogs = join(sandbox, "tools");
const home = join(sandbox, "home");
mkdirSync(home);
Object.assign(process.env, { HOME: home, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: root,
  ROBOB_WATCH_LOAD_OVERRIDE: "0.1", TOOLLOG_DIR: toolLogs, HEALTH_TOOLLOG_DIR: healthLogs });
const lib = await import(join(runtime, "src/lib.ts"));
const { tickOne } = await import(join(runtime, "src/runner.ts"));
lib.ensureDirs();
const python = Bun.which("python3")!;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

for (const kind of ["schedule", "retry", "missing", "zero", "negative", "trigger", "probe", "final"] as const) {
  if (kind === "probe" && !("failureProbeDue" in lib)) continue;
  test(`real runner passes ${kind} timing through runCheck and the Python span`, async () => {
    const id = "meds-nag";
    const dir = lib.watcherDir(id);
    mkdirSync(dir, { recursive: true });
    const resultFile = join(sandbox, `${kind}.json`);
    const check = join(sandbox, `${kind}.py`);
    writeFileSync(check, `import json, os, sys\nfrom pathlib import Path\nfrom unittest import mock\nsys.path.insert(0, ${JSON.stringify(runtime)})\nimport toollog\nentered = toollog.utcnow()\nwith mock.patch.object(toollog, 'utcnow', return_value=entered):\n    with toollog.run('meds-nag', name='watcher.run', trigger=toollog.trigger()):\n        pass\nPath(${JSON.stringify(resultFile)}).write_text(json.dumps({'enteredMs': entered.timestamp() * 1000, 'scheduledAt': os.environ.get('HEALTH_TOOLLOG_SCHEDULED_AT')}))\n`);
    const signal = join(sandbox, "trigger");
    writeFileSync(signal, "new");
    const due = Date.now() - 30_000;
    const watcher = lib.normalize({ id, title: "timing fixture", check: `${quote(python)} -I ${quote(check)}`,
      interval_s: 300, mode: "notify", ...(kind === "trigger" ? { triggers: [signal] } : {}) });
    writeFileSync(join(dir, "watcher.json"), JSON.stringify(watcher));
    const initial = { status: "active" as const, fires: 0, consecutive_failures: 0, failure_alerted: false,
      ...(kind === "missing" ? {} : { next_at: kind === "zero" ? 0 : kind === "negative" ? -1 : due }),
      ...(kind === "retry" ? { load_timeouts: 1 } : {}),
      ...(kind === "trigger" ? { next_at: Date.now() + 300_000, trigger_sig: "old", last_run_at: new Date(0).toISOString() } : {}),
      ...(kind === "probe" ? { next_at: -1, failure_paused_at: new Date(Date.now() - 60_000).toISOString(),
        failure_probe_next_at: new Date(due).toISOString(), failure_probe_attempts: 0 } : {}),
      ...(kind === "final" ? { status: "closing" as const, closing_until: Date.now() - 1, closing_watcher: watcher } : {}) };
    lib.saveState(id, initial);
    await tickOne(id);
    const timing = JSON.parse(readFileSync(resultFile, "utf8"));
    const rows = readdirSync(healthLogs).filter(name => name.endsWith(".ndjson"))
      .flatMap(name => readFileSync(join(healthLogs, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    const row = rows.at(-1);
    expect(row.name).toBe("watcher.run");
    expect(row.ok).toBe(true);
    expect(typeof row.props.hostLoad1m).toBe("number");
    if (kind === "schedule" || kind === "retry" || kind === "probe") {
      expect(timing.scheduledAt).toBe(new Date(due).toISOString());
      expect(Date.parse(row.props.scheduledAt)).toBe(due);
      expect(row.props.startLagMs).toBeCloseTo(timing.enteredMs - due, 1);
      expect(row.props.startLagMs).toBeGreaterThanOrEqual(30_000);
    } else {
      expect(timing.scheduledAt).toBe("");
      expect(row.props.scheduledAt).toBeUndefined();
      expect(row.props.startLagMs).toBeNull();
    }
    const runs = readdirSync(toolLogs).filter(name => name.endsWith(".ndjson"))
      .flatMap(name => readFileSync(join(toolLogs, name), "utf8").trim().split("\n").flatMap(line => expandTelemetry(JSON.parse(line))))
      .filter(row => row.name === "watch.run");
    expect(runs.at(-1)!.props).toMatchObject({ exitCode: 0, outcome: "no_change" });
  });
}
}
