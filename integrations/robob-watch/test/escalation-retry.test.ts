import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = join(import.meta.dir, "../src");
const opt = (args: string[], name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
function fixture(config: { wake?: number; send?: number; notify?: number; receipt?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "escalation-retry-")); roots.push(root);
  const dir = join(root, "watchers/broken"); mkdirSync(dir, { recursive: true });
  const db = new Database(join(root, "bridge.sqlite"));
  db.exec("create table kv(key text primary key,value text); insert into kv values ('route','{\"id\":\"ses_test\"}'); create table outbox(id text,payload text,state text,attempts integer,providerId text)");
  db.close();
  const stub = join(root, "bridge.ts");
  writeFileSync(stub, `import {appendFileSync,readFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    const root=${JSON.stringify(root)},args=process.argv.slice(2),c=JSON.parse(readFileSync(root+'/config','utf8'));
    const get=n=>args.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
    appendFileSync(root+'/calls',JSON.stringify(args)+'\\n');
    if(args[0]==='wake-status') {
      if(c.receipt) {console.log(JSON.stringify({id:'wake:'+createHash('sha256').update(get('key')).digest('hex'),state:c.receipt}));process.exit(0);}
      console.error(JSON.stringify({error:'Bridge request failed (HTTP 404)'}));process.exit(1);
    }
    const status=c[args[0]]??200;
    if(status===0) {console.error(JSON.stringify({error:'Bridge request timed out'}));process.exit(1);}
    if(status>=300) {console.error(JSON.stringify({error:'Bridge request failed (HTTP '+status+')'}));process.exit(1);}
    console.log(JSON.stringify({created:true}));`);
  writeFileSync(join(root, "config"), JSON.stringify(config));
  const env = { ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: root,
    TOOLLOG_DIR: join(root, "logs"), ROBOB_WATCH_BRIDGE_DB: join(root, "bridge.sqlite"),
    ROBOB_WATCH_SPECTRUM_CLI: stub, ROBOB_WATCH_TELEGRAM_CLI: stub, ROBOB_WATCH_LOAD_OVERRIDE: "0.1" };
  const execute = (script: string, initialize = true) => {
    const result = Bun.spawnSync([process.execPath, "-e", `
      import {expect} from 'bun:test';
      import {writeFileSync} from 'node:fs';
      const lib=await import(${JSON.stringify(join(source, "lib.ts"))});
      const {pauseNotice,tickOne}=await import(${JSON.stringify(join(source, "runner.ts"))});
      const {normalize,loadState,saveState,shouldEscalate,escalate,hash}=lib;
      let minute=0;Date.now=()=>Date.parse('2026-11-20T14:17:00Z')+minute*60000;
      const key='robob-watch:broken:escalate:'+hash('episode').slice(0,32);
      const watcher=normalize({id:'broken',title:'Broken',mode:'wake',context:'Repair it.',check:'echo broken >&2; exit 1',interval_s:5,max_consecutive_failures:0,failure_pause_probe:false});
      const path=${JSON.stringify(dir)};
      const define=w=>writeFileSync(path+'/watcher.json',JSON.stringify(w));${initialize ? 'define(watcher);' : ''}
      const state=()=>loadState('broken');
      const change=patch=>saveState('broken',{...state(),...patch});
      ${initialize ? `saveState('broken',{status:'active',fires:0,consecutive_failures:5,failure_alerted:true,
        failure_episode:'episode',failing_since:new Date(Date.now()-16*60000).toISOString(),last_error:'original failure',
        failure_paused_at:new Date(Date.now()).toISOString(),failure_escalation_key:key+':wake'});` : ''}
      ${script}
    `], { env });
    expect({ code: result.exitCode, err: result.stderr.toString(), out: result.stdout.toString() }).toEqual({ code: 0, err: "", out: "" });
  };
  const calls = () => existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
  const events = () => existsSync(join(root, "logs")) ? readdirSync(join(root, "logs")).filter(file => file.endsWith(".ndjson"))
    .flatMap(file => readFileSync(join(root, "logs", file), "utf8").trim().split("\n").map(line => JSON.parse(line))) : [];
  return { root, dir, execute, calls, events };
}

