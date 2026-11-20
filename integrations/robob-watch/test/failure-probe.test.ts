import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalationText, normalize } from "../src/lib.ts";

const sandboxes: string[] = [];
afterEach(() => { for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true }); });
const source = join(import.meta.dir, "../src");
const base = Date.parse("2026-11-16T07:00:00Z");
function fixture(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "watch-probe-")); sandboxes.push(root);
  const dir = join(root, "watchers/probe"); mkdirSync(dir, { recursive: true });
  const definition = normalize({ id: "probe", title: "Probe test", check: 'echo run >> "$WATCH_DIR/runs"; echo broken >&2; exit 1',
    mode: "notify", context: "Test", interval_s: 5, max_fires: 0, ...extra });
  writeFileSync(join(dir, "watcher.json"), JSON.stringify(definition));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 0, failure_alerted: false }));
  const dbPath = join(root, "bridge.sqlite");
  const db = new Database(dbPath);
  db.exec("create table kv(key text primary key,value text); create table outbox(id text primary key,payload text,state text,attempts integer,providerId text);");
  db.query("insert into kv values ('route',?)").run(JSON.stringify({ id: "ses_owner" })); db.close();
  const bridge = join(root, "bridge.ts");
  writeFileSync(bridge, `import {appendFileSync,existsSync,readFileSync,writeFileSync} from "node:fs";
    import {Database} from "bun:sqlite";import {createHash} from "node:crypto";
    const args=process.argv.slice(2); appendFileSync(${JSON.stringify(join(root, "calls"))},JSON.stringify(args)+"\\n");
    if(existsSync(${JSON.stringify(join(root, "refuse"))})) process.exit(1);
    if(args[0]==="notify" && args.some(arg=>arg.includes(":auto-resumed:"))) {
      const receipt=${JSON.stringify(join(root, "recovery-receipt"))};
      if(!existsSync(receipt))writeFileSync(receipt,args.find(arg=>arg.startsWith("--key=")));
      const gate=${JSON.stringify(join(root, "notice-gate"))};
      if(existsSync(gate))await fetch(readFileSync(gate,"utf8"));
    }
    if(args[0]==="send") {
      const opt=n=>args.find(a=>a.startsWith("--"+n+"="))?.slice(n.length+3);
      const id="send:"+createHash("sha256").update(opt("key")).digest("hex");
      const spec=JSON.stringify({kind:"conversation",text:opt("text"),sessionId:opt("session")});
      const db=new Database(${JSON.stringify(dbPath)});
      db.query("insert or replace into kv values (?,?)").run("api:send:"+id,JSON.stringify({spec}));
      db.query("insert or ignore into outbox values (?,?,'sent',1,?)").run(id,spec,id);db.close();
    }
    console.log('{"created":true}');`);
  const env = { ...process.env, ROBOB_TEST: "1", BUN_INSPECT: "", ROBOB_WATCH_ROOT: root, TOOLLOG_DIR: join(root, "logs"),
    ROBOB_WATCH_LOAD_OVERRIDE: "0.1", ROBOB_WATCH_SPECTRUM_CLI: bridge, ROBOB_WATCH_TELEGRAM_CLI: bridge,
    ROBOB_WATCH_BRIDGE_DB: dbPath, ROBOB_WATCH_CHECK_TIMEOUT_MS: "500", ROBOB_WATCH_SSD_PATH: "/dev", ROBOB_WATCH_TEST_BATCH_MS: "0" };
  const start = (script: string) => Bun.spawn([process.execPath, "-e", `
      import {expect} from "bun:test";
      import {readFileSync,writeFileSync,existsSync,renameSync} from "node:fs";
      import {join} from "node:path";
      const lib=await import(${JSON.stringify(join(source, "lib.ts"))});
      const runner=await import(${JSON.stringify(join(source, "runner.ts"))});
      const alerts=await import(${JSON.stringify(join(source, "owner-alerts.ts"))});
      const root=${JSON.stringify(root)}, dir=${JSON.stringify(dir)};
      let clock=${base};Date.now=()=>clock;
      const at=minute=>clock=${base}+minute*60_000;
      const state=()=>lib.loadState("probe");
      const save=s=>lib.saveState("probe",s);
      const change=patch=>writeFileSync(join(dir,"watcher.json"),JSON.stringify({...lib.loadWatcher("probe"),...patch}));
      const tick=async(minute,force=false)=>{at(minute);if(force)save({...state(),next_at:0});await runner.tickOne("probe");
        await alerts.drainOwnerAlerts();await alerts.applyOwnerAlertResults("probe");};
      const failFive=async()=>{for(let n=0;n<5;n++)await tick(n*5,true);};
      ${script}
    `], { env, stdout: "pipe", stderr: "pipe" });
  const execute = async (script: string) => {
    const child = start(script);
    const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, error, out: code ? out : "" }).toEqual({ code: 0, error: "", out: "" });
  };
  const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const calls = () => existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(s => JSON.parse(s) as string[]) : [];
  const events = (name: string) => readdirSync(join(root, "logs")).filter(f => f.endsWith(".ndjson"))
    .flatMap(f => readFileSync(join(root, "logs", f), "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s))).filter(row => row.name === name);
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(source, "cli.ts"), ...args], { env });
  return { root, dir, env, start, execute, state, calls, events, cli };
}

