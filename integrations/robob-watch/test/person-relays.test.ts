import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each scenario imports the runner in its own sandbox and advances its clock between completed ticks.
async function scenario(body: string) {
  const root = mkdtempSync(join(tmpdir(), "person-relays-"));
  writeFileSync(join(root, "bridge.ts"), `import {appendFileSync,existsSync} from "node:fs";
if(existsSync(${JSON.stringify(join(root, "fail"))})) process.exit(1);
const args = process.argv.slice(2).flatMap(a => { const i = a.indexOf("="); return a.startsWith("--") && i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a]; });
appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify(args)+"\\n"); console.log("ok");`);
  const source = `
    import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
    import { join } from "node:path";
    const root = ${JSON.stringify(root)};
    process.env.ROBOB_TEST = "1";
    delete process.env.ROBOB_WATCH_TEST_BATCH_MS;
    process.env.ROBOB_WATCH_ROOT = root;
    process.env.TOOLLOG_DIR = join(root,"logs");
    process.env.HEALTH_TOOLLOG_DIR = join(root,"health-logs");
    process.env.WACLI_STORE_DIR = join(root,"wacli");
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
    const shell = args => args.map(s=>"'"+s.replaceAll("'", "'\\''")+"'").join(" ");
    const cliShell = shell(["env", "ROBOB_WATCH_ROOT="+root, "ROBOB_TEST=1", process.execPath, ${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))}]);
    function add(id, extra={}) {
      const dir = lib.watcherDir(id);
      mkdirSync(dir, {recursive:true});
      lib.writeJson(join(dir,"watcher.json"), lib.normalize({id,title:id,check:'if [[ -f event ]]; then cat event; rm event; fi; true',context:'{}',mode:'wake',interval_s:5,max_fires:0,...extra}));
    }
    function addReplyWatcher(id, extra={}) {
      const replyCheck=extra.check ?? 'if [[ -f event ]]; then cat event; rm event; fi; true';
      add(id,{...extra,inflight_check:extra.inflight_check ?? replyCheck});
    }
    function setupWhatsApp() {
      const store=process.env.WACLI_STORE_DIR; mkdirSync(store,{recursive:true}); mkdirSync(lib.HELPERS,{recursive:true});
      for(const helper of ["whatsapp-new-message","wa-db","redact.py","toollog.py","toollog.zsh"]) writeFileSync(join(lib.HELPERS,helper),readFileSync(join(${JSON.stringify(join(import.meta.dir,"../helpers"))},helper)),{mode:0o755});
      const db=new Database(join(store,"wacli.db"));
      db.exec('create table contacts (jid text primary key, phone text, push_name text, full_name text, first_name text, business_name text, system_name text, updated_at int); create table contact_aliases (jid text primary key, alias text, notes text, updated_at int); create table chats (jid text primary key, kind text, name text, last_message_ts int, unread_count int default 0); create table messages (rowid integer primary key autoincrement, chat_jid text, chat_name text, msg_id text, sender_jid text, sender_name text, ts int, from_me int, text text, display_text text, media_type text, media_caption text, filename text, reaction_emoji text, edited int default 0, edited_ts int default 0, revoked int default 0, deleted_at int, unique(chat_jid,msg_id))');
      const jid="971500000001@s.whatsapp.net";
      db.query("insert into contacts values (?,?,'Provider','','','','',0)").run(jid,"971500000001");
      const session=new Database(join(store,"session.db")); session.exec("create table whatsmeow_lid_map (lid text primary key,pn text unique not null)"); session.close();
      writeFileSync(join(store,"LOCK"),"pid="+process.pid+"\\n");
      let n=0;
      return { poll:shell([join(lib.HELPERS,"whatsapp-new-message"),jid]),
        insert(text){db.query("insert into messages (chat_jid,msg_id,sender_jid,ts,from_me,text,display_text) values (?,?,?,?,0,?,?)").run(jid,"reply-"+(++n),jid,Math.floor(new Date().getTime()/1000),text,text)},
        outbox(id){return join(lib.watcherDir(id),"wadb-971500000001.json.outbox")},
        prime(id){const r=Bun.spawnSync([join(lib.HELPERS,"whatsapp-new-message"),jid],{env:{...process.env,WATCH_DIR:lib.watcherDir(id),WATCH_RUN:"baseline"}}); if(r.exitCode)throw new Error(r.stderr.toString()); writeFileSync(join(lib.watcherDir(id),".run-ok"),"baseline\\n")}
      };
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
    addReplyWatcher("closing",{expires_at:new Date(clock+10000).toISOString(),max_fires:1});
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
    addReplyWatcher("now"); cli("rm","now","--now"); clock+=300000; await tickOne("now");
    addReplyWatcher("resume"); lib.saveState("resume",{...state("resume"),fires:2});
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
    addReplyWatcher("race",{check: command+' rm race; echo late-reply'});
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
      addReplyWatcher("archive"); lib.saveState("archive",{...state("archive"),status:${JSON.stringify(status)}});
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
    addReplyWatcher("last-poll",{interval_s:600}); lib.removeWatcher("last-poll"); await tickOne("last-poll");
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
    addReplyWatcher("resume-send",{chat:"moni"}); lib.removeWatcher("resume-send");
    await fire("resume-send",JSON.stringify({urgent:true,event:"offer"}));
    const oldDeadline=state("resume-send").closing_until;
    writeFileSync(stub, 'import {readFileSync,writeFileSync} from "node:fs"; const file='+JSON.stringify(join(lib.watcherDir("resume-send"),"state.json"))+'; const s=JSON.parse(readFileSync(file,"utf8")); s.status="active"; delete s.closing_until; delete s.closing_from; delete s.closing_watcher; writeFileSync(file,JSON.stringify(s)); console.log("ok");');
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
      addReplyWatcher("rearm",{max_fires:${status == "active" ? 3 : 1},${status == "expired" ? 'expires_at:"1970-01-01T00:00:00Z",' : ''}});
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
      addReplyWatcher("budget",{max_fires:${max}}); lib.removeWatcher("budget");
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

for (const mode of ["notify", "wake"]) {
  test(`removing a completed ${mode} watcher never reruns its level-triggered check`, async () => {
    const result = await scenario(`
      add("completed",{mode:${JSON.stringify(mode)},max_fires:1,check:'echo run >> normal-runs; echo level-triggered'});
      await tickOne("completed"); clock+=150000; await tickOne("completed");
      const before=sent().length;
      cli("remove","completed"); await tickOne("completed"); clock+=5000; await tickOne("completed");
      console.log(JSON.stringify({before,sent:sent().length,exists:!!lib.loadWatcher("completed")}));
    `);
    expect(result.before).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.exists).toBe(false);
  });

  test(`removing a canceled ${mode} reminder prevents the shipped time-reached check`, async () => {
    const result = await scenario(`
      const check=${JSON.stringify(join(import.meta.dir, "../helpers/time-reached"))}+' 1970-01-01T00:00:00+00:00 canceled-reminder';
      add("reminder",{mode:${JSON.stringify(mode)},max_fires:1,check});
      cli("rm","reminder"); await tickOne("reminder"); clock+=150000; await tickOne("reminder");
      console.log(JSON.stringify({sent:sent(),exists:!!lib.loadWatcher("reminder")}));
    `);
    expect(result.sent).toEqual([]);
    expect(result.exists).toBe(false);
  });
}


for (const mode of ["wake", "notify"]) {
  test(`a canceled ${mode} reminder discards an event accepted before cancellation`, async () => {
    const result = await scenario(`
      add("queued-reminder",{mode:${JSON.stringify(mode)},check:"echo queued-reminder",max_fires:1});
      writeFileSync(join(root,"fail"),""); await tickOne("queued-reminder");
      const accepted=!!(state("queued-reminder").batch || state("queued-reminder").pending);
      lib.removeWatcher("queued-reminder"); clock+=150000; await tickOne("queued-reminder");
      console.log(JSON.stringify({accepted,sent:sent(),exists:!!lib.loadWatcher("queued-reminder")}));
    `);
    expect(result.accepted).toBe(true);
    expect(result.sent).toEqual([]);
    expect(result.exists).toBe(false);
  });
}

for (const status of ["active", "done", "expired"]) {
  for (const paused of [false, true]) {
    test(`ordinary removal preserves cancellation for ${status}, paused=${paused}`, async () => {
      const result = await scenario(`
        const marker=join(root,"outreach-ran");
        add("ordinary",{mode:"notify",paused:${paused},check:'echo run > '+marker+'; echo unsafe'});
        lib.saveState("ordinary",{...state("ordinary"),status:${JSON.stringify(status)}});
        const removed=lib.removeWatcher("ordinary"); clock+=300000; await tickOne("ordinary");
        const archived=JSON.parse(readFileSync(join(removed.archived,"state.json"),"utf8"));
        console.log(JSON.stringify({sent:sent(),ran:existsSync(marker),archived,exists:!!lib.loadWatcher("ordinary")}));
      `);
      expect(result.sent).toEqual([]);
      expect(result.ran).toBe(false);
      expect(result.archived.status).toBe(status);
      expect(result.exists).toBe(false);
    });
  }
}

test("explicit in-flight polling never reruns the normal outreach check and freezes its reply command", async () => {
  const result = await scenario(`
    const marker=join(root,"outreach-ran");
    add("reply-only",{check:'echo run >> '+marker+'; echo unsafe',
      inflight_check:'[[ "$WATCH_CLOSING" = 1 ]] || exit 7; if [[ -f event ]]; then cat event; rm event; fi; true'});
    lib.saveState("reply-only",{...state("reply-only"),status:"done",fires:1});
    lib.removeWatcher("reply-only");
    const definition=lib.loadWatcher("reply-only"); definition.check='echo replaced >> '+marker;
    definition.inflight_check='echo wrong-reply-command'; definition.chat="moni";
    lib.writeJson(join(lib.watcherDir("reply-only"),"watcher.json"),definition);
    await fire("reply-only","existing-provider-reply",300000); clock+=150000; await tickOne("reply-only");
    console.log(JSON.stringify({sent:sent(),ran:existsSync(marker),state:state("reply-only"),definition:lib.loadWatcher("reply-only")}));
  `);
  expect(result.ran).toBe(false);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0]).not.toContain("--chat");
  expect(result.sent[0].join(" ")).toContain("existing-provider-reply");
  expect(result.sent[0].join(" ")).not.toContain("wrong-reply-command");
  expect(result.definition.paused).toBe(false);
});

test("an ordinary check completing after removal cannot emit into reply grace", async () => {
  const result = await scenario(`
    const command=["env","ROBOB_WATCH_ROOT="+root,"ROBOB_TEST=1",process.execPath,${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))}].map(s=>"'"+s.replaceAll("'","'\\''")+"'").join(" ");
    add("transition",{check:command+' rm transition; echo normal-output',inflight_check:'if [[ -f event ]]; then cat event; rm event; fi; true'});
    await tickOne("transition");
    await fire("transition","in-flight-only-reply",300000); clock+=150000; await tickOne("transition");
    console.log(JSON.stringify({sent:sent()}));
  `);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].join(" ")).toContain("in-flight-only-reply");
  expect(result.sent[0].join(" ")).not.toContain("normal-output");
});

test("CLI scratch tests use the closing reply command and flag without consuming live replies", async () => {
  const result = await scenario(`
    add("scratch-reply",{check:'echo unsafe',inflight_check:'[[ "$WATCH_CLOSING" = 1 ]] || exit 7; cat event; rm event'});
    lib.removeWatcher("scratch-reply"); writeFileSync(join(lib.watcherDir("scratch-reply"),"event"),"existing-reply");
    const scratch=JSON.parse(cli("test","scratch-reply"));
    console.log(JSON.stringify({scratch,live:readFileSync(join(lib.watcherDir("scratch-reply"),"event"),"utf8"),sent:sent()}));
  `);
  expect(result.scratch.stdout).toBe("existing-reply");
  expect(result.live).toBe("existing-reply");
  expect(result.sent).toEqual([]);
});

test("CLI and JSON explicitly configure in-flight-only polling, with validation and a full-replace opt-out", async () => {
  const result = await scenario(`
    cli("add","--id","capability","--title","capability","--check","true","--context","{}","--inflight-check","echo reply","--no-prime");
    const initial=lib.loadWatcher("capability");
    cli("add","--id","capability","--title","capability","--check","true","--context","{}","--replace");
    const preserved=lib.loadWatcher("capability").inflight_check;
    const file=join(root,"definition.json"); writeFileSync(file,JSON.stringify({...initial,inflight_check:undefined}));
    cli("add","--json",file,"--replace"); const cleared=lib.loadWatcher("capability").inflight_check;
    const invalid=[null,false,0,[],{},""," "].map(inflight_check=>{try{lib.normalize({...initial,inflight_check});return false}catch{return true}});
    const valid=lib.normalize({...initial,inflight_check:"  echo json-reply  "}).inflight_check;
    console.log(JSON.stringify({initial,preserved,cleared,invalid,valid}));
  `);
  expect(result.initial.inflight_check).toBe("echo reply");
  expect(result.preserved).toBe("echo reply");
  expect(result.cleared).toBeUndefined();
  expect(result.invalid).toEqual(Array(7).fill(true));
  expect(result.valid).toBe("echo json-reply");
});


test("pausing an opted-in closing watcher stops reply polling and archives at the deadline", async () => {
  const result = await scenario(`
    addReplyWatcher("pause-grace"); lib.removeWatcher("pause-grace"); const until=state("pause-grace").closing_until;
    cli("pause","pause-grace"); await fire("pause-grace","held-reply",300000);
    clock=until; await tickOne("pause-grace");
    console.log(JSON.stringify({sent:sent(),exists:!!lib.loadWatcher("pause-grace")}));
  `);
  expect(result.sent).toEqual([]);
  expect(result.exists).toBe(false);
});

test("removing an already paused reply watcher does not undo the pause", async () => {
  const result = await scenario(`
    addReplyWatcher("paused-reply",{paused:true}); lib.removeWatcher("paused-reply"); await tickOne("paused-reply");
    console.log(JSON.stringify({sent:sent(),exists:!!lib.loadWatcher("paused-reply")}));
  `);
  expect(result.sent).toEqual([]);
  expect(result.exists).toBe(false);
});

for (const [before, after] of [[undefined,"moni"],["moni",undefined],["moni","family-trip"],["family-trip","moni"]]) {
  for (const urgent of [false, true]) {
    test(`retarget then remove retains the outbox recipient ${before ?? "owner"} -> ${after ?? "owner"}, urgent=${urgent}`, async () => {
      const result = await scenario(`
        const script=join(root,"poll.sh"); const check="zsh "+shell([script]);
        const replacement=join(root,"replacement.json");
        writeFileSync(script,[
          'if [[ -f outbox ]]; then',
          'if [[ "$(cat .run-ok 2>/dev/null)" != "$(cat outbox-run)" ]]; then echo "$WATCH_RUN" > outbox-run; cat outbox; exit 0; fi',
          'rm outbox outbox-run; fi',
          'if [[ -f event ]]; then mv event outbox; echo "$WATCH_RUN" > outbox-run; cat outbox; fi',
          'if [[ -f mutate ]]; then rm mutate; '+cliShell+' add --json '+shell([replacement])+' --replace >/dev/null; '+cliShell+' rm replay >/dev/null; fi'
        ].join("\\n"));
        addReplyWatcher("replay",{check,...${JSON.stringify(before ? {chat:before} : {})}});
        writeFileSync(replacement,JSON.stringify({...lib.loadWatcher("replay"),chat:${JSON.stringify(after) ?? "undefined"}}));
        writeFileSync(join(lib.watcherDir("replay"),"mutate"),"");
        await fire("replay",${JSON.stringify(urgent ? JSON.stringify({urgent:true,event:"private-old-chat-reply"}) : "private-old-chat-reply")});
        lib.saveState("replay",{...state("replay"),closing_until:clock+900000});
        clock+=5000; await tickOne("replay"); clock+=150000; await tickOne("replay"); clock+=5000; await tickOne("replay");
        console.log(JSON.stringify({sent:sent(),state:state("replay")}));
      `);
      expect(result.sent).toHaveLength(1);
      const args=result.sent[0];
      if (before) expect(args[args.indexOf("--chat")+1]).toBe(before);
      else expect(args).not.toContain("--chat");
      expect(args.join(" ")).toContain("private-old-chat-reply");
      expect(result.state.fires).toBe(1);
    });
  }
}

test("a canceled wrapper hands its outbox to the reply-only command without relaying wrapper stdout", async () => {
  const result = await scenario(`
    const script=join(root,"poll.sh"); const poll="zsh "+shell([script]);
    writeFileSync(script,[
      'if [[ -f outbox ]]; then',
      'if [[ "$(cat .run-ok 2>/dev/null)" != "$(cat outbox-run)" ]]; then echo "$WATCH_RUN" > outbox-run; cat outbox; exit 0; fi',
      'rm outbox outbox-run; fi',
      'if [[ -f event ]]; then mv event outbox; echo "$WATCH_RUN" > outbox-run; cat outbox; fi'
    ].join("\\n"));
    add("discard-outbox",{check:poll+'; '+cliShell+' rm discard-outbox >/dev/null; echo canceled-normal-output',inflight_check:poll});
    await fire("discard-outbox","provider-reply");
    lib.saveState("discard-outbox",{...state("discard-outbox"),closing_until:clock+900000});
    clock+=5000; await tickOne("discard-outbox");
    clock+=150000; await tickOne("discard-outbox");
    console.log(JSON.stringify({sent:sent()}));
  `);
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].join(" ")).toContain("provider-reply");
  expect(result.sent[0].join(" ")).not.toContain("canceled-normal-output");
});

for(const options of [
  {before:null,after:null}, {before:"moni",after:"moni"},
  {before:null,after:"moni"}, {before:"moni",after:null},
  {before:"moni",after:"family-trip"}, {before:"family-trip",after:"moni"},
  {before:null,after:null,mode:"notify"},
  {before:null,after:"moni",retry:true},
  {before:null,after:"moni",boundary:true},
  {before:null,after:"moni",resume:true},
  {before:null,after:"moni",silent:true},
  {before:null,after:"moni",ackFail:true}
]) {
  test(`shipped poller handoff ${options.before ?? "owner"} -> ${options.after ?? "owner"} ${options.mode ?? "wake"} retry=${!!options.retry} boundary=${!!options.boundary} resume=${!!options.resume} silent=${!!options.silent} ackFail=${!!options.ackFail}`, async()=>{
    const result=await scenario(`
      const options=${JSON.stringify(options)}; const wa=setupWhatsApp();
      const reply='[[ "$WATCH_CLOSING" = 1 ]] || exit 8; [[ ! -f reply-fail ]] || exit 7; '+wa.poll+(options.ackFail?'; if [[ ! -f blocked-ack ]]; then touch blocked-ack; rm .run-ok; mkdir .run-ok; fi':'');
      const replacement=join(root,"replacement.json");
      const check=wa.poll+(options.silent?' >/dev/null':'')+'; '+cliShell+' add --json '+shell([replacement])+' --replace >/dev/null; '+cliShell+' rm handoff >/dev/null; echo arbitrary-canceled-normal-output';
      add("handoff",{check,inflight_check:reply,context:"original-private-context",mode:options.mode??"wake",...(options.before?{chat:options.before}:{})});
      const next={...lib.loadWatcher("handoff"),context:"replacement-private-context"};
      if(options.after)next.chat=options.after; else delete next.chat;
      writeFileSync(replacement,JSON.stringify(next));
      wa.prime("handoff"); wa.insert("provider-reply-before-remove");
      await tickOne("handoff");
      const old=JSON.parse(readFileSync(wa.outbox("handoff"),"utf8"));
      const ackBefore=readFileSync(join(lib.watcherDir("handoff"),".run-ok"),"utf8").trim();
      lib.saveState("handoff",{...state("handoff"),closing_until:clock+900000});
      if(options.resume){lib.editWatcher("handoff",w=>({...w,check:wa.poll})); cli("resume","handoff"); const scratch=JSON.parse(cli("test","handoff")); if(scratch.exit!==0)throw new Error("handoff scratch failed")}
      if(options.retry){writeFileSync(join(lib.watcherDir("handoff"),"reply-fail"),""); await tickOne("handoff"); rmSync(join(lib.watcherDir("handoff"),"reply-fail")); clock+=5000}
      if(options.boundary)clock+=900000;
      const restarted=await import(${JSON.stringify(join(import.meta.dir,"../src/runner.ts"))}+"?handoff-restart");
      await restarted.tickOne("handoff");
      const replayed=existsSync(wa.outbox("handoff"))?JSON.parse(readFileSync(wa.outbox("handoff"),"utf8")):null;
      if(options.ackFail){if(state("handoff").reply_handoff?.accepted_run!==replayed.run)throw new Error("acceptance not recorded"); rmSync(join(lib.watcherDir("handoff"),".run-ok"),{recursive:true}); await restarted.tickOne("handoff")}
      const ackAfter=readFileSync(join(lib.watcherDir("handoff"),".run-ok"),"utf8").trim();
      clock+=150000; await restarted.tickOne("handoff"); clock+=5000; await restarted.tickOne("handoff");
      const first=sent();
      if(!options.boundary){wa.insert("provider-reply-after-handoff"); clock+=5000; await restarted.tickOne("handoff"); clock+=150000; await restarted.tickOne("handoff")}
      console.log(JSON.stringify({old,ackBefore,replayed,ackAfter,first,sent:sent()}));
    `);
    expect(result.ackBefore).not.toBe(result.old.run);
    expect(result.replayed?.run).not.toBe(result.old.run);
    expect(result.ackAfter).toBe(result.replayed?.run);
    expect(result.first).toHaveLength(1);
    const first=result.first[0];
    if(options.before)expect(first[first.indexOf("--chat")+1]).toBe(options.before); else expect(first).not.toContain("--chat");
    expect(first.join(" ")).toContain("provider-reply-before-remove");
    expect(first.join(" ")).not.toContain("arbitrary-canceled-normal-output");
    if(!options.mode){expect(first.join(" ")).toContain("original-private-context"); expect(first.join(" ")).not.toContain("replacement-private-context")}
    if(!options.boundary){
      expect(result.sent).toHaveLength(2); const second=result.sent[1];
      if(options.after)expect(second[second.indexOf("--chat")+1]).toBe(options.after); else expect(second).not.toContain("--chat");
      expect(second.join(" ")).toContain("provider-reply-after-handoff");
      expect(second.join(" ")).not.toContain("provider-reply-before-remove");
    }
  },20_000);
}

for (const mode of ["wake","notify"]) {
  for (const removal of ["ordinary","now","reply-now"]) {
    test(`a removed ${mode} check cannot enter a replacement instance (${removal})`, async () => {
      const result = await scenario(`
        const replacement=join(root,"replacement.json");
        writeFileSync(replacement,JSON.stringify({id:"reuse",title:"replacement",check:"echo replacement-output",context:"replacement",mode:${JSON.stringify(mode)},interval_s:5,max_fires:1}));
        const rejected=join(root,"rejected");
        add("reuse",{mode:${JSON.stringify(mode)},${removal === "reply-now" ? 'inflight_check:"echo reply-only",' : ''}check:cliShell+' rm reuse${removal === "ordinary" ? '' : ' --now'} >/dev/null; '+cliShell+' add --json '+shell([replacement])+' --no-prime >/dev/null 2>'+shell([rejected])+'; echo canceled-output'});
        const original=lib.watcherInstance("reuse"); await tickOne("reuse"); const missing=!lib.loadWatcher("reuse");
        let afterExit=""; try{cli("add","--json",replacement,"--no-prime")}catch(error){afterExit=error.message}
        const fresh=JSON.parse(readFileSync(replacement,"utf8")); fresh.id="reuse-new"; writeFileSync(replacement,JSON.stringify(fresh));
        cli("add","--json",replacement,"--no-prime"); const before=state("reuse-new"); const newInstance=lib.watcherInstance("reuse-new");
        await tickOne("reuse-new"); clock+=150000; await tickOne("reuse-new");
        console.log(JSON.stringify({missing,afterExit,rejected:readFileSync(rejected,"utf8"),original,newInstance,before,sent:sent(),state:state("reuse-new")}));
      `);
      expect(result.missing).toBe(true);
      expect(result.rejected).toContain("was removed; use a new ID");
      expect(result.afterExit).toContain("was removed; use a new ID");
      expect(result.original).not.toBe(result.newInstance);
      expect(result.before.fires).toBe(0);
      expect(result.before.batch).toBeUndefined();
      expect(result.before.pending).toBeUndefined();
      expect(result.sent).toHaveLength(1);
      expect(result.sent[0].join(" ")).toContain("replacement-output");
      expect(result.sent[0].join(" ")).not.toContain("canceled-output");
      expect(result.state.fires).toBe(1);
    });
  }
}

for (const ownChecker of [false,true]) {
  test(`handoff uses only the admitted reply checker, configured=${ownChecker}`,async()=>{
    const result=await scenario(`
      const replacement=join(root,"replacement.json");
      const oldReply='echo admitted-private-reply';
      add("checker-owner",{context:"admitted-context",${ownChecker?'inflight_check:oldReply,':''}check:cliShell+' add --json '+shell([replacement])+' --replace >/dev/null; '+cliShell+' rm checker-owner >/dev/null; echo canceled-stdout'});
      writeFileSync(replacement,JSON.stringify({...lib.loadWatcher("checker-owner"),chat:"moni",context:"replacement-context",inflight_check:'echo replacement-private-reply'}));
      await tickOne("checker-owner"); const handoff=state("checker-owner").reply_handoff;
      lib.saveState("checker-owner",{...state("checker-owner"),closing_until:clock+900000});
      await tickOne("checker-owner"); clock+=150000; await tickOne("checker-owner");
      console.log(JSON.stringify({handoff,sent:sent()}));
    `);
    expect(!!result.handoff).toBe(ownChecker);
    expect(result.sent).toHaveLength(1);
    const args=result.sent[0];
    if(ownChecker){expect(args).not.toContain("--chat");expect(args.join(" ")).toContain("admitted-private-reply");expect(args.join(" ")).not.toContain("replacement-private-reply")}
    else{expect(args[args.indexOf("--chat")+1]).toBe("moni");expect(args.join(" ")).toContain("replacement-private-reply");expect(args.join(" ")).not.toContain("admitted-private-reply")}
    expect(args.join(" ")).not.toContain("canceled-stdout");
  });
}

for(const repair of ["ack-file","recorded-crash"]) {
  test(`discarded shared-poller output is acknowledged before replacement recovery (${repair})`,async()=>{
    const result=await scenario(`
      const wa=setupWhatsApp(); const replacement=join(root,"replacement.json");
      add("discard-repair",{check:wa.poll+'; '+cliShell+' add --json '+shell([replacement])+' --replace >/dev/null; '+cliShell+' rm discard-repair >/dev/null; rm .run-ok; mkdir .run-ok'});
      writeFileSync(replacement,JSON.stringify({...lib.loadWatcher("discard-repair"),chat:"moni",context:"new-recipient-context",inflight_check:wa.poll}));
      wa.prime("discard-repair"); wa.insert("canceled-old-recipient-reply"); await tickOne("discard-repair");
      const obligation=state("discard-repair").discarded_run;
      await tickOne("discard-repair"); const blocked=sent();
      rmSync(join(lib.watcherDir("discard-repair"),".run-ok"),{recursive:true});
      if(${JSON.stringify(repair)}==="recorded-crash")writeFileSync(join(lib.watcherDir("discard-repair"),".run-ok"),"baseline");
      lib.saveState("discard-repair",{...state("discard-repair"),closing_until:clock+900000});
      wa.insert("replacement-recipient-reply");
      const restarted=await import(${JSON.stringify(join(import.meta.dir,"../src/runner.ts"))}+"?discard-restart");
      await restarted.tickOne("discard-repair"); clock+=150000; await restarted.tickOne("discard-repair");
      console.log(JSON.stringify({obligation,blocked,sent:sent(),state:state("discard-repair")}));
    `);
    expect(result.obligation).toBeString();
    expect(result.blocked).toEqual([]);
    expect(result.state.discarded_run).toBeUndefined();
    expect(result.sent).toHaveLength(1);
    const args=result.sent[0]; expect(args[args.indexOf("--chat")+1]).toBe("moni");
    expect(args.join(" ")).toContain("replacement-recipient-reply");
    expect(args.join(" ")).not.toContain("canceled-old-recipient-reply");
  },20_000);
}

test("a reply recovered into an existing batch retains its admitted context",async()=>{
  const result=await scenario(`
    add("context-handoff",{context:"context-A",inflight_check:'if [[ -f reply ]]; then cat reply; rm reply; fi; true'});
    await fire("context-handoff","earlier-event");
    lib.editWatcher("context-handoff",w=>({...w,context:"context-B",check:cliShell+' rm context-handoff >/dev/null; echo canceled-stdout'}));
    writeFileSync(join(lib.watcherDir("context-handoff"),"reply"),"recovered-event");
    clock+=5000; await tickOne("context-handoff");
    lib.saveState("context-handoff",{...state("context-handoff"),closing_until:clock+900000});
    await tickOne("context-handoff");
    lib.editWatcher("context-handoff",w=>({...w,context:"context-C"}));
    clock+=150000; await tickOne("context-handoff");
    console.log(JSON.stringify({sent:sent()}));
  `);
  expect(result.sent).toHaveLength(1);
  const text=result.sent[0].join(" ");
  for(const expected of ["earlier-event","recovered-event","context-B"])expect(text).toContain(expected);
  for(const unwanted of ["context-A","context-C","canceled-stdout"])expect(text).not.toContain(unwanted);
});

for(const mode of ["notify","wake"]) {
  for(const limits of [[1,0],[3,2],[0,1]]) {
    test(`resumed ${mode} recovery honors the current fire limit ${limits[0]} -> ${limits[1]}`,async()=>{
      const result=await scenario(`
        const event=${JSON.stringify(JSON.stringify({urgent:true,event:"recovered-reply"}))};
        add("limit-handoff",{mode:${JSON.stringify(mode)},max_fires:${limits[0]},inflight_check:'if [[ -f reply ]]; then cat reply; rm reply; fi; true',check:cliShell+' rm limit-handoff >/dev/null; echo canceled-stdout'});
        await tickOne("limit-handoff");
        lib.editWatcher("limit-handoff",w=>({...w,max_fires:${limits[1]},check:'if [[ -f event ]]; then cat event; rm event; fi; true'}));
        cli("resume","limit-handoff");
        writeFileSync(join(lib.watcherDir("limit-handoff"),"reply"),event);
        await tickOne("limit-handoff"); const recovered=state("limit-handoff");
        await fire("limit-handoff",JSON.stringify({urgent:true,event:"normal-after-resume"}),5000);
        console.log(JSON.stringify({recovered,sent:sent(),state:state("limit-handoff")}));
      `);
      expect(result.recovered.fires).toBe(1);
      expect(result.recovered.status).toBe(limits[1]===1?"done":"active");
      expect(result.sent).toHaveLength(limits[1]===1?1:2);
      expect(result.sent[0].join(" ")).toContain("recovered-reply");
    });
  }
}

for (const action of ["resume","remove"]) {
  test(`pausing during a closing poll holds its urgent result until ${action}`, async () => {
    const result = await scenario(`
      const event=${JSON.stringify(JSON.stringify({urgent:true,event:"paused-reply"}))};
      addReplyWatcher("pause-running",{check:cliShell+' pause pause-running >/dev/null; echo '+shell([event])});
      lib.removeWatcher("pause-running"); await tickOne("pause-running"); const before=sent(); const pending=state("pause-running").pending;
      cli(${JSON.stringify(action)},"pause-running",${action === "resume" ? '"--expires","1d"' : '"--now"'}); await tickOne("pause-running");
      console.log(JSON.stringify({before,pending,sent:sent()}));
    `);
    expect(result.before).toEqual([]);
    expect(result.pending.event).toContain("paused-reply");
    expect(result.sent).toHaveLength(action === "resume" ? 1 : 0);
  });
}

test("a removed helper cannot write its absolute WATCH_DIR outbox into a reused ID", async () => {
  const result = await scenario(`
    const replacement=join(root,"replacement.json"); const report=join(root,"helper-report.json");
    writeFileSync(replacement,JSON.stringify({id:"io",title:"replacement",mode:"wake",chat:"moni",context:"replacement",interval_s:5,max_fires:1,
      check:'if [[ -f "$WATCH_DIR/outbox" ]]; then cat "$WATCH_DIR/outbox"; else echo fresh-replacement; fi'}));
    const commands=["env","ROBOB_WATCH_ROOT="+root,"ROBOB_TEST=1",process.execPath,${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))}];
    const helper=[
      'import json, os, pathlib, subprocess',
      'cmd='+JSON.stringify(commands),
      'wdir=pathlib.Path(os.environ["WATCH_DIR"])',
      'old=wdir.joinpath("cursor").read_text()',
      'subprocess.run(cmd+["rm","io","--now"], check=True, capture_output=True)',
      'blocked=subprocess.run(cmd+["add","--json",'+JSON.stringify(replacement)+',"--no-prime"], capture_output=True)',
      'wdir.mkdir(parents=True, exist_ok=True)',
      'wdir.joinpath("outbox").write_text(old); wrote=True',
      'pathlib.Path('+JSON.stringify(report)+').write_text(json.dumps({"blocked":blocked.returncode,"wrote":wrote}))',
      'print(old)'
    ].join("\\n");
    add("io",{check:"/usr/bin/python3 -I -c "+shell([helper])});
    writeFileSync(join(lib.watcherDir("io"),"cursor"),"private-canceled-reply");
    await tickOne("io"); const missing=!lib.loadWatcher("io");
    let rejected=""; try{cli("add","--json",replacement,"--no-prime")}catch(error){rejected=error.message}
    const fresh=JSON.parse(readFileSync(replacement,"utf8")); fresh.id="io-new"; writeFileSync(replacement,JSON.stringify(fresh));
    cli("add","--json",replacement,"--no-prime");
    await tickOne("io-new"); clock+=150000; await tickOne("io-new");
    console.log(JSON.stringify({missing,rejected,report:JSON.parse(readFileSync(report,"utf8")),sent:sent(),state:state("io-new")}));
  `);
  expect(result.missing).toBe(true);
  expect(result.report.blocked).not.toBe(0);
  expect(result.report.wrote).toBe(true);
  expect(result.rejected).toContain("was removed; use a new ID");
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].join(" ")).toContain("fresh-replacement");
  expect(result.sent[0].join(" ")).not.toContain("private-canceled-reply");
  expect(result.state.fires).toBe(1);
});

test("a detached helper's delayed outbox cannot reactivate a retired ID", async () => {
  const result = await scenario(`
    const address=join(root,"helper.sock"); let helperSocket;
    let readyResolve, doneResolve;
    const ready=new Promise(resolve=>readyResolve=resolve); const done=new Promise(resolve=>doneResolve=resolve);
    const server=Bun.listen({unix:address,socket:{data(socket,data){
      if(data.toString().includes("ready")){helperSocket=socket;readyResolve()}
      if(data.toString().includes("done"))doneResolve();
    }}});
    const helper=[
      'import os, pathlib, socket',
      'os.setsid()',
      'wdir=pathlib.Path(os.environ["WATCH_DIR"])',
      'old=wdir.joinpath("cursor").read_text()',
      's=socket.socket(socket.AF_UNIX); s.connect('+JSON.stringify(address)+')',
      's.sendall(b"ready"); s.recv(2)',
      'wdir.mkdir(parents=True, exist_ok=True); wdir.joinpath("outbox").write_text(old)',
      's.sendall(b"done"); s.close()'
    ].join("\\n");
    add("detached",{check:"/usr/bin/python3 -I -c "+shell([helper])+" </dev/null >/dev/null 2>&1 &"});
    writeFileSync(join(lib.watcherDir("detached"),"cursor"),"private-detached-reply");
    await tickOne("detached"); await ready; lib.removeWatcher("detached",true);
    helperSocket.write("go"); await done; server.stop(true);
    const definition=join(root,"replacement.json");
    const replacement={id:"detached",title:"replacement",mode:"wake",chat:"moni",context:"replacement",interval_s:5,max_fires:1,
      check:'if [[ -f "$WATCH_DIR/outbox" ]]; then cat "$WATCH_DIR/outbox"; else echo fresh-replacement; fi'};
    writeFileSync(definition,JSON.stringify(replacement));
    let rejected=""; try{cli("add","--json",definition,"--replace","--no-prime")}catch(error){rejected=error.message}
    replacement.id="detached-new"; writeFileSync(definition,JSON.stringify(replacement)); cli("add","--json",definition,"--no-prime");
    await tickOne("detached"); await tickOne("detached-new"); clock+=150000; await tickOne("detached-new");
    console.log(JSON.stringify({rejected,retired:!lib.loadWatcher("detached"),residue:readFileSync(join(lib.watcherDir("detached"),"outbox"),"utf8"),sent:sent()}));
  `);
  expect(result.rejected).toContain("was removed; use a new ID");
  expect(result.retired).toBe(true);
  expect(result.residue).toBe("private-detached-reply");
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].join(" ")).toContain("fresh-replacement");
  expect(result.sent[0].join(" ")).not.toContain("private-detached-reply");
});

for (const residue of ["absent","directory","definition"]) {
  test(`check admission rejects a canceled command with ${residue} residue`, async () => {
    const result=await scenario(`
      const marker=join(root,"outreach-ran");
      add("admission",{check:'echo unsafe > '+shell([marker])});
      const watcher=lib.loadWatcher("admission"); const instance=lib.watcherInstance("admission");
      lib.removeWatcher("admission",true);
      if(${JSON.stringify(residue)}!=="absent") mkdirSync(lib.watcherDir("admission"),{recursive:true});
      if(${JSON.stringify(residue)}==="definition") lib.writeJson(join(lib.watcherDir("admission"),"watcher.json"),watcher);
      let rejected=""; try{await lib.runCheck(watcher,lib.watcherDir("admission"),{},1000,instance)}catch(error){rejected=error.message}
      console.log(JSON.stringify({rejected,ran:existsSync(marker),listed:lib.listIds(),loaded:!!lib.loadWatcher("admission")}));
    `);
    expect(result.rejected).toContain("removed before check admission");
    expect(result.ran).toBe(false);
    expect(result.listed).not.toContain("admission");
    expect(result.loaded).toBe(false);
  });
}

test("reply grace rejects a stale normal command at admission", async () => {
  const result=await scenario(`
    const marker=join(root,"outreach-ran");
    add("closing-admission",{check:'echo unsafe > '+shell([marker]),inflight_check:'echo "$WATCH_CLOSING"'});
    const watcher=lib.loadWatcher("closing-admission"); const instance=lib.watcherInstance("closing-admission");
    lib.removeWatcher("closing-admission");
    let rejected=""; try{await lib.runCheck(watcher,lib.watcherDir(watcher.id),{},1000,instance)}catch(error){rejected=error.message}
    const poller=lib.pollingWatcher(lib.loadWatcher(watcher.id),state(watcher.id));
    const reply=await lib.runCheck(poller,lib.watcherDir(watcher.id),{WATCH_CLOSING:"0"},1000,instance);
    console.log(JSON.stringify({rejected,ran:existsSync(marker),reply}));
  `);
  expect(result.rejected).toContain("check changed before admission");
  expect(result.ran).toBe(false);
  expect(result.reply.code).toBe(0);
  expect(result.reply.stdout.trim()).toBe("1");
});

test("a matching reply command uses closing state admitted under the removal lock", async () => {
  const result=await scenario(`
    addReplyWatcher("same-command",{check:'echo "$WATCH_CLOSING"'});
    const watcher=lib.loadWatcher("same-command"); const instance=lib.watcherInstance(watcher.id);
    lib.removeWatcher(watcher.id);
    const reply=await lib.withRelayLock(()=>lib.runCheck(watcher,lib.watcherDir(watcher.id),{WATCH_CLOSING:"0"},1000,instance));
    console.log(JSON.stringify({reply}));
  `);
  expect(result.reply.code).toBe(0);
  expect(result.reply.stdout.trim()).toBe("1");
});
