import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxes: string[] = [];
afterAll(() => { for (const path of sandboxes) rmSync(path, { recursive: true, force: true }); });
const source = join(import.meta.dir, "../src");
function fixture(opted = true, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "watcher-owner-alert-"));
  sandboxes.push(root);
  const dir = join(root, "watchers/critical");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "watcher.json"), JSON.stringify({ id: "critical", title: "Inbox triage",
    check: "echo 'settings.json EDEADLK' >&2; exit 1", mode: "wake", context: "Test", interval_s: 5, max_fires: 0,
    paused: false, ...(opted ? { owner_imessage_alerts: true } : {}), ...extra }));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ status: "active", fires: 0, consecutive_failures: 0, failure_alerted: false }));
  const bridgeDB = join(root, "bridge.sqlite");
  const db = new Database(bridgeDB);
  db.exec("create table kv(key text primary key,value text)");
  db.query("insert into kv values ('route',?)").run(JSON.stringify({ id: "ses_owner" })); db.close();
  const bridge = join(root, "bridge.ts");
  writeFileSync(bridge, `import {Database} from "bun:sqlite";
    import {createHash} from "node:crypto";
    import {appendFileSync,existsSync,readFileSync,writeFileSync} from "node:fs";
    const args=process.argv.slice(2),root=${JSON.stringify(root)};
    appendFileSync(root+"/calls",JSON.stringify(args)+"\\n");
    if(existsSync(root+"/fail-"+args[0])) {console.error("stub refusal");process.exit(1);}
    if(args[0]==="send") {
      const opt=n=>args.find(a=>a.startsWith("--"+n+"="))?.slice(n.length+3);
      const db=new Database(${JSON.stringify(bridgeDB)});
      const route=JSON.parse(db.query("select value from kv where key='route'").get().value);
      const key="api:send:send:"+createHash("sha256").update(opt("key")).digest("hex");
      const spec=JSON.stringify({kind:"conversation",text:opt("text"),sessionId:opt("session"),generation:route.generation});
      const prior=db.query("select value from kv where key=?").get(key);
      if(prior&&JSON.parse(prior.value).spec!==spec){console.error("409 route changed");process.exit(1);}
      db.query("insert or replace into kv values (?,?)").run(key,JSON.stringify({spec}));db.close();
      const saved=existsSync(root+"/accepted")?JSON.parse(readFileSync(root+"/accepted","utf8")):{};
      if(saved[opt("key")] && saved[opt("key")]!==opt("text")) {console.error("409 changed payload");process.exit(1);}
      saved[opt("key")]=opt("text");writeFileSync(root+"/accepted",JSON.stringify(saved));
    }
    console.log('{"created":true}');`);
  const environment = { ...process.env, ROBOB_TEST: "1", BUN_INSPECT: "", ROBOB_WATCH_ROOT: root,
    ROBOB_WATCH_LOAD_OVERRIDE: "0.1", TOOLLOG_DIR: join(root, "logs"), ROBOB_WATCH_BRIDGE_DB: bridgeDB,
    ROBOB_WATCH_SPECTRUM_CLI: bridge, ROBOB_WATCH_TELEGRAM_CLI: bridge };
  const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const define = (change: Record<string, unknown>) => writeFileSync(join(dir, "watcher.json"),
    JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "watcher.json"), "utf8")), ...change }));
  const execute = async (script: string) => {
    const child = Bun.spawn([process.execPath, "-e", script], { env: environment, stdout: "pipe", stderr: "pipe" });
    const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, error, out: code ? out : "" }).toEqual({ code: 0, error: "", out: "" });
  };
  const tick = async (minute: number, persistResult = true) => {
    await execute(`
      const lib=await import(${JSON.stringify(join(source, "lib.ts"))});
      const {tickOne}=await import(${JSON.stringify(join(source, "runner.ts"))});
      const alerts=await import(${JSON.stringify(join(source, "owner-alerts.ts"))});
      Date.now=()=>Date.parse("2026-11-16T07:51:00Z")+${minute}*60_000;
      const state=lib.loadState("critical");state.next_at=0;lib.saveState("critical",state);
      await tickOne("critical");await alerts.drainOwnerAlerts();
      ${persistResult ? 'alerts.applyOwnerAlertResults("critical");alerts.dispatchOwnerAlerts("critical");await alerts.drainOwnerAlerts();alerts.applyOwnerAlertResults("critical");' : ""}
    `);
  };
  const resume = () => {
    const result = Bun.spawnSync([process.execPath, join(source, "cli.ts"), "resume", "critical"], { env: environment });
    expect(result.exitCode).toBe(0);
  };
  const calls = () => existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
  const accepted = () => existsSync(join(root, "accepted")) ? Object.values(JSON.parse(readFileSync(join(root, "accepted"), "utf8"))) as string[] : [];
  const events = () => readFileSync(join(root, "logs", new Date().toISOString().slice(0, 10) + ".ndjson"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  const rotate = (id: string, generation: number) => {
    const db = new Database(bridgeDB);
    db.query("update kv set value=? where key='route'").run(JSON.stringify({ id, generation })); db.close();
  };
  return { root, state, define, tick, resume, execute, calls, accepted, events, rotate };
}

test("opted-in auto-pause texts once across two runner restarts and resume texts once", async () => {
  const f = fixture();
  for (let minute = 0; minute < 5; minute++) await f.tick(minute);
  expect(f.state().failure_paused_at).toBeString();
  await f.tick(6); await f.tick(7);
  expect(f.accepted()).toHaveLength(1);
  expect(f.calls().filter(args => args[0] === "send")).toHaveLength(1);
  expect(f.accepted()[0]).toContain("paused after 5 failed runs (since 11:51 Dubai): exit 1: settings.json EDEADLK");
  expect(f.calls().find(args => args[0] === "send")).toContain("--session=ses_owner");
  f.define({ check: "true" }); f.resume(); await f.tick(8); await f.tick(9);
  expect(f.accepted()).toHaveLength(2);
  expect(f.accepted()[1]).toContain("is running again");
  expect(f.accepted()[1]).toContain("Missed messages: checking.");
  expect(f.state().owner_imessage_episodes).toBeUndefined();
  expect(f.events().filter(row => row.name === "alert.imessage.sent").map(row => row.props.alertKind)).toEqual(["pause", "recovered"]);
}, 20_000);

test("bridge acceptance before a crash replays the same key and immutable payload", async () => {
  const f = fixture(true, { max_consecutive_failures: 1 });
  await f.tick(0, false);
  expect(f.state().owner_imessage_episodes[0].sent).toBeUndefined();
  await f.tick(2); await f.tick(3);
  expect(f.accepted()).toHaveLength(1);
  const sends = f.calls().filter(args => args[0] === "send");
  expect(sends).toHaveLength(1);
}, 10_000);

test("non-opted watcher and a manual resume without a prior notice send no iMessage", async () => {
  const f = fixture(false, { max_consecutive_failures: 1 });
  await f.tick(0); f.define({ check: "true" }); f.resume(); await f.tick(2);
  expect(f.calls().filter(args => args[0] === "send")).toHaveLength(0);
  const opted = fixture(); opted.resume(); await opted.tick(0);
  expect(opted.calls().filter(args => args[0] === "send")).toHaveLength(0);
}, 10_000);

test("FAILING escalation sends once and a clean run sends one recovery", async () => {
  const f = fixture(true, { max_consecutive_failures: 0 });
  await f.tick(0); await f.tick(15); await f.tick(16);
  expect(f.accepted()).toHaveLength(1);
  expect(f.accepted()[0]).toContain("is FAILING (since 11:51 Dubai)");
  f.define({ check: "true" }); await f.tick(17); await f.tick(18);
  expect(f.accepted()).toHaveLength(2);
  expect(f.events().filter(row => row.name === "alert.imessage.sent").map(row => row.props.alertKind)).toEqual(["failing", "recovered"]);
}, 15_000);

test("send failure leaves Telegram intact, logs the failure, and retries after restart", async () => {
  const f = fixture(true, { max_consecutive_failures: 1 });
  writeFileSync(join(f.root, "fail-send"), ""); await f.tick(0);
  expect(f.calls().filter(args => args[0] === "notify")).toHaveLength(1);
  expect(f.accepted()).toHaveLength(0);
  expect(f.state().owner_imessage_episodes[0].sent).toBeUndefined();
  const failed = f.events().find(row => row.name === "alert.imessage.failed");
  expect(failed).toMatchObject({ ok: false, ids: { watcher: "critical" }, props: { alertKind: "pause" }, error: { tag: "alert.imessage.send_failed" } });
  expect(failed.durationMs).toBeGreaterThanOrEqual(0);
  rmSync(join(f.root, "fail-send")); await f.tick(2);
  expect(f.accepted()).toHaveLength(1);
}, 10_000);

test("#50 single failure that recovers and #39 degraded success send no failure or recovery notices", async () => {
  const f = fixture(); await f.tick(0);
  f.define({ check: "true" }); await f.tick(1);
  f.define({ check: "echo 'source_errors: one mailbox unavailable' >&2" }); await f.tick(2);
  expect(f.state().consecutive_failures).toBe(0);
  expect(f.calls()).toHaveLength(0);
}, 10_000);

test("opt-in normalization rejects accidental truthy values and other-chat watchers", async () => {
  const f = fixture();
  await f.execute(`const {normalize}=await import(${JSON.stringify(join(source, "lib.ts"))});
    const input={id:"test",title:"Test",check:"true",mode:"notify"};
    if(normalize({...input,owner_imessage_alerts:true}).owner_imessage_alerts!==true)throw Error("lost opt-in");
    for(const value of ["true",1,null]){let rejected=false;try{normalize({...input,owner_imessage_alerts:value})}catch{rejected=true}if(!rejected)throw Error("accepted non-boolean")}
    let rejected=false;try{normalize({...input,mode:"wake",context:"test",chat:"moni",owner_imessage_alerts:true})}catch{rejected=true}if(!rejected)throw Error("accepted other chat");`);
});


test.each([
  { name: "new thread", id: "ses_new_owner", generation: 1 },
  { name: "new generation", id: "ses_owner", generation: 2 },
])("accepted pause survives restart and owner route rotation: $name", async ({ id, generation }) => {
  const f = fixture(true, { max_consecutive_failures: 1 });
  await f.tick(0, false);
  f.rotate(id, generation); await f.tick(2);
  expect(f.accepted()).toHaveLength(1);
  expect(f.calls().filter(args => args[0] === "send")).toHaveLength(1);
  expect(f.state().owner_imessage_episodes[0].sent).toBe(true);
  f.define({ check: "true" }); f.resume(); await f.tick(3); await f.tick(4);
  expect(f.accepted()).toHaveLength(2);
  expect(f.state().owner_imessage_episodes).toBeUndefined();
}, 10_000);

test.each([
  { name: "notify pause, Telegram down", mode: "notify", max: 1, wakeFails: false },
  { name: "wake pause, Telegram down", mode: "wake", max: 1, wakeFails: false },
  { name: "wake pause, Telegram and wake down", mode: "wake", max: 1, wakeFails: true },
  { name: "FAILING, Telegram down", mode: "wake", max: 0, wakeFails: false },
  { name: "FAILING, Telegram and wake down", mode: "wake", max: 0, wakeFails: true },
])("one failure iMessage across fallback combinations: $name", async ({ mode, max, wakeFails }) => {
  const f = fixture(true, { mode, max_consecutive_failures: max });
  writeFileSync(join(f.root, "fail-notify"), "");
  if (wakeFails) writeFileSync(join(f.root, "fail-wake"), "");
  await f.tick(0); await f.tick(15); await f.tick(16);
  expect(f.calls().filter(args => args[0] === "notify").length).toBeGreaterThan(0);
  expect(f.calls().filter(args => args[0] === "send")).toHaveLength(1);
  expect(f.accepted()).toHaveLength(1);
  if (mode === "wake") expect(f.calls().some(args => args[0] === "wake")).toBe(true);
}, 15_000);

test("a stale pause continuation cannot overwrite manual resume or lose recovery", async () => {
  const f = fixture(true, { max_consecutive_failures: 1 }); await f.tick(0);
  f.define({ check: "true" });
  await f.execute(`
    const lib=await import(${JSON.stringify(join(source, "lib.ts"))});
    const {pauseNotice}=await import(${JSON.stringify(join(source, "runner.ts"))});
    const watcher=lib.loadWatcher("critical"),paused=lib.loadState("critical");
    const child=Bun.spawn([process.execPath,${JSON.stringify(join(source, "cli.ts"))},"resume","critical"],{env:process.env,stdout:"ignore",stderr:"pipe"});
    if(await child.exited)throw Error(await new Response(child.stderr).text());
    await pauseNotice(watcher,paused);
  `);
  expect(f.state().failure_paused_at).toBeUndefined();
  expect(f.state().consecutive_failures).toBe(0);
  expect(f.state().owner_imessage_episodes[0].recovery).toBeString();
  await f.tick(2); await f.tick(3);
  expect(f.accepted()).toHaveLength(2);
}, 10_000);

test("accepted recovery survives a crash and owner generation rotation", async () => {
  const f = fixture(true, { max_consecutive_failures: 1 }); await f.tick(0);
  f.define({ check: "true" }); f.resume(); await f.tick(1, false);
  expect(f.state().owner_imessage_episodes).toHaveLength(1);
  f.rotate("ses_owner", 3); await f.tick(3); await f.tick(4);
  expect(f.accepted()).toHaveLength(2);
  expect(f.calls().filter(args => args[0] === "send")).toHaveLength(2);
  expect(f.state().owner_imessage_episodes).toBeUndefined();
}, 10_000);