test("five failures persist probes at 15, 30, 60, 60 minutes without new notices or episodes", async () => {
  const f = fixture();
  await f.execute(`
    await failFive(); const paused=state();
    expect(paused.failure_probe_attempts).toBe(0);
    expect(paused.failure_probe_next_at).toBe(lib.iso(${base}+35*60_000));
    await tick(34.99); expect(state().failure_probe_attempts).toBe(0);
    for(const [minute,next,attempt] of [[35,65,1],[65,125,2],[125,185,3],[185,245,4]]) {
      await tick(minute);
      expect(state()).toMatchObject({consecutive_failures:5,failing_since:paused.failing_since,
        failure_paused_at:paused.failure_paused_at,failure_probe_attempts:attempt,failure_probe_next_at:lib.iso(${base}+next*60_000)});
      expect(state().failure_episode).toBe(paused.failure_episode);
    }
  `);
  expect(f.calls()).toHaveLength(4);
  expect(f.events("watch.pause_probe")).toHaveLength(4);
  expect(f.events("watch.pause_probe")[0]).toMatchObject({ ok: false, props: {
    attempt: 1, ok: false, next_at: new Date(base + 65 * 60_000).toISOString(), error_first_line: "exit 1: broken", duration_ms: expect.any(Number),
  } });
  expect(f.cli("list").stdout.toString()).toContain("next probe 15:05 Dubai");
});

test("restart keeps next probe, overdue restarts run once, success clears pause and handles output normally", async () => {
  const f = fixture(); await f.execute("await failFive();");
  const next = f.state().failure_probe_next_at;
  await f.execute("await tick(30); expect(state().failure_probe_attempts).toBe(0);");
  expect(f.state().failure_probe_next_at).toBe(next);
  await f.execute(`await tick(300);await tick(300);expect(state().failure_probe_attempts).toBe(1);`);
  await f.execute(`
    change({check:'echo run >> "$WATCH_DIR/runs"; echo recovered-event'});
    await tick(330);expect(state().failure_paused_at).toBeUndefined();expect(state().fires).toBe(1);
    for(const field of ["failure_probe_next_at","failure_probe_attempts","failing_since","failure_episode","last_error","failure_escalated","failure_pause_escalation_fallback"])
      expect(state()[field]).toBeUndefined();
    expect(state().consecutive_failures).toBe(0); expect(state().next_at).toBe(clock+5_000);
    await tick(330);expect(state().fires).toBe(1);
    change({check:'echo run >> "$WATCH_DIR/runs"'});await tick(330.1);expect(state().fires).toBe(1);
  `);
  expect(f.events("watch.auto_resumed")).toHaveLength(1);
  expect(f.events("watch.auto_resumed")[0].props).toEqual({ paused_ms: 310 * 60_000, attempts: 2 });
  const recovery = f.calls().filter(args => args.some(a => a.includes(":auto-resumed:")));
  expect(recovery).toHaveLength(1);
  expect(recovery[0]!.join(" ")).toContain("5h10m paused (retry 2 passed)");
});

