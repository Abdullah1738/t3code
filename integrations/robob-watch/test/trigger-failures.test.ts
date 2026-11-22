import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxes: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "watch-trigger-"));
  sandboxes.push(dir);
  return dir;
}
afterEach(() => { for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Each child loads its own ROOT and bridge stubs; the simulated clock never changes other suites.
function simulate(program: string, dir = fixture()) {
  const script = String.raw`
    import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { Database } from "bun:sqlite";
    const dir = process.env.FIXTURE_DIR;
    process.env.ROBOB_WATCH_BRIDGE_DB = join(dir, "bridge.sqlite");
    const db = new Database(process.env.ROBOB_WATCH_BRIDGE_DB);
    db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE IF NOT EXISTS inbound (id TEXT PRIMARY KEY, state TEXT)");
    db.query("INSERT OR REPLACE INTO kv VALUES ('route', ?)").run(JSON.stringify({id: "ses_fixture", generation: 1}));
    db.close();
    const stub = join(dir, "bridge.ts"), calls = join(dir, "calls");
    writeFileSync(stub, 'import {appendFileSync, existsSync} from "node:fs";'
      + 'appendFileSync(' + JSON.stringify(calls) + ', JSON.stringify(process.argv.slice(2))+"\\n");'
      + 'if (existsSync(' + JSON.stringify(join(dir, "fail-send")) + ')) process.exit(1);'
      + 'console.log(\'{"created":true}\');');
    process.env.ROBOB_WATCH_SPECTRUM_CLI = stub;
    process.env.ROBOB_WATCH_TELEGRAM_CLI = stub;
    const { normalize, watcherDir, loadState, saveState, hash } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))});
    const { tickOne } = await import(${JSON.stringify(join(import.meta.dir, "../src/runner.ts"))});
    const start = Date.parse("2026-11-15T10:31:00Z");
    let clock = start;
    Date.now = () => clock;
    const id = "fixture", trigger = join(dir, "PRIVATE-trigger"), state = () => loadState(id);
    const add = (extra = {}) => {
      mkdirSync(watcherDir(id), { recursive: true });
      writeFileSync(join(watcherDir(id), "watcher.json"), JSON.stringify(normalize({
        id, title: "Fixture", mode: "notify", check: 'echo run >> "$WATCH_DIR/runs"', context: "Isolated test",
        interval_s: 5, max_fires: 0, triggers: [trigger], ...extra,
      })));
      saveState(id, {status: "active", fires: 0, consecutive_failures: 0, failure_alerted: false});
    };
    const at = async second => { clock = start + second * 1000; await tickOne(id); };
    const readCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) : [];
    const rows = () => existsSync(process.env.TOOLLOG_DIR) ? readdirSync(process.env.TOOLLOG_DIR)
      .filter(f => f.endsWith(".ndjson")).flatMap(f => readFileSync(join(process.env.TOOLLOG_DIR, f), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)) : [];
    const runs = () => existsSync(join(watcherDir(id), "runs")) ? readFileSync(join(watcherDir(id), "runs"), "utf8").trim().split("\n").length : 0;
    const output = value => console.log(JSON.stringify(value));
    ${program}
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { env: {
    ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", FIXTURE_DIR: dir,
    ROBOB_WATCH_ROOT: join(dir, "root"), TOOLLOG_DIR: join(dir, "logs"), ROBOB_WATCH_LOAD_OVERRIDE: "0.1",
  } });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString().trim());
}

test("missing triggers use the interval for ten minutes without failures or notices", () => {
  const result = simulate(`
    add({interval_s: 60, mode: "wake"});
    for (let second = 0; second < 600; second++) await at(second);
    output({state: state(), calls: readCalls(), rows: rows(), runs: runs(), hash: hash(trigger).slice(0, 16)});
  `);
  expect(result.runs).toBe(10);
  expect(result.state).toMatchObject({consecutive_failures: 0, failure_alerted: false, trigger_sig: "missing"});
  expect(result.state.failure_paused_at).toBeUndefined();
  expect(result.state.failure_escalated).toBeUndefined();
  expect(result.state.failing_since).toBeUndefined();
  expect(result.calls).toHaveLength(0);
  expect(result.rows.filter((row: { kind: string }) => row.kind === "error")).toHaveLength(0);
  const missing = result.rows.filter((row: { name: string }) => row.name === "runner.trigger_missing");
  expect(missing).toHaveLength(1);
  expect(missing[0]).toMatchObject({component: "runner", kind: "event", ok: true, props: {
    triggerKind: "file", triggerPathHash: result.hash, missingSince: "2026-11-15T10:31:00.000Z",
  }});
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("an initial all-missing signature does not bypass a future interval", () => {
  const result = simulate(`
    add({interval_s: 60, triggers: [trigger, trigger + "/parent/child"]});
    saveState(id, {...state(), next_at: start + 60000});
    for (let second = 0; second < 60; second++) await at(second);
    const before = runs(); await at(60); await at(61);
    output({before, runs: runs(), state: state()});
  `);
  expect(result.before).toBe(0);
  expect(result.runs).toBe(1);
  expect(result.state.trigger_sig).toBe("missing|missing");
});

test("CLI add accepts absent paths and list shows the waiting trigger state", () => {
  const result = simulate(`
    const cli = args => {
      const child = Bun.spawnSync([process.execPath, ${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))}, ...args], {env: process.env});
      if (child.exitCode) throw new Error(child.stderr.toString());
      return child.stdout.toString();
    };
    cli(["add", "--id", id, "--title", "Fixture", "--mode", "notify", "--check", "true", "--interval", "60", "--trigger", trigger + "/parent/child", "--no-prime"]);
    await at(0); const waiting = cli(["list"]);
    mkdirSync(trigger + "/parent", {recursive: true}); writeFileSync(trigger + "/parent/child", "present");
    await at(2); const present = cli(["list"]);
    output({waiting, present, state: state()});
  `);
  expect(result.waiting).toContain("every 60s+trigger(waiting)");
  expect(result.present).toContain("every 60s+trigger ");
  expect(result.state.trigger_missing).toBeUndefined();
});

test("duplicate missing paths log once and a replacement does not claim the old path appeared", () => {
  const result = simulate(`
    add({triggers: [trigger, trigger]}); await at(0);
    const definition = JSON.parse(readFileSync(join(watcherDir(id), "watcher.json"), "utf8"));
    writeFileSync(join(watcherDir(id), "watcher.json"), JSON.stringify({...definition, triggers: []}));
    await at(1); output({state: state(), rows: rows()});
  `);
  expect(result.state.trigger_missing).toBeUndefined();
  expect(result.rows.filter((row: { name: string }) => row.name === "runner.trigger_missing")).toHaveLength(1);
  expect(result.rows.filter((row: { name: string }) => row.name === "runner.trigger_present")).toHaveLength(0);
});

test("missing trigger windows persist across restart and repeat at most hourly per watcher", () => {
  const dir = fixture();
  simulate(`
    add({interval_s: 60, mode: "wake", triggers: [trigger, trigger + "-wal"]});
    await at(0); output({});
  `, dir);
  const result = simulate(`
    await at(599); await at(3599); const before = rows();
    await at(3600); await at(3601); await at(7199); await at(7200);
    output({state: state(), rows: rows(), before, calls: readCalls()});
  `, dir);
  const events = result.rows.filter((row: { name: string }) => row.name.startsWith("runner.trigger_missing"));
  expect(events.map((row: { name: string }) => row.name)).toEqual([
    "runner.trigger_missing", "runner.trigger_missing", "runner.trigger_missing.repeat", "runner.trigger_missing.repeat",
  ]);
  expect(result.before.filter((row: { name: string }) => row.name === "runner.trigger_missing.repeat")).toHaveLength(0);
  expect(events.slice(2).map((row: { props: { missingForS: number } }) => row.props.missingForS)).toEqual([3600, 7200]);
  expect(events.every((row: { kind: string; ok: boolean }) => row.kind === "event" && row.ok)).toBe(true);
  expect(result.state.consecutive_failures).toBe(0);
  expect(result.state.failure_escalated).toBeUndefined();
  expect(result.calls).toHaveLength(0);
});

test("repeat windows and counts survive a runner restart", () => {
  const dir = fixture();
  const first = simulate(`
    symlinkSync(join(dir, "absent"), trigger);
    add({max_consecutive_failures: 0, failure_notice_after: 1000});
    for (let second = 0; second < 300; second++) { saveState(id, {...state(), next_at: 0}); await at(second); }
    output({state: state(), rows: rows()});
  `, dir);
  expect(first.state.consecutive_failures).toBe(300);
  const result = simulate(`
    for (let second = 300; second <= 600; second++) { saveState(id, {...state(), next_at: 0}); await at(second); }
    output({state: state(), rows: rows(), calls: readCalls()});
  `, dir);
  expect(result.state.consecutive_failures).toBe(601);
  expect(result.state.failure_paused_at).toBeUndefined();
  expect(result.calls).toHaveLength(0);
  const errors = result.rows.filter((row: { kind: string }) => row.kind === "error");
  expect(errors.map((row: { name: string }) => row.name)).toEqual(["runner.error", "runner.error.repeat", "runner.error.repeat"]);
  expect(errors.map((row: { props: { count: number } }) => row.props.count)).toEqual([1, 300, 300]);
  expect(errors.every((row: { props: { missingSince: string } }) => row.props.missingSince === "2026-11-15T10:31:00.000Z")).toBe(true);
});

test.each([1, 2, 8])("trigger failures honor max_consecutive_failures=%s even with a higher notice threshold", threshold => {
  const result = simulate(`
    symlinkSync(join(dir, "absent"), trigger);
    add({max_consecutive_failures: ${threshold}, failure_notice_after: 100});
    for (let second = 0; second < 1300; second++) await at(second);
    output({state: state(), calls: readCalls()});
  `);
  expect(result.state.consecutive_failures).toBe(threshold);
  expect(result.state.failure_paused_at).toBeString();
  expect(result.calls).toHaveLength(1);
});

test("present triggers keep the gap, interval fallback and change detection", () => {
  const result = simulate(`
    writeFileSync(trigger, "baseline"); add({interval_s: 60});
    await at(0); const initial = runs();
    await at(1); const unchanged = runs();
    writeFileSync(trigger, "changed content"); await at(1); const gap = runs();
    await at(2); const changed = runs();
    await at(61); const beforeInterval = runs();
    await at(62);
    output({initial, unchanged, gap, changed, beforeInterval, final: runs(), state: state(), rows: rows()});
  `);
  expect(result).toMatchObject({initial: 1, unchanged: 1, gap: 1, changed: 2, beforeInterval: 2, final: 3});
  expect(result.state.consecutive_failures).toBe(0);
  expect(result.rows.filter((row: { kind: string }) => row.kind === "error")).toHaveLength(0);
});

test("appearance, changes and disappearance drive checks with the trigger gap", () => {
  const result = simulate(`
    add({interval_s: 60, trigger_gap_s: 5}); await at(0);
    writeFileSync(trigger, "appeared"); await at(1); const early = runs();
    await at(4); const beforeGap = runs(); await at(5); const appeared = runs();
    writeFileSync(trigger, "changed content"); await at(10); const changed = runs();
    rmSync(trigger); await at(15); const disappeared = runs(); await at(16);
    output({early, beforeGap, appeared, changed, disappeared, state: state(), runs: runs(), rows: rows()});
  `);
  expect(result).toMatchObject({early: 1, beforeGap: 1, appeared: 2, changed: 3, disappeared: 4, runs: 4});
  expect(result.state.consecutive_failures).toBe(0);
  const missing = result.rows.filter((row: { name: string }) => row.name === "runner.trigger_missing");
  expect(missing).toHaveLength(2);
  const present = result.rows.filter((row: { name: string }) => row.name === "runner.trigger_present");
  expect(present).toHaveLength(1);
  expect(present[0]).toMatchObject({component: "runner", kind: "event", ok: true, props: {missingForS: 1}});
  expect(present[0].props.triggerPathHash).toMatch(/^[a-f0-9]{16}$/);
  expect(result.rows.filter((row: { kind: string }) => row.kind === "error")).toHaveLength(0);
});

test.each([false, true])("a present trigger changes alongside a missing trigger (missing first: %s)", missingFirst => {
  const result = simulate(`
    writeFileSync(trigger, "present");
    add({interval_s: 60, triggers: ${missingFirst} ? [trigger + "-absent", trigger] : [trigger, trigger + "-absent"]});
    await at(0); writeFileSync(trigger, "changed content"); await at(2);
    output({runs: runs(), state: state(), rows: rows(), calls: readCalls()});
  `);
  expect(result.runs).toBe(2);
  expect(result.state.consecutive_failures).toBe(0);
  expect(result.calls).toHaveLength(0);
  expect(result.rows.filter((row: { name: string }) => row.name === "runner.trigger_missing")).toHaveLength(1);
  expect(result.rows.filter((row: { kind: string }) => row.kind === "error")).toHaveLength(0);
});

test("a repaired dangling trigger respects backoff and clears the failure streak", () => {
  const result = simulate(`
    symlinkSync(join(dir, "absent"), trigger); add(); await at(0);
    rmSync(trigger); writeFileSync(trigger, "recovered"); await at(1); const early = runs();
    await at(5); const recovered = state();
    rmSync(trigger); symlinkSync(join(dir, "absent"), trigger); await at(10);
    output({early, recovered, state: state(), runs: runs(), rows: rows()});
  `);
  expect(result.early).toBe(0);
  expect(result.runs).toBe(1);
  expect(result.recovered).toMatchObject({consecutive_failures: 0, failure_alerted: false});
  expect(result.recovered.failing_since).toBeUndefined();
  expect(result.recovered.trigger_error).toBeUndefined();
  expect(result.state.consecutive_failures).toBe(1);
  const errors = result.rows.filter((row: { name: string }) => row.name === "runner.error");
  expect(errors).toHaveLength(2);
  expect(errors[1].props.missingSince).toBe("2026-11-15T10:31:10.000Z");
});

test.each(["dangling", "dangling-wal", "not-directory", "symlink-loop"])("trigger stat failure %s keeps #75 pause and notice behavior", form => {
  const result = simulate(`
    let path = trigger;
    if (${JSON.stringify(form)} === "dangling-wal") path += "-wal";
    if (${JSON.stringify(form)}.startsWith("dangling")) symlinkSync(join(dir, "absent"), path);
    if (${JSON.stringify(form)} === "not-directory") { writeFileSync(trigger, "file"); path += "/child"; }
    if (${JSON.stringify(form)} === "symlink-loop") symlinkSync(trigger, trigger);
    add({triggers: [path]});
    for (let second = 0; second < 600; second++) await at(second);
    output({state: state(), rows: rows(), calls: readCalls(), runs: runs()});
  `);
  expect(result.state.consecutive_failures).toBe(5);
  expect(result.state.failure_paused_at).toBeString();
  expect(result.runs).toBe(0);
  expect(result.rows.find((row: { name: string }) => row.name === "runner.error").props).toMatchObject({
    errnoCode: form === "not-directory" ? "ENOTDIR" : form === "symlink-loop" ? "ELOOP" : "ENOENT",
    triggerKind: form === "dangling-wal" ? "wal" : "file",
  });
  const texts = result.calls.map((args: string[]) => args.find(arg => arg.startsWith("--text=")));
  expect(texts.filter((text: string) => text.includes("paused after 5 failures"))).toHaveLength(1);
  expect(result.rows.filter((row: { name: string }) => row.name === "runner.trigger_missing")).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test("resume clears a trigger pause and a repaired trigger can check again", () => {
  const result = simulate(`
    symlinkSync(join(dir, "absent"), trigger);
    add({max_consecutive_failures: 1}); await at(0);
    rmSync(trigger); writeFileSync(trigger, "repaired");
    const cli = Bun.spawnSync([process.execPath, ${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))}, "resume", id], {env: process.env});
    if (cli.exitCode) throw new Error(cli.stderr.toString());
    const resumed = state(); await at(1);
    output({resumed, state: state(), runs: runs(), calls: readCalls()});
  `);
  expect(result.resumed).toMatchObject({consecutive_failures: 0, failure_alerted: false, next_at: 0});
  expect(result.resumed.trigger_error).toBeUndefined();
  expect(result.resumed.failure_paused_at).toBeUndefined();
  expect(result.state.consecutive_failures).toBe(0);
  expect(result.runs).toBe(1);
  expect(result.calls).toHaveLength(1);
});

test("a pending event still delivers when the trigger disappears", () => {
  const result = simulate(`
    add(); saveState(id, {...state(), pending: {key: "fixture-pending", event: "Already checked event", at: new Date(start).toISOString()}});
    await at(0); output({state: state(), runs: runs(), rows: rows(), calls: readCalls()});
  `);
  expect(result.state.fires).toBe(1);
  expect(result.state.pending).toBeUndefined();
  expect(result.state.consecutive_failures).toBe(0);
  expect(result.runs).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.rows.filter((row: { name: string }) => row.name === "runner.error")).toHaveLength(0);
});

const walConfigurations = [
  { label: "single WAL", paths: 'trigger + "-wal"' },
  { label: "WAL then database", paths: 'trigger + "-wal", trigger' },
  { label: "database then WAL", paths: 'trigger, trigger + "-wal"' },
];

for (const configuration of walConfigurations) {
  test(`${configuration.label} stays healthy as SQLite creates and removes its WAL`, () => {
    const result = simulate(`
      writeFileSync(trigger, "database"); add({interval_s: 600, triggers: [${configuration.paths}]});
      await at(0); const absentWal = state();
      writeFileSync(trigger + "-wal", "write"); await at(2); const appeared = runs();
      rmSync(trigger + "-wal"); await at(4); const disappeared = runs();
      writeFileSync(trigger + "-wal", "next write"); await at(6);
      output({absentWal, appeared, disappeared, runs: runs(), state: state(), rows: rows(), calls: readCalls()});
    `);
    expect(result.absentWal.consecutive_failures).toBe(0);
    expect(result.appeared).toBe(2);
    expect(result.disappeared).toBe(3);
    expect(result.runs).toBe(4);
    expect(result.state.consecutive_failures).toBe(0);
    expect(result.state.failure_paused_at).toBeUndefined();
    expect(result.calls).toHaveLength(0);
    expect(result.rows.filter((row: { kind: string }) => row.kind === "error")).toHaveLength(0);
  });

  for (const basePresent of [true, false]) for (const wal of ["absent", "present", "broken"] as const) {
    const healthy = wal !== "broken";
    test(`${configuration.label}: database ${basePresent ? "present" : "absent"}, WAL ${wal}`, () => {
      const result = simulate(`
        if (${basePresent}) writeFileSync(trigger, "database");
        if (${JSON.stringify(wal)} === "present") writeFileSync(trigger + "-wal", "write");
        if (${JSON.stringify(wal)} === "broken") symlinkSync(trigger + "-wal", trigger + "-wal");
        add({triggers: [${configuration.paths}]});
        for (let second = 0; second < 600; second++) await at(second);
        output({state: state(), runs: runs(), rows: rows(), calls: readCalls()});
      `);
      expect(result.runs).toBe(healthy ? 120 : 0);
      expect(result.state.consecutive_failures).toBe(healthy ? 0 : 5);
      expect(!!result.state.failure_paused_at).toBe(!healthy);
      expect(result.calls).toHaveLength(healthy ? 0 : 4);
      const errors = result.rows.filter((row: { kind: string }) => row.kind === "error");
      expect(errors).toHaveLength(healthy ? 0 : 1);
      expect(JSON.stringify(errors)).not.toContain("PRIVATE");
    }, 30_000); // Healthy cases start 120 real shells; macOS startup hooks exceed the default 5 s budget.
  }
}

test("trigger failures keep the fifteen-minute wake escalation and five-minute retry cap", () => {
  const result = simulate(`
    symlinkSync(join(dir, "absent"), trigger);
    add({mode: "wake", max_consecutive_failures: 0, failure_notice_after: 1000});
    await at(0);
    saveState(id, {...state(), next_at: 0}); await at(899); const before = readCalls();
    saveState(id, {...state(), next_at: 0}); await at(900); const escalated = state();
    saveState(id, {...state(), next_at: 0}); await at(1200);
    output({before, escalated, state: state(), calls: readCalls(), clock});
  `);
  expect(result.before).toHaveLength(0);
  expect(result.escalated.failure_escalated).toBe(true);
  expect(result.calls.filter((args: string[]) => args[0] === "wake")).toHaveLength(1);
  expect(result.calls.filter((args: string[]) => args[0] === "wake-status")).toHaveLength(2);
  expect(result.calls.filter((args: string[]) => args[0] === "send" || args[0] === "notify")).toHaveLength(0);
  expect(result.state.failure_escalation_pending?.channel).toBe("wake");
  expect(result.state.next_at - result.clock).toBeLessThanOrEqual(300_000);
});

test("a failed trigger pause notice retries its key after restart without another failure", () => {
  const dir = fixture();
  const first = simulate(`
    writeFileSync(join(dir, "fail-send"), "");
    symlinkSync(join(dir, "absent"), trigger);
    add({max_consecutive_failures: 1}); await at(0); output({state: state(), calls: readCalls()});
  `, dir);
  expect(first.state.failure_paused_at).toBeString();
  expect(first.state.failure_alerted).toBe(false);
  const second = simulate(`
    rmSync(join(dir, "fail-send")); await at(1); await at(2);
    output({state: state(), calls: readCalls(), rows: rows()});
  `, dir);
  expect(second.state.consecutive_failures).toBe(1);
  expect(second.state.failure_alerted).toBe(true);
  const keys = second.calls.map((args: string[]) => args.find(arg => arg.startsWith("--key=")));
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  expect(second.rows.filter((row: { name: string }) => row.name === "runner.error")).toHaveLength(1);
});
