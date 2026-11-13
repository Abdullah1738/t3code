import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createHandler } from "../lib/server.mjs";

const UNKNOWN = {
  ok: false,
  error: "unknown_key",
  replayable: false,
  message: "Not run again: the server has no record of this action. Check its effect before tapping again.",
};
const PENDING = { ok: true, pending: true, message: "Still running" };

// The gate keeps the process alive until the test explicitly releases it.
const CHILD = `
const fs = require('node:fs');
const [starts, finishes, gate, kind, code] = process.argv.slice(2);
fs.appendFileSync(starts, 'x');
let done = false;
function finish(exitCode) {
  if (done) return;
  done = true;
  fs.appendFileSync(finishes, 'x');
  if (kind === 'source' && exitCode === 0) {
    process.stdout.write(JSON.stringify({blocks: []}), () => process.exit(exitCode));
  } else process.exit(exitCode);
}
setTimeout(() => finish(97), 5000).unref();
if (fs.existsSync(gate)) {
  const timer = setInterval(() => {
    if (!fs.existsSync(gate)) { clearInterval(timer); finish(Number(code)); }
  }, 5);
} else finish(Number(code));
`;

async function until(description, predicate, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await delay(10);
  } while (Date.now() < end);
  assert.fail(`Timed out waiting for ${description}`);
}