test("manual pause stops persisted probes; resume clears all failure and probe fields", async () => {
  const f = fixture(); await f.execute("await failFive();");
  expect(f.cli("pause", "probe").exitCode).toBe(0);
  expect(f.state().failure_probe_next_at).toBeUndefined();
  await f.execute("await tick(300);expect(state().failure_probe_attempts).toBeUndefined();");
  expect(readFileSync(join(f.dir, "runs"), "utf8").trim().split("\n")).toHaveLength(5);
  expect(f.cli("resume", "probe").exitCode).toBe(0);
  expect(f.state()).toMatchObject({ consecutive_failures: 0, next_at: 0, failure_alerted: false });
  expect(f.state().failure_paused_at).toBeUndefined();
});

test("opt-out retains manual-only pause wording and survives CLI replacement", async () => {
  const f = fixture({ failure_pause_probe: false });
  await f.execute("await failFive();await tick(300);");
  expect(f.state().failure_probe_next_at).toBeUndefined();
  expect(f.events("watch.pause_probe")).toHaveLength(0);
  expect(f.calls().at(-1)!.join(" ")).toContain("Fix it, then robob-watch resume probe");
  expect(f.cli("list").stdout.toString()).not.toContain("next probe");
  expect(escalationText(normalize({ id: "probe", title: "Probe", check: "false", mode: "notify", failure_pause_probe: false }), f.state(), 20)).toContain("will not check again until resumed");
  expect(f.cli("add", "--id", "probe", "--title", "Probe", "--check", "true", "--mode", "notify", "--replace", "--no-prime").exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(f.dir, "watcher.json"), "utf8")).failure_pause_probe).toBe(false);
});

test.each(["busy", "timeout", "loaded timeout"])("%s during a probe stays paused in the same episode", async kind => {
  const f = fixture(); await f.execute(`
    await failFive();const paused=state();
    change({check:${JSON.stringify(kind === "busy" ? "echo 'busy: msgs: updating' >&2; exit 75" : "sleep 5")}});
    ${kind === "loaded timeout" ? 'process.env.ROBOB_WATCH_LOAD_OVERRIDE="3";' : ""}
    await tick(35);
    expect(state()).toMatchObject({failure_paused_at:paused.failure_paused_at,failing_since:paused.failing_since,
      consecutive_failures:5,failure_probe_attempts:1,failure_probe_next_at:lib.iso(${base}+65*60_000)});
    expect(state().dependency_busy).toBeUndefined();
  `);
  expect(f.calls()).toHaveLength(4);
  expect(f.events("watch.pause_probe")).toHaveLength(1);
  if (kind === "busy") expect(f.events("watch.run").at(-1).props.outcome).toBe("busy");
});

test("owner opt-in gets one queued recovery iMessage across restarts and no generic recovery", async () => {
  const f = fixture({ owner_imessage_alerts: true });
  await f.execute("await failFive();");
  await f.execute(`change({check:"true"});await tick(35);await tick(36);`);
  await f.execute("await tick(37);");
  const sends = f.calls().filter(args => args[0] === "send");
  expect(sends).toHaveLength(2);
  expect(sends[0]!.join(" ")).toContain("is paused");
  expect(sends[1]!.join(" ")).toContain("running again on its own");
  expect(f.calls().filter(args => args.some(a => a.includes(":auto-resumed:")))).toHaveLength(0);
  expect(f.state().owner_imessage_episodes).toBeUndefined();
});

test("failed recovery notice persists, retries after restart with the same key", async () => {
  const f = fixture(); await f.execute("await failFive();");
  writeFileSync(join(f.root, "refuse"), "");
  await f.execute('change({check:"true"});await tick(35);');
  const key = f.state().failure_recovery_notices[0].key;
  rmSync(join(f.root, "refuse"));
  await f.execute("await tick(36);await tick(37);");
  expect(f.calls().filter(args => args[0] === "notify" && args.some(a => a.includes(key)))).toHaveLength(2);
  expect(f.state().failure_recovery_notices).toBeUndefined();
});

