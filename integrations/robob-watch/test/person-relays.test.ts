import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each scenario imports the runner in its own sandbox and advances its clock between completed ticks.
async function scenario(body: string) {
  const root = mkdtempSync(join(tmpdir(), "person-relays-"));
  writeFileSync(join(root, "bridge.ts"), `import {appendFileSync,existsSync} from "node:fs";
if(existsSync(${JSON.stringify(join(root, "fail"))})) process.exit(1);
appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify(process.argv.slice(2))+"\\n"); console.log("ok");`);
  const source = `
    import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
    import { join } from "node:path";
    const root = ${JSON.stringify(root)};
    process.env.ROBOB_TEST = "1";
    delete process.env.ROBOB_WATCH_TEST_BATCH_MS;
    process.env.ROBOB_WATCH_ROOT = root;
    process.env.ROBOB_WATCH_LOAD_OVERRIDE = "0.1";
    process.env.ROBOB_WATCH_BRIDGE_DB = join(root, "bridge.sqlite");
    const { Database } = await import("bun:sqlite");
    const db = new Database(process.env.ROBOB_WATCH_BRIDGE_DB);
    db.exec("create table kv(key text primary key,value text)");
    db.query("insert into kv values (?,?)").run("route",JSON.stringify({id:"ses_test",generation:1}));
    db.close();
    const calls = join(root, "calls");
    const stub = join(root, "bridge.ts");
    process.env.ROBOB_WATCH_SPECTRUM_CLI = stub;
    process.env.ROBOB_WATCH_TELEGRAM_CLI = stub;
    const lib = await import(${JSON.stringify(join(import.meta.dir, "../src/lib.ts"))});
    const { tickOne } = await import(${JSON.stringify(join(import.meta.dir, "../src/runner.ts"))});
    let clock = Date.parse("2026-11-13T10:00:00Z");
    Date.now = () => clock;
    lib.ensureDirs();
    const cli = (...args) => {
      const result = Bun.spawnSync([process.execPath, ${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))}, ...args], {env:process.env});
      if(result.exitCode) throw new Error(result.stderr.toString());
      return result.stdout.toString();
    };
    function add(id, extra={}) {
      const dir = lib.watcherDir(id);
      mkdirSync(dir, {recursive:true});
      lib.writeJson(join(dir,"watcher.json"), lib.normalize({id,title:id,check:'if [[ -f event ]]; then cat event; rm event; fi; true',context:'{}',mode:'wake',interval_s:5,max_fires:0,...extra}));
    }
    const state = id => lib.loadState(id);
    const sent = () => existsSync(calls) ? readFileSync(calls,"utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
    async function fire(id, text, advance=0) { clock += advance; writeFileSync(join(lib.watcherDir(id),"event"),text); await tickOne(id); }
    ${body}
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", source], { env: { ...process.env, BUN_INSPECT: undefined }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(stderr + stdout);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    return result;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const chat of [undefined, "moni", "family-trip"]) {
  test(`six person-chat fires batch once, oldest first (${chat ?? "owner"})`, async () => {
    const result = await scenario(`
      add("batch", ${JSON.stringify(chat ? { chat } : {})});
      for(let i=0;i<6;i++) await fire("batch","event-"+i,i ? 24000 : 0);
      const before=sent(); clock+=29999; await tickOne("batch"); const boundary=sent();
      clock+=1; await tickOne("batch");
      console.log(JSON.stringify({before,boundary,sent:sent(),state:state("batch")}));
    `);
    expect(result.before).toEqual([]);
    expect(result.boundary).toEqual([]);
    expect(result.sent).toHaveLength(1);
    const args = result.sent[0];
    expect(args[0]).toBe("wake");
    const text = args[args.indexOf("--text") + 1];
    for (let i = 0; i < 6; i++) expect(text).toContain(`${i + 1}. event-${i}`);
    expect(result.state.fires).toBe(6);
    expect(result.state.batch).toBeUndefined();
  });
}

test("an urgent JSON fire wakes immediately while the other five keep their original window", async () => {
  const result = await scenario(`
    add("urgent");
    for(let i=0;i<6;i++) await fire("urgent",i===3 ? JSON.stringify({event:"slot offered",urgent:true}) : "event-"+i,i ? 24000 : 0);
    const immediate=sent(); clock+=30000; await tickOne("urgent");
    console.log(JSON.stringify({immediate,sent:sent(),state:state("urgent")}));
  `);
  expect(result.immediate).toHaveLength(1);
  expect(result.immediate[0].join(" ")).toContain("slot offered");
  expect(result.sent).toHaveLength(2);
  for (const i of [0, 1, 2, 4, 5]) expect(result.sent[1].join(" ")).toContain(`event-${i}`);
  expect(result.sent[1].join(" ")).not.toContain("slot offered");
  expect(result.state.fires).toBe(6);
});

test("notify is immediate and JSON urgent:false stays batched", async () => {
  const result = await scenario(`
    add("notify",{mode:"notify"}); await fire("notify","direct");
    add("normal"); await fire("normal",JSON.stringify({urgent:false,event:"later"}));
    console.log(JSON.stringify({sent:sent(),state:state("normal")}));
  `);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0][0]).toBe("send");
  expect(result.state.batch.events).toHaveLength(1);
});

test("large batches retain every full event and failed deliveries retry the same snapshot after context edits", async () => {
  const result = await scenario(`
    add("large",{chat:"moni",max_fires:2});
    await fire("large","a".repeat(5000)); await fire("large","b".repeat(5000),10000);
    writeFileSync(join(root,"fail"),""); clock+=140000; await tickOne("large");
    const pending=state("large").pending;
    cli("context","large","--context","changed","--replace");
    const {rmSync}=await import("node:fs"); rmSync(join(root,"fail"));
    clock+=5000; await tickOne("large");
    const batchFile=readFileSync(join(root,"archive","batches","large-"+lib.hash(pending.key).slice(0,32)+".json"),"utf8");
    const final=state("large"); lib.removeWatcher("large",true);
    const retained=existsSync(join(root,"archive","batches","large-"+lib.hash(pending.key).slice(0,32)+".json"));
    console.log(JSON.stringify({pending,sent:sent(),batch:JSON.parse(batchFile),state:final,retained}));
  `);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].join(" ")).toContain("Read the complete batch");
  expect(result.sent[0].join(" ")).not.toContain("changed");
  expect(result.sent[0]).toContain(result.pending.key);
  expect(result.batch.events.map((s: string) => s.length)).toEqual([5000, 5000]);
  expect(result.state.status).toBe("done");
  expect(result.retained).toBe(true);
});

test("context writers merge keys, nested objects and lists under a lock, and replace is explicit", async () => {
  const result = await scenario(`
    add("context");
    cli("context","context","--context",JSON.stringify({a:1,nested:{a:1},list:[1]}));
    cli("context","context","--context",JSON.stringify({b:2,nested:{b:2},list:[2]}));
    const merged=JSON.parse(lib.loadWatcher("context").context);
    const racers=await Promise.all(Array.from({length:8},(_,i)=>Bun.spawn([process.execPath,${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))},"context","context","--context",JSON.stringify({["key"+i]:i})],{env:process.env,stdout:"ignore",stderr:"pipe"}).exited));
    const concurrent=JSON.parse(lib.loadWatcher("context").context);
    add("legacy",{context:"Original instructions"});
    cli("context","legacy","--context",'{"a":1}');
    cli("context","legacy","--context",'{"b":2}');
    cli("context","legacy","--context","Extra instructions");
    const legacy=JSON.parse(lib.loadWatcher("legacy").context);
    cli("context","context","--context",'{"only":true}',"--replace");
    console.log(JSON.stringify({merged,racers,concurrent,legacy,replaced:JSON.parse(lib.loadWatcher("context").context)}));
  `);
  expect(result.merged).toEqual({ a: 1, b: 2, nested: { a: 1, b: 2 }, list: [1, 2] });
  expect(result.racers).toEqual(Array(8).fill(0));
  for (let i = 0; i < 8; i++) expect(result.concurrent[`key${i}`]).toBe(i);
  expect(result.replaced).toEqual({ only: true });
  expect(result.legacy).toEqual({ instructions: "Original instructions", a: 1, b: 2, notes: ["Extra instructions"] });
});

test("rm keeps a reply five minutes later, flushes at the grace boundary, and then archives", async () => {
  const result = await scenario(`
    add("closing",{expires_at:new Date(clock+10000).toISOString(),max_fires:1});
    lib.removeWatcher("closing"); const until=state("closing").closing_until;
    await fire("closing","in-flight reply",300000); clock+=150000; await tickOne("closing");
    const delivered=sent();
    clock=until-1000; await fire("closing","last reply");
    clock=until; await tickOne("closing"); const atBoundary=!!lib.loadWatcher("closing");
    clock+=149000; await tickOne("closing"); await tickOne("closing");
    console.log(JSON.stringify({delivered,sent:sent(),atBoundary,exists:!!lib.loadWatcher("closing")}));
  `);
  expect(result.delivered).toHaveLength(1);
  expect(result.delivered[0].join(" ")).toContain("in-flight reply");
  expect(result.atBoundary).toBe(true);
  expect(result.sent).toHaveLength(2);
  expect(result.sent[1].join(" ")).toContain("last reply");
  expect(result.exists).toBe(false);
});

test("rm --now archives immediately; resume cancels closing without resetting the fire count", async () => {
  const result = await scenario(`
    add("now"); cli("rm","now","--now"); clock+=300000; await tickOne("now");
    add("resume"); lib.saveState("resume",{...state("resume"),fires:2});
    cli("remove","resume"); cli("resume","resume");
    console.log(JSON.stringify({sent:sent(),exists:!!lib.loadWatcher("now"),state:state("resume")}));
  `);
  expect(result.sent).toEqual([]);
  expect(result.exists).toBe(false);
  expect(result.state).toMatchObject({ status: "active", fires: 2 });
  expect(result.state.closing_until).toBeUndefined();
});


test("removal during a check preserves its reply; --now cannot recreate the removed directory", async () => {
  const result = await scenario(`
    const command = ["env", "ROBOB_WATCH_ROOT="+root, "ROBOB_TEST=1", process.execPath, ${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))}].map(s=>"'"+s.replaceAll("'", "'\\''")+"'").join(" ");
    add("race",{check: command+' rm race; echo late-reply'});
    await tickOne("race"); const closing=state("race"); clock+=150000; await tickOne("race");
    add("gone",{check: command+' rm gone --now; echo dropped'});
    await tickOne("gone");
    console.log(JSON.stringify({closing,sent:sent(),gone:existsSync(lib.watcherDir("gone"))}));
  `);
  expect(result.closing.status).toBe("closing");
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].join(" ")).toContain("late-reply");
  expect(result.gone).toBe(false);
});


for (const status of ["active", "done", "expired"]) {
  test(`closing preserves the previous ${status} ending for archive readers`, async () => {
    const result = await scenario(`
      add("archive"); lib.saveState("archive",{...state("archive"),status:${JSON.stringify(status)}});
      lib.removeWatcher("archive"); clock+=900000; await tickOne("archive");
      console.log(JSON.stringify(JSON.parse(readFileSync(join(root,"archive","archive-"+clock,"state.json"),"utf8"))));
    `);
    expect(result.status).toBe(status);
    expect(result.closing_until).toBeUndefined();
  });
}


test("a check failure pause does not strand events already accepted into its batch", async () => {
  const result = await scenario(`
    add("paused"); await fire("paused","accepted-reply");
    lib.saveState("paused",{...state("paused"),failure_paused_at:lib.iso(),failure_alerted:true,failure_escalated:true});
    clock+=150000; await tickOne("paused");
    console.log(JSON.stringify({sent:sent(),state:state("paused")}));
  `);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].join(" ")).toContain("accepted-reply");
  expect(result.state.failure_paused_at).toBeDefined();
  expect(result.state.fires).toBe(1);
});


for (const [before, after] of [[null, "moni"], ["moni", null], ["moni", "family-trip"], ["family-trip", "moni"]]) {
  test(`queued private events retain their accepted destination ${before} -> ${after}`, async () => {
    const result = await scenario(`
      add("target",{context:"original-context",...${JSON.stringify(before ? {chat:before} : {})}}); await fire("target","private-reply");
      const current=lib.loadWatcher("target"); delete current.chat;
      lib.writeJson(join(lib.watcherDir("target"),"watcher.json"),{...current,context:"new-private-context",${after ? 'chat:'+JSON.stringify(after) : ''}});
      clock+=150000; await tickOne("target");
      console.log(JSON.stringify({sent:sent()}));
    `);
    expect(result.sent).toHaveLength(1);
    const args = result.sent[0];
    expect(args.includes("--chat")).toBe(before !== null);
    if (before) expect(args[args.indexOf("--chat") + 1]).toBe(before);
    expect(args.join(" ")).toContain("private-reply");
    expect(args.join(" ")).toContain("original-context");
    expect(args.join(" ")).not.toContain("new-private-context");
  });
}

test("the final grace poll collects a reply after the previous ten-minute interval", async () => {
  const result = await scenario(`
    add("last-poll",{interval_s:600}); lib.removeWatcher("last-poll"); await tickOne("last-poll");
    clock+=600000; await tickOne("last-poll");
    clock+=240000; writeFileSync(join(lib.watcherDir("last-poll"),"event"),"minute-fourteen-reply");
    clock+=60000; await tickOne("last-poll"); const closing=state("last-poll");
    clock+=150000; await tickOne("last-poll"); await tickOne("last-poll");
    console.log(JSON.stringify({closing,sent:sent(),exists:!!lib.loadWatcher("last-poll")}));
  `);
  expect(result.closing.closing_final_check).toBe(true);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].join(" ")).toContain("minute-fourteen-reply");
  expect(result.exists).toBe(false);
});

test("resume during delivery clears closing metadata and a later removal gets a fresh grace", async () => {
  const result = await scenario(`
    add("resume-send",{chat:"moni"}); lib.removeWatcher("resume-send");
    await fire("resume-send",JSON.stringify({urgent:true,event:"offer"}));
    const oldDeadline=state("resume-send").closing_until;
    writeFileSync(stub, 'import {readFileSync,writeFileSync} from "node:fs"; const file='+JSON.stringify(join(lib.watcherDir("resume-send"),"state.json"))+'; const s=JSON.parse(readFileSync(file,"utf8")); s.status="active"; delete s.closing_until; delete s.closing_from; writeFileSync(file,JSON.stringify(s)); console.log("ok");');
    lib.saveState("resume-send",{...state("resume-send"),pending:{key:"resume-race",event:"reply",at:lib.iso()},next_at:0});
    await tickOne("resume-send"); const resumed=state("resume-send");
    clock+=120000; lib.removeWatcher("resume-send");
    console.log(JSON.stringify({resumed,oldDeadline,deadline:state("resume-send").closing_until}));
  `);
  expect(result.resumed.status).toBe("active");
  expect(result.resumed.closing_until).toBeUndefined();
  expect(result.resumed.closing_from).toBeUndefined();
  expect(result.deadline).toBe(result.oldDeadline + 120000);
});

test("definition patch writers share the context writer lock", async () => {
  const result = await scenario(`
    add("writers");
    const commands=Array.from({length:16},(_,i)=>i%2 ? ["context","writers","--context",JSON.stringify({["key"+i]:i})] : i%4 ? ["resume","writers"] : ["depends","writers","ssd"]);
    const codes=await Promise.all(commands.map(args=>Bun.spawn([process.execPath,${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))},...args],{env:process.env,stdout:"ignore",stderr:"pipe"}).exited));
    console.log(JSON.stringify({codes,watcher:lib.loadWatcher("writers")}));
  `);
  expect(result.codes).toEqual(Array(16).fill(0));
  const context = JSON.parse(result.watcher.context);
  for (let i = 1; i < 16; i += 2) expect(context["key" + i]).toBe(i);
  expect(result.watcher.depends).toEqual(["ssd"]);
});


test("changing wake to notify does not turn an accepted private batch into a direct send", async () => {
  const result = await scenario(`
    add("mode",{chat:"moni"}); await fire("mode","private-mode-reply");
    const current=lib.loadWatcher("mode"); delete current.chat; current.mode="notify";
    lib.writeJson(join(lib.watcherDir("mode"),"watcher.json"),current);
    clock+=150000; await tickOne("mode"); console.log(JSON.stringify({sent:sent()}));
  `);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0][0]).toBe("wake");
  expect(result.sent[0][result.sent[0].indexOf("--chat") + 1]).toBe("moni");
});

test("a check completing after retargeting uses the destination admitted with the check", async () => {
  const result = await scenario(`
    add("admitted",{context:"old-context",check:process.execPath+' ./retarget.ts'});
    writeFileSync(join(lib.watcherDir("admitted"),"retarget.ts"),'import {readFileSync,writeFileSync} from "node:fs"; import {join} from "node:path"; const file=join(process.env.WATCH_DIR,"watcher.json"); const w=JSON.parse(readFileSync(file,"utf8")); w.chat="moni"; w.context="new-private-context"; writeFileSync(file,JSON.stringify(w)); console.log("old-private-reply");');
    await tickOne("admitted"); clock+=150000; await tickOne("admitted");
    console.log(JSON.stringify({sent:sent()}));
  `);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0]).not.toContain("--chat");
  expect(result.sent[0].join(" ")).toContain("old-private-reply");
  expect(result.sent[0].join(" ")).not.toContain("new-private-context");
});

test("context file and stdin forms share merge and explicit replacement semantics", async () => {
  const result = await scenario(`
    add("forms"); const file=join(root,"patch.json");
    writeFileSync(file,JSON.stringify({a:1,list:[1]})); cli("context","forms","--json",file);
    writeFileSync(file,JSON.stringify({b:2,list:[2]})); cli("context","forms","--context-file",file);
    const merged=JSON.parse(lib.loadWatcher("forms").context);
    const stdin=Bun.spawnSync([process.execPath,${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))},"context","forms","--json","-","--replace"],{env:process.env,stdin:Buffer.from('{"only":[3]}')});
    console.log(JSON.stringify({merged,code:stdin.exitCode,replaced:JSON.parse(lib.loadWatcher("forms").context)}));
  `);
  expect(result.merged).toEqual({ a: 1, b: 2, list: [1, 2] });
  expect(result.code).toBe(0);
  expect(result.replaced).toEqual({ only: [3] });
});


for (const urgent of [false, true]) {
  test(`a shortened ${urgent ? "urgent wake" : "batch"} points to immutable accepted context after retarget/removal`, async () => {
    const result = await scenario(`
      const original="original-context "+"words ".repeat(90)+"ORIGINAL PRIVATE TAIL";
      add("snapshot",{context:original});
      lib.saveState("snapshot",{...state("snapshot"),fires:1,last_fire_at:lib.iso()});
      await fire("snapshot",JSON.stringify({urgent:${urgent},event:"private reply"}));
      const next=lib.loadWatcher("snapshot"); next.chat="moni"; next.context="NEW CHAT PRIVATE CONTEXT";
      lib.writeJson(join(lib.watcherDir("snapshot"),"watcher.json"),next);
      clock+=150000; await tickOne("snapshot");
      const file=join(root,"archive","contexts",lib.hash(original)+".json");
      const saved=JSON.parse(readFileSync(file,"utf8")); lib.removeWatcher("snapshot",true);
      console.log(JSON.stringify({sent:sent(),file,saved,exists:existsSync(file),original}));
    `);
    expect(result.sent).toHaveLength(1);
    const text = result.sent[0][result.sent[0].indexOf("--text") + 1];
    expect(text).toContain(result.file);
    expect(text).not.toContain("robob-watch context snapshot");
    expect(text).not.toContain("NEW CHAT PRIVATE CONTEXT");
    expect(result.saved.context).toBe(result.original);
    expect(result.exists).toBe(true);
  });
}


for (const status of ["active", "done", "expired"]) {
  test(`remove then resume rearms a previously ${status} watcher correctly`, async () => {
    const result = await scenario(`
      add("rearm",{max_fires:${status == "active" ? 3 : 1},${status == "expired" ? 'expires_at:"1970-01-01T00:00:00Z",' : ''}});
      lib.saveState("rearm",{...state("rearm"),status:${JSON.stringify(status)},fires:${status == "active" ? 2 : 1}});
      cli("remove","rearm"); cli("resume","rearm","--expires","1d"); const resumed=state("rearm");
      await fire("rearm","rearmed-reply"); clock+=150000; await tickOne("rearm");
      console.log(JSON.stringify({resumed,state:state("rearm"),sent:sent()}));
    `);
    expect(result.resumed.status).toBe("active");
    expect(result.resumed.fires).toBe(status === "active" ? 2 : 0);
    expect(result.sent).toHaveLength(1);
    expect(result.sent[0].join(" ")).toContain("rearmed-reply");
    expect(result.state.status).toBe("done");
    expect(result.state.fires).toBe(status === "active" ? 3 : 1);
  });
}


for (const [max, replies, kept] of [[3, 0, 0], [3, 1, 1], [1, 1, 0], [1, 2, 0], [0, 2, 2]]) {
  test(`resume after closing deliveries handles budget max=${max}, delivered=${replies}`, async () => {
    const result = await scenario(`
      add("budget",{max_fires:${max}}); lib.removeWatcher("budget");
      for(let i=0;i<${replies};i++) await fire("budget",JSON.stringify({urgent:true,event:"closing-reply-"+i}),i?5000:0);
      const closing=state("budget"); cli("resume","budget"); const resumed=state("budget");
      await fire("budget","resumed-reply",5000); clock+=150000; await tickOne("budget");
      console.log(JSON.stringify({closing,resumed,state:state("budget"),sent:sent()}));
    `);
    expect(result.closing.status).toBe("closing");
    expect(result.closing.fires).toBe(replies);
    expect(result.resumed.fires).toBe(kept);
    expect(result.sent).toHaveLength(replies + 1);
    expect(result.sent.at(-1).join(" ")).toContain("resumed-reply");
    expect(result.state.fires).toBe(kept + 1);
    expect(result.state.status).toBe(max === 1 ? "done" : "active");
  });
}
