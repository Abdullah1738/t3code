import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeGroupState } from "../src/check-groups.ts";

const libPath = join(import.meta.dir, "../src/lib.ts");
const runnerPath = join(import.meta.dir, "../src/runner.ts");
const groupsPath = join(import.meta.dir, "../src/check-groups.ts");
const logPath = join(import.meta.dir, "../src/toollog.ts");

async function fixture(script: string) {
  const sandbox = mkdtempSync(join(tmpdir(), "watch-stuck-review-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, BUN_INSPECT: undefined,
      ROBOB_TEST: "1", ROBOB_WATCH_ROOT: join(sandbox, "root"), TOOLLOG_DIR: join(sandbox, "logs"),
      ROBOB_WATCH_LOAD_OVERRIDE: ".1", ROBOB_WATCH_SSD_PATH: "/dev", ROBOB_WATCH_TEST_BATCH_MS: "0" },
      stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(err).toBe(""); expect(code).toBe(0);
    const result = JSON.parse(out.split("\n").find(line => line.startsWith("RESULT "))!.slice(7));
    const logs = readdirSync(join(sandbox, "logs")).filter(name => name.endsWith(".ndjson"))
      .map(name => readFileSync(join(sandbox, "logs", name), "utf8")).join("\n");
    return { result, out, logs };
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}

test("a stuck pending check holds check admission while delivery, confirmations and owner notices recover", async () => {
  const { result } = await fixture(`
    import {mock} from "bun:test";
    import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
    import {join} from "node:path";
    const lib=await import(${JSON.stringify(libPath)});
    let deliveryWorks=false,deliveries=0,confirmations=0,ownerNotices=0;
    mock.module(${JSON.stringify(libPath)},()=>({...lib,
      deliver:async()=>{deliveries++;return {ok:deliveryWorks,via:"telegram",detail:"fixture"};},
      confirmWakes:async()=>{confirmations++;},
      imessage:async()=>{ownerNotices++;return {ok:true,out:"fixture"};}
    }));
    const {tickOne}=await import(${JSON.stringify(runnerPath)});
    const {drainOwnerAlerts}=await import(${JSON.stringify(join(import.meta.dir, "../src/owner-alerts.ts"))});
    let clock=Date.now();Date.now=()=>clock;
    const id="pending",dir=lib.watcherDir(id);mkdirSync(dir,{recursive:true});
    const watcher=lib.normalize({id,title:id,mode:"notify",max_fires:0,interval_s:5,owner_imessage_alerts:true,
      check:'echo main >> "$WATCH_DIR/checks"',pending_check:'echo pending >> "$WATCH_DIR/checks"'});
    writeFileSync(join(dir,"watcher.json"),JSON.stringify(watcher));
    lib.saveState(id,{status:"active",fires:0,consecutive_failures:4,next_at:0,
      pending:{key:"event",event:"ready",at:lib.iso()},
      owner_imessage_episodes:[{key:"owner-retry",since:lib.iso(),kind:"failing",text:"retry fixture notice"}]});
    let alive=true;lib.checkGroups.isAlive=()=>alive;
    lib.checkGroups.capture=async()=>"123 D sandboxd 00:31 zsh";
    const group=lib.checkGroups.track({...watcher,check:watcher.pending_check},2147483640);
    group.killedAt=clock;lib.checkGroups.markStuck(group);
    await tickOne(id);await drainOwnerAlerts();
    const failed=lib.loadState(id),beforeRecovery=existsSync(join(dir,"checks"));
    clock+=60_000;deliveryWorks=true;await tickOne(id);await drainOwnerAlerts();
    const recovered=lib.loadState(id);
    clock+=60_000;await tickOne(id);await drainOwnerAlerts();
    const checksHeld=!existsSync(join(dir,"checks")),heldState=lib.loadState(id),noticesWhileHeld=ownerNotices;
    alive=false;heldState.next_at=0;lib.saveState(id,heldState);await tickOne(id);
    console.log("RESULT "+JSON.stringify({failed,recovered,heldState,deliveries,confirmations,noticesWhileHeld,
      beforeRecovery,checksHeld,checks:existsSync(join(dir,"checks"))?readFileSync(join(dir,"checks"),"utf8"):"MISSING"}));
    lib.checkGroups.groups.clear();
  `);
  expect(result.failed.pending.event).toBe("ready");
  expect(result.recovered.pending).toBeUndefined();
  expect(result.deliveries).toBe(2);
  expect(result.confirmations).toBeGreaterThanOrEqual(3);
  expect(result.noticesWhileHeld).toBe(1);
  expect(result.recovered.owner_imessage_episodes[0].sent).toBe(true);
  expect(result.heldState.consecutive_failures).toBe(4);
  expect(result.heldState.failure_paused_at).toBeUndefined();
  expect(result.beforeRecovery).toBe(false); expect(result.checksHeld).toBe(true);
  expect(result.checks).toBe("main\npending\n");
});

test("ps arguments never reach retained diagnostic, runner log, structured events or alerts", async () => {
  const { result, out, logs } = await fixture(`
    import {mock} from "bun:test";
    import * as cp from "node:child_process";
    import {EventEmitter} from "node:events";
    import {PassThrough} from "node:stream";
    const raw=' PID STAT WCHAN ELAPSED COMMAND\\n123 D sandboxd 00:31 /usr/bin/curl -H "Authorization: Bearer DUMMY_BEARER" --password DUMMY_PASSWORD --otp DUMMY_OTP "DUMMY_PRIVATE_MESSAGE"';
    mock.module("node:child_process",()=>({...cp,spawn:()=>{
      const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),unref(){}});
      queueMicrotask(()=>{child.stdout.write(raw);child.emit("close",0);});return child;
    }}));
    const {captureGroupState}=await import(${JSON.stringify(groupsPath)});
    const diagnostic=await captureGroupState(123);
    const lib=await import(${JSON.stringify(libPath)});
    const alerts=[];
    mock.module(${JSON.stringify(libPath)},()=>({...lib,alert:async(watcher,text,key)=>{
      alerts.push({text,key});return {ok:true,via:"telegram",detail:"fixture"};
    }}));
    const {skipStuckCheck,recordStuckGroups}=await import(${JSON.stringify(runnerPath)});
    const {toolLog}=await import(${JSON.stringify(logPath)});
    const watcher=lib.normalize({id:"private",title:"Private",mode:"notify",check:"true"});
    lib.checkGroups.isAlive=()=>true;
    lib.checkGroups.capture=async()=>raw;
    const group=lib.checkGroups.track(watcher,123);group.killedAt=Date.now()-31*60_000;
    lib.checkGroups.markStuck(group);await Promise.resolve();await Promise.resolve();
    await skipStuckCheck(watcher.id);await recordStuckGroups();
    toolLog({component:"runner",kind:"event",name:"watch.stuck_group",props:{diagnostic:raw}});
    console.log("RESULT "+JSON.stringify({diagnostic,retained:group.diagnostic,alerts}));
    lib.checkGroups.groups.clear();
  `);
  for (const sink of [JSON.stringify(result), out, logs]) {
    for (const privateValue of ["DUMMY_BEARER", "DUMMY_PASSWORD", "DUMMY_OTP", "DUMMY_PRIVATE_MESSAGE", "Authorization", "--password"])
      expect(sink).not.toContain(privateValue);
    expect(sink).toContain("123 D sandboxd 00:31 curl");
  }
  expect(result.alerts).toHaveLength(1);
  expect(result.alerts[0].key).toBe("stuck-group:private:123");
});

test.each([
  '-H "Authorization: Bearer DUMMY"',
  '--password DUMMY',
  '--password=DUMMY',
  '--otp 123456',
  'send "private message body"',
  'https://user:DUMMY@example.test/?token=DUMMY',
  'TOKEN=DUMMY',
  '"multi word argument"',
])("diagnostics drop the full argument tail: %s", tail => {
  const raw = ` PID STAT WCHAN ELAPSED COMMAND\n123 D+ sandboxd 2-03:04:05 /usr/bin/curl ${tail}`;
  const safe = "123 D+ sandboxd 2-03:04:05 curl";
  expect(sanitizeGroupState(raw)).toBe(safe);
  expect(sanitizeGroupState(safe)).toBe(safe);
});

test("diagnostics retain multiple safe process rows and discard malformed output", () => {
  const raw = 'PID STAT WCHAN ELAPSED COMMAND\n1 S - 00:01 /bin/zsh -c "private"\n2 R 0 00:00.12 /usr/bin/curl --token private';
  expect(sanitizeGroupState(raw)).toBe("1 S - 00:01 zsh | 2 R 0 00:00.12 curl");
  expect(sanitizeGroupState("arbitrary private failure output")).toBe("ps: no safe group rows");
  expect(sanitizeGroupState("1 S ? 00:01 /odd/[private] --token private")).toBe("1 S ? 00:01 [executable]");
});
