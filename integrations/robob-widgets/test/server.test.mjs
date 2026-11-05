import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../lib/server.mjs";

let home, server, base, clock, sourceFile, actionFile, injectedFile, counter;
const SOURCE = `
const fs = require('node:fs');
const f = process.argv[1], counter = process.argv[2];
fs.appendFileSync(counter, 'x');
const v = fs.readFileSync(f, 'utf8');
if (v === 'hang') { setInterval(() => {}, 1000); } else if (v === 'bad') { process.exit(1); } else {
 console.log(JSON.stringify({blocks:[{type:'stat',label:'fixture',value:v}]}));
}
`;
const ACTION = `require('node:fs').writeFileSync(process.argv[1], 'ran')`;
const widget = (id) => ({
  id, title: `Title ${id}`, families: ["systemSmall"], refreshMinutes: 15,
  source: { command: [process.execPath, "-e", SOURCE, sourceFile, counter], timeoutSec: 1 },
  actions: [
    { id: "refresh", label: "Refresh", symbol: "arrow.clockwise" },
    { id: "do-it", label: "Do it", symbol: "checkmark", command: [process.execPath, "-e", ACTION, actionFile] },
  ],
});
async function save(item, name = item.id) {
  await writeFile(join(home, "widgets", `${name}.json`), JSON.stringify(item));
}
async function get(path, options) {
  const response = await fetch(`${base}${path}`, options);
  return [response.status, await response.json()];
}
const post = (path, body) => get(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  home = await mkdtemp(join(tmpdir(), "robob-widgets-test-"));
  sourceFile = join(home, "data");
  actionFile = join(home, "action");
  injectedFile = join(home, "injected");
  counter = join(home, "counter");
  await mkdir(join(home, "widgets"));
  await writeFile(sourceFile, "one");
  await save(widget("fixture"));
  clock = Date.parse("2026-11-04T15:20:00Z");
  server = createServer(createHandler({ home, now: () => clock }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

test("lists metadata only and reloads added, edited and removed definitions", async () => {
  assert.deepEqual(await get("/api/widgets"), [200, { widgets: [{ id: "fixture", title: "Title fixture", families: ["systemSmall"], refreshMinutes: 15 }] }]);
  await save(widget("second"));
  let [status, listing] = await get("/api/widgets");
  assert.equal(status, 200);
  assert.deepEqual(listing.widgets.map((x) => x.id), ["fixture", "second"]);
  const updated = { ...widget("second"), title: "New title" };
  await save(updated);
  [, listing] = await get("/api/widgets");
  assert.equal(listing.widgets[1].title, "New title");
  await rm(join(home, "widgets", "second.json"));
  assert.equal((await get("/api/widgets/second"))[0], 404);
});

test("renders source, excludes command metadata, and caches for 60 seconds", async () => {
  const [status, body] = await get("/api/widgets/fixture");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    id: "fixture", title: "Title fixture", asOf: "2026-11-04T15:20:00Z", refreshMinutes: 15,
    blocks: [{ type: "stat", label: "fixture", value: "one" }],
    actions: [{ id: "refresh", label: "Refresh", symbol: "arrow.clockwise" }, { id: "do-it", label: "Do it", symbol: "checkmark" }],
  });
  assert.equal(await readFile(counter, "utf8"), "x");
  await writeFile(sourceFile, "two");
  clock += 59_999;
  assert.equal((await get("/api/widgets/fixture"))[1].blocks[0].value, "one");
  assert.equal(await readFile(counter, "utf8"), "x");
  clock += 1;
  assert.equal((await get("/api/widgets/fixture"))[1].blocks[0].value, "two");
  assert.equal(await readFile(counter, "utf8"), "xx");
});

test("refresh reruns immediately; a failing or timed-out refresh is not success", async () => {
  await writeFile(sourceFile, "three");
  assert.deepEqual(await post("/api/widgets/fixture/actions/refresh"), [200, { ok: true, message: "Refreshed" }]);
  assert.equal((await get("/api/widgets/fixture"))[1].blocks[0].value, "three");
  const t = clock;
  await writeFile(sourceFile, "bad");
  assert.deepEqual(await post("/api/widgets/fixture/actions/refresh"), [502, { error: "Widget source failed" }]);
  let [status, value] = await get("/api/widgets/fixture");
  assert.equal(status, 200);
  assert.equal(value.stale, true);
  assert.equal(value.asOf, new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z"));
  assert.equal(value.blocks[0].value, "three");
  clock += 61_000;
  await writeFile(sourceFile, "hang");
  [status, value] = await get("/api/widgets/fixture");
  assert.equal(status, 200);
  assert.equal(value.stale, true);
  assert.equal(value.blocks[0].value, "three");
  await writeFile(sourceFile, "recovered");
  [status, value] = await get("/api/widgets/fixture");
  assert.equal(status, 200);
  assert.equal(value.blocks[0].value, "recovered");
  assert.equal(value.stale, undefined);
});

test("a source error without cached data is 502", async () => {
  const item = widget("broken");
  item.source.command = [process.execPath, "-e", "process.exit(2)"];
  await save(item);
  assert.deepEqual(await get("/api/widgets/broken"), [502, { error: "Widget source failed" }]);
});

test("validates ids, methods, actions, and does not run request-body commands", async () => {
  for (const path of ["/api/widgets/BAD", "/api/widgets/a%20b", `/api/widgets/${"a".repeat(41)}`, "/api/widgets/%252e%252e"]) {
    assert.equal((await get(path))[0], 400, path);
  }
  assert.equal((await get("/api/widgets/fixture/actions/%25"))[0], 400);
  assert.equal((await get("/api/widgets/fixture/actions/do-it"))[0], 405);
  assert.equal((await post("/api/widgets/fixture/actions/unknown"))[0], 404);
  assert.equal((await post("/api/widgets/no-such/actions/refresh"))[0], 404);
  assert.equal((await get("/api/widgets/fixture/actions/do-it", { method: "POST", headers: { origin: "https://evil.example" } }))[0], 403);
  assert.deepEqual(await post("/api/widgets/fixture/actions/do-it", { command: [process.execPath, "-e", ACTION, injectedFile] }), [200, { ok: true, message: "Action completed" }]);
  assert.equal(await readFile(actionFile, "utf8"), "ran");
  await assert.rejects(readFile(injectedFile), { code: "ENOENT" });
});

test("idempotency rejects invalid and repeated header fields without executing the action", async () => {
  const item = widget("header-check");
  const hits = join(home, "header-hits");
  item.actions[1].command = [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], 'x')", hits];
  await save(item);
  for (const [value, expected] of [["a".repeat(201), 400], ["has\tcontrol", 400], ["café", 400], ["", 200], ["!opaque key#%", 200], ["a".repeat(200), 200]]) {
    const response = await get("/api/widgets/header-check/actions/do-it", { method: "POST", headers: { "Idempotency-Key": value } });
    assert.equal(response[0], expected, JSON.stringify(value));
  }
  // node:http preserves repeated raw header fields; they must not be joined into another key.
  const { request } = await import("node:http");
  const duplicated = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/widgets/header-check/actions/do-it`, {
      method: "POST", headers: ["Idempotency-Key", "one", "Idempotency-Key", "two"],
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(duplicated, 400);
  assert.equal(await readFile(hits, "utf8"), "xxx");
});

test("replay header input shapes fail closed without starting a command", async () => {
  const item = widget("replay-headers"), hits = join(home, "replay-headers-hits");
  item.actions[1].command = [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], 'x')", hits];
  await save(item);
  for (const [headers, expected] of [
    [{ "Idempotency-Replay": "1" }, [400, { error: "Idempotency-Replay needs Idempotency-Key" }]],
    [{ "Idempotency-Replay": "0", "Idempotency-Key": "x" }, [400, { error: "Invalid Idempotency-Replay" }]],
    [{ "Idempotency-Replay": "", "Idempotency-Key": "x" }, [400, { error: "Invalid Idempotency-Replay" }]],
    [{ "Idempotency-Replay": "true", "Idempotency-Key": "x" }, [400, { error: "Invalid Idempotency-Replay" }]],
    [{ "Idempotency-Replay": "1", "Idempotency-Key": "unknown" }, [409, { ok: false, error: "unknown_key", replayable: false, message: "Not run again: the server has no record of this action. Check its effect before tapping again." }]],
  ]) assert.deepEqual(await get("/api/widgets/replay-headers/actions/do-it", { method: "POST", headers }), expected);
  await assert.rejects(readFile(hits), { code: "ENOENT" });
});

test("idempotency completion expiry permits a new run without expiring running entries", async () => {
  const item = widget("expiry"), hits = join(home, "expiry-hits"), gate = join(home, "expiry-gate");
  item.actions[1].command = [process.execPath, "-e", `
    const fs=require('node:fs'); fs.appendFileSync(process.argv[1], 'x');
    const t=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(t)},10);
  `, hits, gate];
  item.source.timeoutSec = 5;
  await save(item);
  const options = { method: "POST", headers: { "Idempotency-Key": "expiry-key" } };
  const first = get("/api/widgets/expiry/actions/do-it", options);
  for (let i = 0; i < 200; i++) {
    try { if (await readFile(hits, "utf8")) break; } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (i === 199) assert.fail("action did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  clock += 11 * 60_000;
  const duplicate = get("/api/widgets/expiry/actions/do-it", { method: "POST", headers: { "Idempotency-Key": "expiry-key", "Idempotency-Replay": "1" } });
  await writeFile(gate, "open");
  assert.deepEqual(await first, await duplicate);
  assert.equal(await readFile(hits, "utf8"), "x");
  clock += 10 * 60_000 - 1;
  assert.equal((await get("/api/widgets/expiry/actions/do-it", { method: "POST", headers: { "Idempotency-Key": "expiry-key", "Idempotency-Replay": "1" } }))[0], 200);
  assert.equal(await readFile(hits, "utf8"), "x");
  clock++;
  assert.deepEqual(await get("/api/widgets/expiry/actions/do-it", { method: "POST", headers: { "Idempotency-Key": "expiry-key", "Idempotency-Replay": "1" } }), [409, { ok: false, error: "unknown_key", replayable: false, message: "Not run again: the server has no record of this action. Check its effect before tapping again." }]);
  assert.equal(await readFile(hits, "utf8"), "x");
  assert.equal((await get("/api/widgets/expiry/actions/do-it", options))[0], 200);
  assert.equal(await readFile(hits, "utf8"), "xx");
});

test("capacity evicts oldest completed key and rejects new keys when all slots are running", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "widgets-capacity-"));
  const fakeWidgets = join(fakeHome, "widgets"), hits = join(fakeHome, "hits"), gate = join(fakeHome, "gate");
  await mkdir(fakeWidgets);
  let fakeClock = 1;
  const handler = createHandler({ home: fakeHome, now: () => fakeClock, responseBudgetMs: 1000 });
  const item = widget("cap");
  item.actions[1].command = [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], 'x')", hits];
  await writeFile(join(fakeWidgets, "cap.json"), JSON.stringify(item));
  const invoke = async (key) => {
    const req = { method: "POST", url: "/api/widgets/cap/actions/do-it", headers: { "idempotency-key": key }, rawHeaders: ["Idempotency-Key", key] };
    const res = new EventEmitter();
    res.writeHead = (status) => { res.statusCode = status; };
    res.end = (body) => { res.body = JSON.parse(body.toString()); };
    await handler(req, res);
    return [res.statusCode, res.body];
  };
  const replay = async (key, action = "do-it") => {
    const req = { method: "POST", url: `/api/widgets/cap/actions/${action}`, headers: { "idempotency-key": key, "idempotency-replay": "1" }, rawHeaders: ["Idempotency-Key", key, "Idempotency-Replay", "1"] };
    const res = new EventEmitter();
    res.writeHead = (status) => { res.statusCode = status; };
    res.end = (body) => { res.body = JSON.parse(body.toString()); };
    await handler(req, res);
    return [res.statusCode, res.body];
  };
  try {
    // A large local burst is slow on a busy Mac; each response may be pending.
    const first = await invoke("first");
    assert.ok([200, 202].includes(first[0]));
    for (let i = 0; i < 200; i++) {
      if ((await invoke("first"))[0] === 200) break;
      if (i === 199) assert.fail("first action never finished");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await readFile(hits, "utf8"), "x");
    item.actions[1].command = [process.execPath, "-e", `
      const fs=require('node:fs');
      const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])) { clearInterval(timer); console.log('{"blocks":[]}'); }},20);
    `, gate];
    item.source.timeoutSec = 60;
    await writeFile(join(fakeWidgets, "cap.json"), JSON.stringify(item));
    // Fill remaining slots with the same running refresh operation rather than 999
    // child processes; distinct action keys still reserve separate entries.
    item.source.command = item.actions[1].command;
    await writeFile(join(fakeWidgets, "cap.json"), JSON.stringify(item));
    const refresh = async (key) => {
      const req = { method: "POST", url: "/api/widgets/cap/actions/refresh", headers: { "idempotency-key": key }, rawHeaders: ["Idempotency-Key", key] };
      const res = new EventEmitter();
      res.writeHead = (status) => { res.statusCode = status; };
      res.end = (body) => { res.body = JSON.parse(body.toString()); };
      await handler(req, res);
      return [res.statusCode, res.body];
    };
    await Promise.all(Array.from({ length: 999 }, (_, i) => refresh(`r${i}`)));
    assert.equal((await refresh("r-overflow"))[0], 202); // evicts the one completed action
    assert.deepEqual(await refresh("r-rejected"), [503, { error: "busy" }]);
    assert.deepEqual(await replay("first"), [409, { ok: false, error: "unknown_key", replayable: false, message: "Not run again: the server has no record of this action. Check its effect before tapping again." }]);
    assert.equal(await readFile(hits, "utf8"), "x");
    // A running key remains attachable even when capacity is full.
    assert.equal((await replay("r0", "refresh"))[0], 202);
    fakeClock += 11 * 60_000;
    assert.equal((await replay("r0", "refresh"))[0], 202);
    await writeFile(gate, "open");
    for (let i = 0; i < 100; i++) {
      if ((await refresh("r0"))[0] === 200) break;
      if (i === 99) assert.fail("shared source did not finish");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await writeFile(gate, "open");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("POST refresh never acknowledges an old cached result after failure", async () => {
  const item = widget("bad-refresh");
  item.source = { command: [process.execPath, "-e", "process.exit(1)"], timeoutSec: 1 };
  await save(item);
  assert.deepEqual(await post("/api/widgets/bad-refresh/actions/refresh"), [502, { error: "Widget source failed" }]);
});

test("while an action is in progress, GET and refresh cannot expose old cached state", async () => {
  const gate = join(home, "action-gate"), begun = join(home, "action-begun");
  const item = widget("action-race");
  item.source = { command: [process.execPath, "-e", "console.log(JSON.stringify({blocks:[{type:'stat',value:'cached'}]}))"], timeoutSec: 5 };
  item.actions.push({ id: "slow", label: "Slow", symbol: "checkmark", command: [process.execPath, "-e", `
    const fs=require('node:fs'); fs.writeFileSync(process.argv[1], 'started');
    const t=setInterval(()=>{if(fs.existsSync(process.argv[2])) clearInterval(t)},10);
  `, begun, gate] });
  await save(item);
  assert.equal((await get("/api/widgets/action-race"))[1].blocks[0].value, "cached");
  const running = post("/api/widgets/action-race/actions/slow");
  for (let i = 0; i < 200; i++) {
    try { if (await readFile(begun, "utf8")) break; } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (i === 199) assert.fail("action did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await get("/api/widgets/action-race"))[0], 502);
  assert.equal((await post("/api/widgets/action-race/actions/refresh"))[0], 502);
  await writeFile(gate, "done");
  assert.equal((await running)[0], 200);
  assert.equal((await get("/api/widgets/action-race"))[0], 200);
});

test("definition metadata is reread, source changes invalidate cache, invalid and duplicate files stay hidden", async () => {
  const next = widget("fixture");
  next.title = "Changed";
  next.source.command = [process.execPath, "-e", "console.log(JSON.stringify({blocks:[{type:'stat',label:'new',value:'new'}]}))"];
  await save(next);
  const [, body] = await get("/api/widgets/fixture");
  assert.equal(body.title, "Changed");
  assert.equal(body.blocks[0].value, "new");
  await save(next, "duplicate");
  assert.equal((await get("/api/widgets/fixture"))[0], 404);
  await rm(join(home, "widgets", "duplicate.json"));
  await writeFile(join(home, "widgets", "bad.json"), "{");
  assert.equal((await get("/api/widgets"))[1].widgets.some((v) => v.id === "fixture"), true);
});

test("refresh updates the render after a previously slow source", async () => {
  const gate = join(home, "gate");
  const gateScript = `
  const fs=require('node:fs'), gate=process.argv[1], counter=process.argv[2];
  const n=fs.existsSync(counter)?fs.readFileSync(counter,'utf8').length+1:1;
  fs.appendFileSync(counter,'x');
  if(n === 1) { const t=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(t); console.log(JSON.stringify({blocks:[{type:'stat',value:'old'}]}));}},10); }
  else console.log(JSON.stringify({blocks:[{type:'stat',value:'new'}]}));`;
  const counter2 = join(home, "counter2");
  const item = widget("race");
  item.source = { command: [process.execPath, "-e", gateScript, gate, counter2], timeoutSec: 5 };
  await save(item);
  const first = get("/api/widgets/race");
  // Synchronize on source startup, not on elapsed time.
  const waitStart = async () => {
    for (let i = 0; i < 200; i++) {
      try { if (await readFile(counter2, "utf8")) return; } catch (e) { if (e.code !== "ENOENT") throw e; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("source did not start");
  };
  await waitStart();
  const second = get("/api/widgets/race");
  await writeFile(gate, "open");
  assert.equal((await first)[1].blocks[0].value, "old");
  await second;
  const beforeRefresh = await readFile(counter2, "utf8");
  assert.equal((await post("/api/widgets/race/actions/refresh"))[0], 200);
  assert.equal((await get("/api/widgets/race"))[1].blocks[0].value, "new");
  assert.equal(await readFile(counter2, "utf8"), beforeRefresh + "x");
});
