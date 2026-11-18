import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function until(check: () => boolean, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  return check();
}

test("ordinary Python admission contention delays ticks without runner or owner-alert errors", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "watch-admission-contention-"));
  const root = join(sandbox, "root"), logs = join(sandbox, "logs");
  const holding = join(sandbox, "holding.json"), released = join(sandbox, "released");
  const helper = join(sandbox, "holder.py");
  writeFileSync(helper, `import json,os,sys,time\nfrom pathlib import Path\nsys.path.insert(0,${JSON.stringify(join(import.meta.dir, "../helpers"))})\nfrom watch_admission import admission\nwith admission() as allowed:\n assert allowed\n Path(${JSON.stringify(holding)}).write_text(json.dumps({"pid":os.getpid(),"pgid":os.getpgrp(),"holder":"watch_admission.admission"}))\n time.sleep(2)\nPath(${JSON.stringify(released)}).write_text("released")\n`);
  for (const [id, interval_s, check] of [
    ["held", 300, `/usr/bin/python3 -I ${JSON.stringify(helper)}`],
    ["cheap", 1, 'echo run >> "$WATCH_DIR/runs"'],
  ] as const) {
    const dir = join(root, "watchers", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "watcher.json"), JSON.stringify({ id, title: id, mode: "notify", interval_s, max_fires: 0, check }));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 0, next_at: 0 }));
  }
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/runner.ts")], { env: {
    ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: root, TOOLLOG_DIR: logs,
    ROBOB_WATCH_LOAD_OVERRIDE: ".1", ROBOB_WATCH_SSD_PATH: "/dev", ROBOB_WATCH_CHECK_TIMEOUT_MS: "10000",
  }, stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
  let holder: { pid: number; pgid: number; holder: string } | undefined;
  try {
    expect(await until(() => existsSync(holding))).toBe(true);
    holder = JSON.parse(readFileSync(holding, "utf8"));
    expect(holder!.holder).toBe("watch_admission.admission");
    expect(await until(() => existsSync(released))).toBe(true);
    const runs = join(root, "watchers/cheap/runs");
    expect(await until(() => existsSync(runs) && readFileSync(runs, "utf8").trim().split("\n").length >= 2)).toBe(true);
    child.kill("SIGTERM"); await child.exited;
    expect(child.exitCode).toBe(0);
    expect(await error).toBe("");
    const stdout = await output;
    const rows = readdirSync(logs).filter(name => name.endsWith(".ndjson"))
      .flatMap(name => readFileSync(join(logs, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    const failures = rows.filter(row => ["watch.runner_failed", "alert.imessage.dispatch_failed", "watch.tick_failed"].includes(row.error?.tag));
    console.info(JSON.stringify({ holder, failures: failures.map(row => ({ tag: row.error?.tag, watcher: row.ids?.watcher })) }));
    expect(failures).toEqual([]);
    expect(stdout).not.toContain("database is locked");
    expect(JSON.parse(readFileSync(join(root, "watchers/cheap/state.json"), "utf8")).consecutive_failures).toBe(0);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    if (holder) { try { process.kill(-holder.pgid, "SIGKILL"); } catch {} }
    await Promise.all([output, error]);
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 15000);
