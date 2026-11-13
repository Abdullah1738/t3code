import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createHandler } from "../lib/server.mjs";

// Every child records both ends of its lifetime and has its own safety deadline.
// A gate keeps the child in flight until the test explicitly removes it.
const CHILD = `
const fs = require('node:fs');
const [kind, starts, finishes, gate, data, writeValue, exitCode] = process.argv.slice(2);
fs.appendFileSync(starts, 'x');
const value = kind === 'source' ? fs.readFileSync(data, 'utf8') : '';
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  fs.appendFileSync(finishes, 'x');
  process.exit(code);
}
function complete() {
  if (kind === 'source') {
    process.stdout.write(JSON.stringify({blocks:[{type:'stat',label:'value',value}]}), () => finish(Number(exitCode)));
  } else {
    if (writeValue !== '--no-write--') fs.writeFileSync(data, writeValue);
    finish(Number(exitCode));
  }
}
setTimeout(() => finish(97), 4500).unref();
if (fs.existsSync(gate)) {
  const interval = setInterval(() => {
    if (!fs.existsSync(gate)) { clearInterval(interval); complete(); }
  }, 5);
} else complete();
`;

async function until(description, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}`);
}

async function harness(t) {
  const home = await mkdtemp(join(tmpdir(), "robob-widgets-round2-"));
  await mkdir(join(home, "widgets"));
  const script = join(home, "fixture.cjs");
  await writeFile(script, CHILD);
  const children = [];
  let clock = Date.parse("2026-11-04T15:20:00Z");
  const server = createServer(createHandler({ home, now: () => clock, responseBudgetMs: 100 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await Promise.all(children.map(({ gate }) => rm(gate, { force: true })));
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
    try {
      await until("fixture children to finish", async () => {
        const counts = await Promise.all(children.map(async ({ starts, finishes }) => [
          (await readFile(starts, "utf8")).length,
          (await readFile(finishes, "utf8")).length,
        ]));
        return counts.every(([started, finished]) => started === finished);
      }, 5000);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  async function child(name, { kind, data, blocked = false, writeValue = "--no-write--", exitCode = 0 }) {
    const starts = join(home, `${name}.starts`);
    const finishes = join(home, `${name}.finishes`);
    const gate = join(home, `${name}.gate`);
    await Promise.all([writeFile(starts, ""), writeFile(finishes, "")]);
    if (blocked) await writeFile(gate, "closed");
    const fixture = {
      starts, finishes, gate,
      command: [process.execPath, script, kind, starts, finishes, gate, data, writeValue, String(exitCode)],
      count: async () => (await readFile(starts, "utf8")).length,
      waitForStarts: (n) => until(`${name} to start ${n} time(s)`, async () => (await readFile(starts, "utf8")).length >= n),
      waitForFinishes: (n) => until(`${name} to finish ${n} time(s)`, async () => (await readFile(finishes, "utf8")).length >= n),
      open: () => rm(gate, { force: true }),
      close: () => writeFile(gate, "closed"),
    };
    children.push(fixture);
    return fixture;
  }

  async function save(id, source, actions = [], { defaultTimeout = false } = {}) {
    const item = {
      id, title: id, families: ["systemSmall"], refreshMinutes: 15,
      source: { command: source.command, ...(defaultTimeout ? {} : { timeoutSec: 5 }) },
      actions: [
        { id: "refresh", label: "Refresh", symbol: "arrow.clockwise" },
        ...actions.map(({ id: actionId, fixture }) => ({ id: actionId, label: actionId, symbol: "checkmark", command: fixture.command })),
      ],
    };
    await writeFile(join(home, "widgets", `${id}.json`), JSON.stringify(item));
  }

  async function request(path, { method = "GET", key } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(key === undefined ? {} : { headers: { "Idempotency-Key": key } }),
      signal: AbortSignal.timeout(3000),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  }
  const get = (id) => request(`/api/widgets/${id}`);
  const post = (id, action, key) => request(`/api/widgets/${id}/actions/${action}`, { method: "POST", key });
  const terminal = (id, action, key) => until("the stored action result", async () => {
    const result = await post(id, action, key);
    return result.status === 202 ? false : result;
  });
  const fresh = (id) => until("a fresh widget render", async () => {
    const result = await get(id);
    if (result.status === 503 || (result.status === 200 && result.body.stale)) return false;
    assert.equal(result.status, 200, result.text);
    return result.body;
  });

  return { home, child, save, get, post, terminal, fresh, advance: (ms) => { clock += ms; } };
}

test("a pending keyed action is shared and its final response is replayed without invalidating the new cache", async (t) => {
  const h = await harness(t);
  const data = join(h.home, "data");
  await writeFile(data, "before");
  const source = await h.child("source", { kind: "source", data });
  const action = await h.child("action", { kind: "action", data, blocked: true, writeValue: "after" });
  await h.save("alpha", source, [{ id: "change", fixture: action }]);
  assert.equal((await h.fresh("alpha")).blocks[0].value, "before");
  assert.equal(await source.count(), 1);

  const first = h.post("alpha", "change", "same-key");
  await action.waitForStarts(1);
  const duplicate = h.post("alpha", "change", "same-key");
  const [pending1, pending2] = await Promise.all([first, duplicate]);
  assert.equal(pending1.status, 202);
  assert.equal(pending2.status, 202);

  // An in-flight reservation must not expire just because the injected clock advances.
  h.advance(366 * 24 * 60 * 60 * 1000);
  assert.equal((await h.post("alpha", "change", "same-key")).status, 202);
  assert.equal(await action.count(), 1);
  await action.open();
  await action.waitForFinishes(1);
  const completed = await h.terminal("alpha", "change", "same-key");
  assert.equal(completed.status, 200, completed.text);
  assert.deepEqual(await h.post("alpha", "change", "same-key"), completed);
  assert.equal((await h.fresh("alpha")).blocks[0].value, "after");
  assert.equal(await source.count(), 2);
  assert.deepEqual(await h.post("alpha", "change", "same-key"), completed);
  assert.equal((await h.get("alpha")).body.blocks[0].value, "after");
  assert.equal(await source.count(), 2);
  assert.equal(await action.count(), 1);
});

test("a failed keyed action replays the same failure instead of executing again", async (t) => {
  const h = await harness(t);
  const data = join(h.home, "data");
  await writeFile(data, "value");
  const source = await h.child("source", { kind: "source", data });
  const action = await h.child("failure", { kind: "action", data, blocked: true, exitCode: 7 });
  await h.save("failure", source, [{ id: "fail", fixture: action }]);

  const first = h.post("failure", "fail", "failure-key");
  await action.waitForStarts(1);
  const duplicate = h.post("failure", "fail", "failure-key");
  assert.equal((await first).status, 202);
  assert.equal((await duplicate).status, 202);
  await action.open();
  await action.waitForFinishes(1);
  const completed = await h.terminal("failure", "fail", "failure-key");
  assert.equal(completed.status, 502, completed.text);
  assert.deepEqual(await h.post("failure", "fail", "failure-key"), completed);
  assert.equal(await action.count(), 1);
});

test("keys are scoped to widget, action, and key; unkeyed requests each execute", async (t) => {
  const h = await harness(t);
  const data = join(h.home, "data");
  await writeFile(data, "value");
  const source = await h.child("source", { kind: "source", data });
  const alphaOne = await h.child("alpha-one", { kind: "action", data });
  const alphaTwo = await h.child("alpha-two", { kind: "action", data });
  const betaOne = await h.child("beta-one", { kind: "action", data });
  const unkeyed = await h.child("unkeyed", { kind: "action", data, blocked: true });
  await h.save("alpha", source, [
    { id: "one", fixture: alphaOne }, { id: "two", fixture: alphaTwo }, { id: "unkeyed", fixture: unkeyed },
  ]);
  await h.save("beta", source, [{ id: "one", fixture: betaOne }]);

  async function finish(id, action, key) {
    let result = await h.post(id, action, key);
    if (result.status === 202) result = await h.terminal(id, action, key);
    assert.equal(result.status, 200, result.text);
  }
  await finish("alpha", "one", "key-a");
  await finish("alpha", "one", "key-a");
  await finish("alpha", "one", "key-b");
  await finish("alpha", "two", "key-a");
  await finish("beta", "one", "key-a");
  assert.equal(await alphaOne.count(), 2);
  assert.equal(await alphaTwo.count(), 1);
  assert.equal(await betaOne.count(), 1);

  const first = h.post("alpha", "unkeyed");
  await unkeyed.waitForStarts(1);
  const second = h.post("alpha", "unkeyed");
  await unkeyed.waitForStarts(2);
  assert.equal((await first).status, 202);
  assert.equal((await second).status, 202);
  await unkeyed.open();
  await unkeyed.waitForFinishes(2);
  assert.equal(await unkeyed.count(), 2);
});

test("invalid idempotency keys are rejected before execution, while 200 printable characters work", async (t) => {
  const h = await harness(t);
  const data = join(h.home, "data");
  await writeFile(data, "value");
  const source = await h.child("source", { kind: "source", data });
  const action = await h.child("action", { kind: "action", data });
  await h.save("alpha", source, [{ id: "do-it", fixture: action }]);

  assert.equal((await h.post("alpha", "do-it", "x".repeat(201))).status, 400);
  // Horizontal tab is legal in the HTTP field value but is not printable.
  assert.equal((await h.post("alpha", "do-it", "a\tb")).status, 400);
  assert.equal(await action.count(), 0);
  const key = "x".repeat(200);
  let accepted = await h.post("alpha", "do-it", key);
  if (accepted.status === 202) accepted = await h.terminal("alpha", "do-it", key);
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual(await h.post("alpha", "do-it", key), accepted);
  assert.equal(await action.count(), 1);
});

test("cold GETs and refresh actions share one slow source and fill the cache after 503/202", async (t) => {
  const h = await harness(t);
  const data = join(h.home, "data");
  await writeFile(data, "cold-value");
  const source = await h.child("source", { kind: "source", data, blocked: true });
  await h.save("cold", source);

  const first = h.get("cold");
  await source.waitForStarts(1);
  const responses = await Promise.all([
    first, h.get("cold"), h.get("cold"), h.post("cold", "refresh", "refresh-a"), h.post("cold", "refresh", "refresh-b"),
  ]);
  assert.deepEqual(responses.map((r) => r.status), [503, 503, 503, 202, 202]);
  assert.equal((await h.get("cold")).status, 503);
  assert.equal((await h.post("cold", "refresh", "refresh-a")).status, 202);
  assert.equal(await source.count(), 1);

  await source.open();
  await source.waitForFinishes(1);
  const refreshA = await h.terminal("cold", "refresh", "refresh-a");
  const refreshB = await h.terminal("cold", "refresh", "refresh-b");
  assert.equal(refreshA.status, 200, refreshA.text);
  assert.equal(refreshB.status, 200, refreshB.text);
  assert.equal((await h.fresh("cold")).blocks[0].value, "cold-value");
  assert.deepEqual(await h.post("cold", "refresh", "refresh-a"), refreshA);
  assert.equal((await h.get("cold")).body.blocks[0].value, "cold-value");
  assert.equal(await source.count(), 1);
});

test("warm stale data retains asOf while GET and refresh share one slow revalidation", async (t) => {
  const h = await harness(t);
  const data = join(h.home, "data");
  await writeFile(data, "old");
  const source = await h.child("source", { kind: "source", data });
  await h.save("warm", source);
  const original = await h.fresh("warm");
  assert.equal(original.blocks[0].value, "old");
  assert.equal(await source.count(), 1);

  await source.close();
  await writeFile(data, "new");
  h.advance(60_001);
  const first = h.get("warm");
  await source.waitForStarts(2);
  const [stale1, stale2, refresh] = await Promise.all([first, h.get("warm"), h.post("warm", "refresh", "warm-refresh")]);
  for (const stale of [stale1, stale2]) {
    assert.equal(stale.status, 200, stale.text);
    assert.equal(stale.body.stale, true);
    assert.equal(stale.body.asOf, original.asOf);
    assert.equal(stale.body.blocks[0].value, "old");
  }
  assert.equal(refresh.status, 202);
  assert.equal((await h.post("warm", "refresh", "warm-refresh")).status, 202);
  assert.equal(await source.count(), 2);

  await source.open();
  await source.waitForFinishes(2);
  const completed = await h.terminal("warm", "refresh", "warm-refresh");
  assert.equal(completed.status, 200, completed.text);
  const updated = await h.fresh("warm");
  assert.equal(updated.blocks[0].value, "new");
  assert.notEqual(updated.asOf, original.asOf);
  assert.equal(updated.stale, undefined);
  assert.deepEqual(await h.post("warm", "refresh", "warm-refresh"), completed);
  assert.equal(await source.count(), 2);
});

test("the default process timeout cannot extend the HTTP response budget", async (t) => {
  const h = await harness(t);
  const data = join(h.home, "data");
  await writeFile(data, "value");
  const source = await h.child("source", { kind: "source", data, blocked: true });
  const action = await h.child("action", { kind: "action", data, blocked: true });
  // This definition intentionally omits timeoutSec to exercise the real default;
  // the fixture itself has a safety deadline below five seconds.
  await h.save("defaults", source, [{ id: "slow", fixture: action }], { defaultTimeout: true });

  const started = Date.now();
  const cold = h.get("defaults");
  await source.waitForStarts(1);
  assert.equal((await cold).status, 503);
  assert.ok(Date.now() - started < 2000, "cold GET exceeded the 100ms response budget by too much");
  await source.open();
  assert.equal((await h.fresh("defaults")).blocks[0].value, "value");

  const actionStarted = Date.now();
  const pending = h.post("defaults", "slow", "default-timeout");
  await action.waitForStarts(1);
  assert.equal((await pending).status, 202);
  assert.ok(Date.now() - actionStarted < 2000, "action exceeded the 100ms response budget by too much");
  await action.open();
  assert.equal((await h.terminal("defaults", "slow", "default-timeout")).status, 200);
  assert.equal(await source.count(), 1);
  assert.equal(await action.count(), 1);
});