test("shutdown during a running probe preserves its pause and retries once after restart", async () => {
  const f = fixture(); await f.execute("await failFive();");
  let contacted!: () => void, release!: () => void;
  const contact = new Promise<void>(resolve => { contacted = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ port: 0, fetch: async () => { contacted(); await response; return new Response("ok"); } });
  const child = f.start(`change({check:${JSON.stringify(`curl -fsS ${server.url} >/dev/null`)}});await tick(35);`);
  const stderr = new Response(child.stderr).text(), stdout = new Response(child.stdout).text();
  try {
    await Promise.race([contact, child.exited.then(() => { throw new Error("probe exited before admission"); })]);
    const admitted = f.state();
    expect(admitted.failure_probe_attempts).toBe(1);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    release();
    expect(await stderr).toBe("");await stdout;
    expect(f.state()).toEqual(admitted);
    expect(f.events("watch.auto_resumed")).toHaveLength(0);
    await f.execute('change({check:"true"});await tick(65);await tick(66);');
    expect(f.state().failure_paused_at).toBeUndefined();
    expect(f.events("watch.auto_resumed")).toHaveLength(1);
    expect(f.calls().filter(args => args.some(arg => arg.includes(":auto-resumed:")))).toHaveLength(1);
  } finally {
    release();server.stop(true);
    if (child.exitCode === null) {child.kill("SIGKILL");await child.exited;}
  }
});

test("shutdown during an accepted recovery notice retries the same key without another delivery", async () => {
  const f = fixture(); await f.execute("await failFive();");
  let contacted!: () => void, release!: () => void;
  const contact = new Promise<void>(resolve => { contacted = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ port: 0, fetch: async () => { contacted(); await response; return new Response("ok"); } });
  writeFileSync(join(f.root, "notice-gate"), server.url.toString());
  const child = f.start('change({check:"true"});await tick(35);');
  const stderr = new Response(child.stderr).text(), stdout = new Response(child.stdout).text();
  try {
    await Promise.race([contact, child.exited.then(() => { throw new Error("recovery exited before acceptance"); })]);
    const accepted = f.state(), key = accepted.failure_recovery_notices[0].key;
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    release();
    expect(await stderr).toBe("");await stdout;
    expect(f.state()).toEqual(accepted);
    rmSync(join(f.root, "notice-gate"));
    await f.execute("await tick(36);await tick(37);");
    const calls = f.calls().filter(args => args.some(arg => arg.includes(":auto-resumed:")));
    expect(calls).toHaveLength(2);
    expect(calls.every(args => args.includes(`--key=${key}`))).toBe(true);
    expect(readFileSync(join(f.root, "recovery-receipt"), "utf8")).toBe(`--key=${key}`);
    expect(f.state().failure_recovery_notices).toBeUndefined();
    expect(f.events("watch.auto_resumed")).toHaveLength(1);
  } finally {
    release();server.stop(true);
    if (child.exitCode === null) {child.kill("SIGKILL");await child.exited;}
  }
});

test("legacy failure pause seeds from its original timestamp and keeps the schedule on restart", async () => {
  const f = fixture();await f.execute(`
    save({...state(),consecutive_failures:5,failure_alerted:true,failing_since:lib.iso(clock),failure_paused_at:lib.iso(clock)});
    await tick(10);expect(state().failure_probe_next_at).toBe(lib.iso(${base}+15*60_000));
  `);
  await f.execute("await tick(15);expect(state().failure_probe_attempts).toBe(1);");
});