async function harness(t) {
  const home = await mkdtemp(join(tmpdir(), "robob-widgets-replay-"));
  await mkdir(join(home, "widgets"));
  const script = join(home, "fixture.cjs");
  await writeFile(script, CHILD);
  const fixtures = [];
  let server;
  let base;
  const observers = new Set();

  async function start() {
    const handler = createHandler({ home, responseBudgetMs: 250 });
    server = createServer((req, res) => {
      handler(req, res);
      for (const observer of observers) {
        if (observer.predicate(req)) {
          observers.delete(observer);
          observer.resolve();
        }
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }

  async function stop() {
    const running = server;
    server = null;
    if (running) await new Promise((resolve, reject) => running.close((error) => error ? reject(error) : resolve()));
  }

  t.after(async () => {
    await Promise.all(fixtures.map(({ gate }) => rm(gate, { force: true })));
    await stop();
    try {
      await until("fixture processes to finish", async () => {
        const counts = await Promise.all(fixtures.map(async ({ starts, finishes }) => [
          (await readFile(starts, "utf8")).length,
          (await readFile(finishes, "utf8")).length,
        ]));
        return counts.every(([started, finished]) => started === finished);
      }, 6000);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  async function fixture(name, { blocked = false, kind = "action", code = 0 } = {}) {
    const starts = join(home, `${name}.starts`);
    const finishes = join(home, `${name}.finishes`);
    const gate = join(home, `${name}.gate`);
    await Promise.all([writeFile(starts, ""), writeFile(finishes, "")]);
    if (blocked) await writeFile(gate, "closed");
    const child = {
      starts, finishes, gate,
      command: [process.execPath, script, starts, finishes, gate, kind, String(code)],
      count: async () => (await readFile(starts, "utf8")).length,
      waitForStart: () => until(`${name} to start`, async () => (await readFile(starts, "utf8")).length > 0),
      waitForFinish: () => until(`${name} to finish`, async () => (await readFile(finishes, "utf8")).length > 0),
      release: () => rm(gate, { force: true }),
    };
    fixtures.push(child);
    return child;
  }

  async function save(id, source, actions) {
    await writeFile(join(home, "widgets", `${id}.json`), JSON.stringify({
      id, title: id, families: ["systemSmall"], refreshMinutes: 15,
      source: { command: source.command, timeoutSec: 10 },
      actions: actions.map(([actionId, child]) => ({ id: actionId, label: actionId, symbol: "checkmark", command: child.command })),
    }));
  }

  function post(id, action, headers = []) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${base}/api/widgets/${id}/actions/${action}`, {
        method: "POST", headers: ["Host", new URL(base).host, ...headers, "Connection", "close"],
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, text, body: JSON.parse(text) }); }
          catch (error) { reject(error); }
        });
        res.on("error", reject);
      });
      req.setTimeout(4000, () => req.destroy(new Error("HTTP request timed out")));
      req.on("error", reject);
      req.end();
    });
  }

  function waitForReplay() {
    return new Promise((resolve) => observers.add({
      predicate: (req) => req.headers["idempotency-replay"] === "1",
      resolve,
    }));
  }

  await start();
  return { home, fixture, save, post, waitForReplay, restart: async () => { await stop(); await start(); } };
}

const key = (value) => ["Idempotency-Key", value];
const replay = (value) => [...key(value), "Idempotency-Replay", "1"];

async function completeFirstTap(h, widget, action, value) {
  let result = await h.post(widget, action, key(value));
  const deadline = Date.now() + 6000;
  while (result.status === 202 && Date.now() < deadline) {
    assert.deepEqual(result.body, PENDING);
    result = await h.post(widget, action, replay(value));
  }
  return result;
}

test("running replay waits for the budget, then can return the final result inside the next budget", async (t) => {
  const h = await harness(t);
  const source = await h.fixture("source", { kind: "source" });
  const action = await h.fixture("action", { blocked: true });
  await h.save("alpha", source, [["change", action]]);

  const first = h.post("alpha", "change", key("tap"));
  await action.waitForStart();
  const retry = h.post("alpha", "change", replay("tap"));
  const [pending, pendingReplay] = await Promise.all([first, retry]);
  assert.equal(pending.status, 202);
  assert.deepEqual(pending.body, PENDING);
  assert.equal(pendingReplay.status, 202);
  assert.deepEqual(pendingReplay.body, PENDING);
  assert.equal(await action.count(), 1);

  const observed = h.waitForReplay();
  const waitingReplay = h.post("alpha", "change", replay("tap"));
  await observed;
  await action.release();
  const completed = await waitingReplay;
  assert.equal(completed.status, 200, completed.text);
  assert.deepEqual(completed.body, { ok: true, message: "Action completed" });
  assert.deepEqual(await h.post("alpha", "change", replay("tap")), completed);
  assert.equal(await action.count(), 1);
  assert.equal(await source.count(), 0);
});

test("done replay preserves success and failure status and body, even if the definition disappears", async (t) => {
  const h = await harness(t);
  const source = await h.fixture("source", { kind: "source" });
  const success = await h.fixture("success");
  const failure = await h.fixture("failure", { code: 7 });
  await h.save("alpha", source, [["ok", success], ["fail", failure]]);

  const ok = await completeFirstTap(h, "alpha", "ok", "one");
  const failed = await completeFirstTap(h, "alpha", "fail", "two");
  assert.equal(ok.status, 200, ok.text);
  assert.equal(failed.status, 502, failed.text);
  await rm(join(h.home, "widgets", "alpha.json"));
  assert.deepEqual(await h.post("alpha", "ok", replay("one")), ok);
  assert.deepEqual(await h.post("alpha", "fail", replay("two")), failed);
  assert.equal(await success.count(), 1);
  assert.equal(await failure.count(), 1);
  assert.equal(await source.count(), 0);
});

test("unknown keys, widgets, and actions return the exact 409 without launching anything", async (t) => {
  const h = await harness(t);
  const source = await h.fixture("source", { kind: "source" });
  const action = await h.fixture("action");
  await h.save("alpha", source, [["change", action]]);

  for (const [widget, name, value] of [
    ["alpha", "change", "never-seen"],
    ["missing", "change", "never-seen"],
    ["alpha", "missing", "never-seen"],
    ["alpha", "refresh", "never-seen"],
  ]) {
    const result = await h.post(widget, name, replay(value));
    assert.equal(result.status, 409, result.text);
    assert.deepEqual(result.body, UNKNOWN);
  }
  assert.equal(await action.count(), 0);
  assert.equal(await source.count(), 0);

  // A missing replay must not reserve its key or prevent a later first tap.
  assert.equal((await completeFirstTap(h, "alpha", "change", "never-seen")).status, 200);
  assert.equal(await action.count(), 1);
  for (const [widget, name] of [["missing", "change"], ["alpha", "missing"], ["alpha", "refresh"]]) {
    const result = await h.post(widget, name, replay("never-seen"));
    assert.equal(result.status, 409, result.text);
    assert.deepEqual(result.body, UNKNOWN);
  }
  assert.equal(await action.count(), 1);
  assert.equal(await source.count(), 0);
});

test("a fresh server on the same home does not re-execute a replay after restart", async (t) => {
  const h = await harness(t);
  const source = await h.fixture("source", { kind: "source" });
  const action = await h.fixture("action");
  await h.save("alpha", source, [["change", action]]);
  assert.equal((await completeFirstTap(h, "alpha", "change", "before-restart")).status, 200);
  assert.equal(await action.count(), 1);

  await h.restart();
  const result = await h.post("alpha", "change", replay("before-restart"));
  assert.equal(result.status, 409, result.text);
  assert.deepEqual(result.body, UNKNOWN);
  assert.equal(await action.count(), 1);
  assert.equal(await source.count(), 0);
});

test("replay header requires a key and malformed or duplicate headers never execute", async (t) => {
  const h = await harness(t);
  const source = await h.fixture("source", { kind: "source" });
  const action = await h.fixture("action");
  await h.save("alpha", source, [["change", action]]);

  const withoutKey = await h.post("alpha", "change", ["Idempotency-Replay", "1"]);
  assert.equal(withoutKey.status, 400);
  assert.deepEqual(withoutKey.body, { error: "Idempotency-Replay needs Idempotency-Key" });
  for (const value of ["", "0", "true", "01", "1, 1"]) {
    const result = await h.post("alpha", "change", [...key("tap"), "Idempotency-Replay", value]);
    assert.equal(result.status, 400, `replay value ${JSON.stringify(value)}: ${result.text}`);
    assert.deepEqual(result.body, { error: "Invalid Idempotency-Replay" });
  }
  for (const headers of [
    [...replay("tap"), "idempotency-replay", "1"],
    [...replay("tap"), "idempotency-replay", "0"],
  ]) {
    const result = await h.post("alpha", "change", headers);
    assert.equal(result.status, 400, result.text);
    assert.deepEqual(result.body, { error: "Invalid Idempotency-Replay" });
  }
  const duplicateKey = await h.post("alpha", "change", [...replay("tap"), "idempotency-key", "tap"]);
  assert.equal(duplicateKey.status, 400);
  assert.deepEqual(duplicateKey.body, { error: "Invalid Idempotency-Key" });
  const badKey = await h.post("alpha", "change", replay("x".repeat(201)));
  assert.equal(badKey.status, 400);
  assert.deepEqual(badKey.body, { error: "Invalid Idempotency-Key" });
  assert.equal(await action.count(), 0);
  assert.equal(await source.count(), 0);
});