test("paused escalation persists its backoff instead of posting every second", () => {
  const f = fixture({ wake: 0, send: 0 });
  f.execute(`await pauseNotice(watcher,state());
    expect(state().failure_escalation_attempts).toBe(1);
    expect(state().failure_escalation_next_at).toBe(new Date(Date.now()+60000).toISOString());
    for(let second=1;second<60;second++){minute=second/60;await pauseNotice(watcher,state());}
    expect(state().failure_escalation_attempts).toBe(1);
    minute=1;await pauseNotice(watcher,state());expect(state().failure_escalation_attempts).toBe(2);`);
  expect(f.calls().filter(args => args[0] === "wake")).toHaveLength(2);
});

test("concurrent paused calls share one persisted retry window", () => {
  const f = fixture({ wake: 0, send: 0 });
  f.execute(`await Promise.all([pauseNotice(watcher,state()),pauseNotice(watcher,state())]);
    expect(state().failure_escalation_attempts).toBe(1);`);
  expect(f.calls().filter(args => args[0] === "wake")).toHaveLength(1);
});

test.each(["failing", "paused", "transition"])("%s retries freeze both payloads and separate the channel keys", phase => {
  const f = fixture({ wake: 0, send: 0 });
  f.execute(`
    ${phase !== "paused" ? 'change({failure_paused_at:undefined});' : ''}
    for(const n of [0,1,3]) {
      minute=n;
      change({last_error:'changed error '+n,consecutive_failures:5+n});
      if(n===1&&${JSON.stringify(phase)}==='transition') change({failure_paused_at:new Date(Date.now()).toISOString()});
      if(state().failure_paused_at) await pauseNotice(watcher,state());
      else await escalate(watcher,state(),key);
    }
    expect(state().failure_escalation_attempts).toBe(3);
  `);
  const wakes = f.calls().filter(args => args[0] === "wake");
  const sends = f.calls().filter(args => args[0] === "send");
  expect(wakes).toHaveLength(3); expect(sends).toHaveLength(3);
  for (const channel of [wakes, sends]) {
    expect(new Set(channel.map(args => opt(args, "text"))).size).toBe(1);
    expect(new Set(channel.map(args => opt(args, "key"))).size).toBe(1);
  }
  expect(opt(wakes[0]!, "key")).toEndWith(":wake");
  expect(opt(sends[0]!, "key")).toEndWith(":imsg");
  expect(opt(wakes[0]!, "key")).not.toBe(opt(sends[0]!, "key"));
});

test.each(["admitted", "queued", "failed", "ambiguous", "sending", "unavailable"])("409 stops wake posts with %s receipt", receipt => {
  const f = fixture({ wake: 409, receipt: receipt === "unavailable" ? undefined : receipt });
  f.execute(`await pauseNotice(watcher,state());expect(state().failure_escalated).toBe(true);
    for(minute=1;minute<=360;minute++) await pauseNotice(watcher,state());`);
  expect(f.calls().filter(args => args[0] === "wake")).toHaveLength(1);
  expect(f.calls().filter(args => args[0] === "wake-status")).toHaveLength(1);
  expect(f.calls().filter(args => args[0] === "send")).toHaveLength(0);
  const notices = f.calls().filter(args => args[0] === "notify");
  expect(notices).toHaveLength(receipt === "admitted" ? 0 : 1);
  if (notices.length) {
    expect(opt(notices[0]!, "key")).toContain(":escalate-undelivered:");
    expect(opt(notices[0]!, "severity")).toBe("attention");
    expect(opt(notices[0]!, "text")).toContain("original failure");
    expect(opt(notices[0]!, "text")).toContain(join(f.dir, "log"));
  }
  expect(f.events().filter(row => row.name === "wake.sent")).toEqual([
    expect.objectContaining({ props: { httpStatus: 409, attempt: 1 } }),
  ]);
});

test("failed Telegram after 409 follows persisted backoff for six hours without reposting the wake", () => {
  const f = fixture({ wake: 409, notify: 503 });
  f.execute(`for(minute=0;minute<=360;minute++) await pauseNotice(watcher,state());
    expect(state().failure_escalated).toBe(true);
    expect(state().failure_escalation_attempts).toBe(11);`);
  expect(f.calls().filter(args => args[0] === "wake")).toHaveLength(1);
  const notifications = f.calls().filter(args => args[0] === "notify");
  expect(notifications).toHaveLength(11);
  expect(new Set(notifications.map(args => opt(args, "key"))).size).toBe(1);
  expect(new Set(notifications.map(args => opt(args, "text"))).size).toBe(1);
});

