import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckGroups } from "../src/check-groups.ts";
import { normalize } from "../src/lib.ts";

test("ps capture detaches from a probe that never exits within three seconds", async () => {
  const script = `
    import {mock} from "bun:test";
    import {EventEmitter} from "node:events";
    import {PassThrough} from "node:stream";
    const cp=await import("node:child_process");
    let argv, options, killed=false;
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),
      kill(signal){killed=signal==="SIGKILL";},unref(){}});
    mock.module("node:child_process",()=>({...cp,spawn:(...args)=>{argv=args[1];options=args[2];return child;}}));
    const {captureGroupState}=await import(${JSON.stringify(join(import.meta.dir, "../src/check-groups.ts"))});
    const started=performance.now(), diagnostic=await captureGroupState(123);
    console.log(JSON.stringify({argv,cwd:options.cwd,killed,diagnostic,
      destroyed:child.stdout.destroyed&&child.stderr.destroyed,ms:performance.now()-started}));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(err).toBe(""); expect(code).toBe(0);
  const result = JSON.parse(out);
  expect(result).toMatchObject({cwd:"/",killed:true,destroyed:true,diagnostic:"ps timed out after 3s"});
  expect(result.argv).toEqual(["-o","pid,stat,wchan,etime,comm","-g","123"]);
  expect(result.ms).toBeGreaterThanOrEqual(3_000); expect(result.ms).toBeLessThan(4_500);
});

test("unknown liveness holds a group, ESRCH releases its shutdown promise and records recovery", async () => {
  const lines: string[] = [], events: string[] = [];
  const groups = new CheckGroups((_id, line) => lines.push(line), name => events.push(name), async () => "STAT D WCHAN sandboxd");
  let alive = true;
  groups.isAlive = () => alive;
  const group = groups.track(normalize({ id: "held", title: "Held", mode: "notify", check: "true" }), 123);
  group.killedAt = Date.now();
  groups.markStuck(group);
  expect(groups.previous("held")).toBe(group);
  alive = false;
  expect(groups.previous("held", group.killedAt + 2_000)).toBeUndefined();
  await group.closed;
  expect(groups.groups.size).toBe(0);
  expect(lines.join("\n")).toContain("stuck group 123 exited after 2s");
  expect(events).toContain("watch.stuck_exited");
});

test("five stuck groups produce one global warning per ten minutes, reaping dead groups", () => {
  const groups = new CheckGroups(() => {}, () => {}, async () => "D sandboxd");
  const live = new Set<number>();
  groups.isAlive = pgid => live.has(pgid);
  for (let i = 1; i <= 5; i++) {
    live.add(i);
    const group = groups.track(normalize({ id: `held-${i}`, title: "Held", mode: "notify", check: "true" }), i);
    group.killedAt = 0; groups.markStuck(group);
  }
  expect(groups.globalWarning(0)).toBe(5);
  expect(groups.globalWarning(599_999)).toBeUndefined();
  expect(groups.globalWarning(600_000)).toBe(5);
  live.delete(1);
  expect(groups.globalWarning(1_200_000)).toBeUndefined();
  expect(groups.groups.size).toBe(4);
});

test.each([false, true])("a live timeout group blocks admission, alerts once and resumes (leader closes=%s)", async closeLeader => {
  const sandbox = mkdtempSync(join(tmpdir(), "watch-stuck-"));
  const calls = join(sandbox, "calls.ndjson"), bridge = join(sandbox, "bridge.ts");
  writeFileSync(bridge, `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+"\\n"); console.log('{"created":true}');`);
  const libPath = join(import.meta.dir, "../src/lib.ts"), runnerPath = join(import.meta.dir, "../src/runner.ts");
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import {mock} from "bun:test";
      import * as cp from "node:child_process";
      import {EventEmitter} from "node:events";
      import {PassThrough} from "node:stream";
      import {existsSync,mkdirSync,writeFileSync,readFileSync} from "node:fs";
      import {join} from "node:path";
      const realSpawn=cp.spawn.bind(cp), realKill=process.kill.bind(process);
      const pgid=2147483640; let alive=true, spawns=0, fake;
      process.kill=(pid,signal)=>{
        if(pid!==-pgid)return realKill(pid,signal);
        if(signal==="SIGKILL" && ${closeLeader} && fake)queueMicrotask(()=>fake.emit("close",0,"SIGKILL"));
        if(!alive)throw Object.assign(new Error("gone"),{code:"ESRCH"});
        return true;
      };
      mock.module("node:child_process",()=>({...cp,spawn:(cmd,args,options)=>{
        if(!args?.includes("kernel-hang"))return realSpawn(cmd,args,options);
        spawns++; fake=Object.assign(new EventEmitter(),{pid:pgid,stdout:new PassThrough(),stderr:new PassThrough(),
          exitCode:null,signalCode:null,unref(){}});return fake;
      }}));
      const lib=await import(${JSON.stringify(libPath)});
      const {tickOne,recordStuckGroups}=await import(${JSON.stringify(runnerPath)});
      const id="held", dir=lib.watcherDir(id);
      mkdirSync(dir,{recursive:true});
      const watcher=lib.normalize({id,title:"Held",mode:"notify",check:"kernel-hang",interval_s:5,max_fires:0});
      writeFileSync(join(dir,"watcher.json"),JSON.stringify(watcher));
      lib.saveState(id,{status:"active",fires:0,consecutive_failures:0,failure_alerted:false});
      let captured; const snapshot=new Promise(resolve=>{captured=resolve;});
      lib.checkGroups.capture=async()=>{captured();return "2147483640 D sandboxd 00:31 kernel-hang";};
      const guard=setTimeout(()=>{console.error("fixture exceeded deadline: groups="+JSON.stringify([...lib.checkGroups.groups.values()].map(g=>({stuck:g.stuck,killed:g.killedAt,alive,spawns}))));process.exit(2);},9000);
      const started=performance.now(); await tickOne(id); const elapsed=performance.now()-started; await snapshot;
      const group=lib.checkGroups.previous(id);
      if(!group)throw new Error("timeout did not retain group");
      let clock=group.killedAt; Date.now=()=>clock;
      const failed=lib.loadState(id);
      const nearPause={...failed,consecutive_failures:4,next_at:0};lib.saveState(id,nearPause);
      const before=readFileSync(join(dir,"state.json"),"utf8");
      for(let i=0;i<6;i++){clock+=1000;await tickOne(id);}
      const unchanged=before===readFileSync(join(dir,"state.json"),"utf8");
      let rejected=false;
      try{await lib.runCheck(watcher,dir,{},10);}catch(error){rejected=error instanceof lib.CheckStuckError;}
      clock=group.killedAt+30*60_000; await tickOne(id); await recordStuckGroups();
      clock+=1000;await tickOne(id); await recordStuckGroups();
      const beforeRecovery=lib.loadState(id);
      alive=false;fake.emit("close",null,"SIGKILL");
      writeFileSync(join(dir,"watcher.json"),JSON.stringify({...watcher,timeout_s:5,check:'echo ran >> "$WATCH_DIR/runs"'}));
      await tickOne(id);
      await group.closed; const recovered=lib.loadState(id);
      clearTimeout(guard);console.log("RESULT "+JSON.stringify({failed,elapsed,unchanged,rejected,spawns,beforeRecovery,recovered,
        runs:existsSync(join(dir,"runs"))?readFileSync(join(dir,"runs"),"utf8"):"MISSING",remaining:lib.checkGroups.groups.size}));
    `], { env: { ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: join(sandbox, "root"),
      TOOLLOG_DIR: join(sandbox, "logs"), ROBOB_WATCH_LOAD_OVERRIDE: ".1", ROBOB_WATCH_SSD_PATH: "/dev",
      ROBOB_WATCH_CHECK_TIMEOUT_MS: "20", ROBOB_WATCH_TELEGRAM_CLI: bridge, ROBOB_WATCH_SPECTRUM_CLI: bridge },
      stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(err).toBe(""); expect(code).toBe(0);
    const result = JSON.parse(out.split("\n").find(line => line.startsWith("RESULT "))!.slice(7));
    expect(result.failed.consecutive_failures).toBe(1);
    if (closeLeader) expect(result.elapsed).toBeLessThan(2_000);
    else expect(result.elapsed).toBeGreaterThanOrEqual(5_000);
    expect(result.elapsed).toBeLessThan(7_000);
    expect(result.unchanged).toBe(true);
    expect(result.rejected).toBe(true);
    expect(result.spawns).toBe(1);
    expect(result.beforeRecovery.failure_paused_at).toBeUndefined();
    expect(result.beforeRecovery.consecutive_failures).toBe(4);
    expect(result.recovered).toMatchObject({consecutive_failures:0});
    expect(result.runs).toBe("ran\n"); expect(result.remaining).toBe(0);
    const notices = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    const stuck = notices.filter(args => args.some(arg => arg === "--key=stuck-group:held:2147483640"));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.join(" ")).toContain("sandboxd");
    expect(stuck[0]!.join(" ")).toContain("New runs paused until it exits");
    const rows = readdirSync(join(sandbox, "logs")).filter(file => file.endsWith(".ndjson")).flatMap(file =>
      readFileSync(join(sandbox, "logs", file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    const skips = rows.filter(row => row.name === "watch.skip");
    expect(skips.length).toBeGreaterThan(0);
    expect(skips.every(row => row.props.outcome === "stuck_previous" && row.props.pgid === 2147483640)).toBe(true);
    expect(rows.find(row => row.name === "watch.stuck_group").props.diagnostic).toContain("sandboxd");
    expect(out).toContain("stuck group 2147483640 exited after");
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}, 15_000);

test("registry alerts active, paused, closing and archived watchers once, and drops exited groups", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "watch-stuck-removed-"));
  const calls = join(sandbox, "calls.ndjson"), bridge = join(sandbox, "bridge.ts");
  writeFileSync(bridge, `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+"\\n"); console.log('{"created":true}');`);
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import {mkdirSync,writeFileSync} from "node:fs";
      import {join} from "node:path";
      const lib=await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))});
      const {recordStuckGroups}=await import(${JSON.stringify(join(import.meta.dir, "../src/runner.ts"))});
      let clock=Date.now();Date.now=()=>clock;
      const live=new Set();let pgid=2147483600;
      lib.checkGroups.isAlive=pgid=>live.has(pgid);
      lib.checkGroups.capture=async()=>"123 D sandboxd 00:31 zsh";
      for(const id of ["active","paused","closing","archived","exited"]){
        const dir=lib.watcherDir(id);mkdirSync(dir,{recursive:true});
        const watcher=lib.normalize({id,title:id,mode:"notify",check:"true",paused:id==="paused"});
        writeFileSync(join(dir,"watcher.json"),JSON.stringify(watcher));
        lib.saveState(id,{status:id==="closing"?"closing":"active",fires:0,consecutive_failures:4});
        const group=lib.checkGroups.track(watcher,++pgid);live.add(pgid);group.killedAt=clock;
        lib.checkGroups.markStuck(group);
        if(id==="archived")lib.archiveWatcher(id,"now");
        if(id==="exited")live.delete(pgid);
      }
      if(lib.listIds().includes("archived"))throw new Error("archive did not remove watcher from scheduling");
      clock+=29*60_000;await recordStuckGroups();
      clock+=60_000;await Promise.all([recordStuckGroups(),recordStuckGroups()]);
      clock+=60_000;await recordStuckGroups();
      live.clear();await recordStuckGroups();
      console.log("RESULT "+lib.checkGroups.groups.size);
    `], { env: { ...process.env, BUN_INSPECT: undefined, ROBOB_TEST: "1", ROBOB_WATCH_ROOT: join(sandbox, "root"),
      TOOLLOG_DIR: join(sandbox, "logs"), ROBOB_WATCH_TELEGRAM_CLI: bridge, ROBOB_WATCH_SPECTRUM_CLI: bridge },
      stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(err).toBe(""); expect(code).toBe(0); expect(out).toContain("RESULT 0");
    const notices = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(notices).toHaveLength(4);
    for (const [index, id] of ["active", "paused", "closing", "archived"].entries()) {
      const notice = notices.find(args => args.includes(`--key=stuck-group:${id}:${2147483601 + index}`));
      expect(notice?.join(" ")).toContain("30 min after SIGKILL: 123 D sandboxd 00:31 zsh");
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test("ordinary timeout reaps within grace and permits the next check", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "watch-reaped-"));
  try {
    const { checkGroups, runCheck } = await import("../src/lib.ts");
    const watcher = normalize({ id: "reaped", title: "Reaped", mode: "notify", check: "exec sleep 30" });
    const running = runCheck(watcher, sandbox, {}, 50);
    const group = [...checkGroups.groups.values()].find(group => group.watcher.id === watcher.id)!;
    const result = await running;
    expect(result.timedOut).toBe(true);
    expect(result.ms).toBeLessThan(2_000);
    await group.closed;
    expect(checkGroups.previous(watcher.id)).toBeUndefined();
    const next = await runCheck({ ...watcher, check: "echo recovered" }, sandbox);
    expect(next.code).toBe(0); expect(next.stdout.trim()).toBe("recovered");
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