test("maintenance holds an overdue probe without consuming an attempt, then releases one probe", async () => {
  const f = fixture({ depends: ["phone"] });
  await f.execute(`
    await failFive();const paused=state();at(300);
    writeFileSync(join(root,"maintenance.json"),JSON.stringify({depends:["phone"],until:lib.iso(clock+60_000),reason:"test"}));
    const refresh=async()=>{renameSync(dir,join(root,"saved"));await runner.tick();renameSync(join(root,"saved"),dir);};
    await refresh();await tick(300);expect(state()).toEqual(paused);
    at(302);await refresh();await tick(302);expect(state().failure_probe_attempts).toBe(1);
    await tick(302);expect(state().failure_probe_attempts).toBe(1);
  `);
});

test.each([0, 1])("maintenance starting during a probe restores its deadline and count after %i completed probes", async completed => {
  const f = fixture({ depends: ["phone"] });
  await f.execute(`
    await failFive();
    if (${completed}) await tick(35);
    const paused=state(), minute=${completed ? 65 : 35};
    let admitted, release;
    const started=new Promise(resolve=>admitted=resolve), released=new Promise(resolve=>release=resolve);
    const server=Bun.serve({port:0,fetch:async()=>{admitted();await released;return new Response("fixture failure");}});
    const refresh=async()=>{renameSync(dir,join(root,"saved"));await runner.tick();renameSync(join(root,"saved"),dir);};
    try {
      change({check:"curl -fsS "+server.url+"; exit 1"});
      const pending=tick(minute);
      await Promise.race([started,pending.then(()=>{throw new Error("probe did not contact fixture");})]);
      expect(state().failure_probe_attempts).toBe(${completed + 1});
      writeFileSync(join(root,"maintenance.json"),JSON.stringify({depends:["phone"],until:lib.iso(clock+60_000),reason:"test"}));
      await refresh();release();await pending;
      for(const field of ["failure_probe_attempts","failure_probe_next_at","failure_paused_at","failure_episode","failing_since","last_error"])
        expect(state()[field]).toEqual(paused[field]);
      await tick(minute+0.5);expect(state().failure_probe_attempts).toBe(${completed});
      change({check:"true"});at(minute+2);await refresh();await tick(minute+2);
      expect(state().failure_paused_at).toBeUndefined();
    } finally {release();server.stop(true);}
  `);
  expect(f.events("watch.auto_resumed")[0].props.attempts).toBe(completed + 1);
});

test.each([
  { hold: "maintenance", completed: 0 }, { hold: "maintenance", completed: 1 },
  { hold: "ssd", completed: 0 }, { hold: "ssd", completed: 1 },
])("$hold starting while a failed probe waits for the lock restores its schedule after $completed completed probes", async ({ hold, completed }) => {
  const f = fixture({ depends: [hold === "ssd" ? "ssd" : "phone"] });
  if (hold === "ssd") {
    f.env.ROBOB_WATCH_SSD_PATH = join(f.root, "ssd");
    symlinkSync("/dev", f.env.ROBOB_WATCH_SSD_PATH);
  }
  await f.execute(`
    const {Database}=await import("bun:sqlite");
    await failFive();
    if (${completed}) await tick(35);
    const paused=state(), minute=${completed ? 65 : 35};
    let admitted, release, waiting;
    const started=new Promise(resolve=>admitted=resolve), released=new Promise(resolve=>release=resolve);
    const contended=new Promise(resolve=>waiting=resolve);
    const server=Bun.serve({port:0,fetch:async()=>{admitted();await released;return new Response("fixture failure");}});
    const refresh=async()=>{renameSync(dir,join(root,"saved"));await runner.tick();renameSync(join(root,"saved"),dir);};
    const originalExec=Database.prototype.exec;
    let lock;
    try {
      change({check:"curl -fsS "+server.url+"; exit 1"});
      const pending=tick(minute);
      await Promise.race([started,pending.then(()=>{throw new Error("probe did not contact fixture");})]);
      lock=new Database(join(root,"relay-lock.sqlite"));lock.exec("BEGIN IMMEDIATE");
      Database.prototype.exec=function(sql) {
        try {return originalExec.call(this,sql);}
        catch(error) {if(sql==="BEGIN IMMEDIATE" && error.code==="SQLITE_BUSY")waiting();throw error;}
      };
      release();
      await Promise.race([contended,pending.then(()=>{throw new Error("probe did not wait for the relay lock");})]);
      if (${JSON.stringify(hold)} === "maintenance") {
        writeFileSync(join(root,"maintenance.json"),JSON.stringify({depends:["phone"],until:lib.iso(clock+60_000),reason:"test"}));
      } else renameSync(join(root,"ssd"),join(root,"ssd-held"));
      await refresh();
      lock.exec("ROLLBACK");lock.close();lock=undefined;
      await pending;
      for(const field of ["failure_probe_attempts","failure_probe_next_at","failure_paused_at","failure_episode","failing_since","last_error"])
        expect(state()[field]).toEqual(paused[field]);
      expect(state().next_at).toBe(0);
      await tick(minute+0.5);expect(state().failure_probe_attempts).toBe(${completed});
      if (${JSON.stringify(hold)} === "ssd") renameSync(join(root,"ssd-held"),join(root,"ssd"));
      change({check:"true"});at(minute+2);await refresh();await tick(minute+2);
      expect(state().failure_paused_at).toBeUndefined();
    } finally {
      Database.prototype.exec=originalExec;
      if(lock){lock.exec("ROLLBACK");lock.close();}
      release();server.stop(true);
    }
  `);
  expect(f.events("watch.pause_probe").filter(event => event.props.ok === false)).toHaveLength(completed);
  expect(f.events("watch.auto_resumed")[0].props.attempts).toBe(completed + 1);
});