test("three transport failures send one undelivered notice, even across later retries", () => {
  const f = fixture({ wake: 0, send: 0 });
  f.execute(`
    for(const n of [0,1,3,8,23,53,113]) {minute=n;await pauseNotice(watcher,state());}
    expect(state().failure_escalation_attempts).toBe(7);
    expect(state().failure_escalation_notice_sent).toBe(true);
    const cleared=state();lib.clearFailureState(cleared);saveState('broken',cleared);
    for(const field of ['failure_escalation_attempts','failure_escalation_next_at','failure_escalation_key',
      'failure_escalation_source','failure_escalation_notice','failure_escalation_notice_sent','failure_pause_escalation',
      'failure_pause_escalation_fallback']) expect(state()[field]).toBeUndefined();
  `);
  const notices = f.calls().filter(args => args[0] === "notify");
  expect(notices).toHaveLength(1);
  const rows = f.events().filter(row => row.name === "failure_escalation.undelivered");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ props: { attempt: 3, failureClass: "timeout" } });
});

test("legacy episode keeps its accepted wake key instead of moving to the new suffix", () => {
  const f = fixture({ wake: 409, receipt: "admitted" });
  f.execute(`change({failure_escalation_key:undefined});await pauseNotice(watcher,state());
    expect(state().failure_escalation_key).toBe(key);`);
  expect(opt(f.calls().find(args => args[0] === "wake")!, "key")).not.toEndWith(":wake");
  expect(f.calls().filter(args => args[0] === "send" || args[0] === "notify")).toHaveLength(0);
});

test("fallback 409 stops both channels and notifies once when its receipt is unproven", () => {
  const f = fixture({ wake: 0, send: 409 });
  f.execute(`await pauseNotice(watcher,state());expect(state().failure_escalated).toBe(true);
    for(minute=1;minute<=360;minute++) await pauseNotice(watcher,state());`);
  expect(f.calls().filter(args => args[0] === "wake")).toHaveLength(1);
  expect(f.calls().filter(args => args[0] === "send")).toHaveLength(1);
  expect(f.calls().filter(args => args[0] === "notify")).toHaveLength(1);
});

test("critical owner alerts keep the escalation fallback disabled while Telegram covers wake timeouts", () => {
  const f = fixture({ wake: 0 });
  f.execute(`for(const n of [0,1,3,8]) {minute=n;await escalate(watcher,state(),key,false);}`);
  expect(f.calls().filter(args => args[0] === "send")).toHaveLength(0);
  expect(f.calls().filter(args => args[0] === "notify")).toHaveLength(1);
});

test("failing-path attempts and payloads survive runner restarts and the transition to pause", () => {
  const f = fixture({ wake: 0, send: 0 });
  f.execute(`
    change({failure_paused_at:undefined,consecutive_failures:1,next_at:0});
    await tickOne('broken');
    expect(state().failure_escalation_attempts).toBe(1);
  `);
  f.execute(`const text=state().failure_pause_escalation;
    minute=0.5;change({next_at:0});await tickOne('broken');
    expect(state().failure_escalation_attempts).toBe(1);
    minute=1;define({...watcher,max_consecutive_failures:3});change({next_at:0});await tickOne('broken');
    expect(state().failure_paused_at).toBeString();
    expect(state().failure_escalation_attempts).toBe(2);
    expect(state().failure_pause_escalation).toBe(text);
  `, false);
  expect(f.calls().filter(args => args[0] === "wake")).toHaveLength(2);
});

test.each([false, true])("legacy send acceptance prevents a new fallback (matching=%s)", matching => {
  const f = fixture({ wake: 0, send: 200 });
  f.execute(`
    const {Database}=await import('bun:sqlite');
    const summary=lib.escalationFallbackText(watcher,state(),16);
    const spec=JSON.stringify({kind:'conversation',text:${matching ? 'summary' : "'previous legacy text'"},sessionId:'ses_test'});
    const db=new Database(${JSON.stringify(join(f.root, "bridge.sqlite"))});
    db.query('insert into kv values (?,?)').run('api:send:send:'+hash(key),JSON.stringify({spec}));
    db.query("insert into outbox values (?,?,'sent',1,'legacy-receipt')").run('send:'+hash(key),spec);db.close();
    change({failure_escalation_key:undefined});
    await pauseNotice(watcher,state());expect(state().failure_escalated).toBe(true);
  `);
  expect(f.calls().filter(args => args[0] === "send")).toHaveLength(0);
  expect(f.calls().filter(args => args[0] === "notify")).toHaveLength(matching ? 0 : 1);
});