test("probe diagnostics survive structured logging with bounded redacted errors", async () => {
  const f = fixture(); await f.execute(`
    await failFive();
    change({check:"echo 'failed token=SECRET https://host.invalid/private' >&2; exit 1"});
    await tick(35);
  `);
  const props = f.events("watch.pause_probe")[0].props;
  expect(props.error_first_line).toBe("exit 1: failed token=[redacted] [url]");
  expect(props.duration_ms).toBeNumber();
  expect(props.next_at).toBe(new Date(base + 65 * 60_000).toISOString());
});

test("pause and escalation wording advertise the persisted Dubai retry time", async () => {
  const f = fixture(); await f.execute("await failFive();");
  expect(f.calls().at(-1)!.join(" ")).toContain("15 min, 30 min, then hourly");
  expect(escalationText(normalize({ id: "probe", title: "Probe", check: "true", mode: "notify" }), f.state(), 20))
    .toContain("next at 11:35 Dubai");
  expect(f.cli("show", "probe").stdout.toString()).toContain("next probe 11:35 Dubai");
});

test("pause and escalation retries retain their original payload after a failed probe changes the schedule", async () => {
  const f = fixture({ mode: "wake", max_consecutive_failures: 1 });
  writeFileSync(join(f.root, "refuse"), "");
  await f.execute(`
    await tick(0); const paused=state();
    change({check:"echo changed-error >&2; exit 1"});await tick(15);await tick(16);
    expect(state().failure_pause_notice).toBe(paused.failure_pause_notice);
    expect(state().failure_pause_escalation).toBe(paused.failure_pause_escalation);
    expect(state().failure_pause_escalation_fallback).toBe(paused.failure_pause_escalation_fallback);
  `);
  for (const command of ["notify", "wake", "send"]) {
    const calls = f.calls().filter(args => args[0] === command);
    const keys = new Set(calls.map(args => args.find(arg => arg.startsWith("--key="))));
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      const texts = calls.filter(args => args.includes(key!)).map(args => args.find(arg => arg.startsWith("--text=")));
      expect(texts.length).toBeGreaterThan(1);
      expect(new Set(texts).size).toBe(1);
    }
    if (command === "send") expect([...keys].some(key => key?.includes(":escalate:"))).toBe(true);
  }
});

test.each([0, 1, "false", null, [], {}].map(value => ({value})))("probe opt-out rejects non-boolean %j", ({value}) => {
  expect(() => normalize({ id: "probe", title: "Probe", check: "true", failure_pause_probe: value } as never)).toThrow("failure_pause_probe");
});
