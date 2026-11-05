import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

const ID = /^[a-z0-9-]{1,40}$/;
const CACHE_MS = 60_000;
const DEFAULT_TIMEOUT = 20;
const MAX_TIMEOUT = 60;
const MAX_OUTPUT = 1024 * 1024;
const RESPONSE_BUDGET_MS = 8_000;
const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const MAX_IDEMPOTENCY_KEYS = 1000;
const PENDING = Symbol("pending");
const UNKNOWN_KEY = { ok: false, error: "unknown_key", replayable: false, message: "Not run again: the server has no record of this action. Check its effect before tapping again." };

function command(value) {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === "string" && value[0].length > 0 && value.every((arg) => typeof arg === "string");
}

function definition(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !ID.test(value.id) || typeof value.title !== "string" || !value.title ||
      !Array.isArray(value.families) || !value.families.length || !value.families.every((v) => typeof v === "string" && v) ||
      !Number.isFinite(value.refreshMinutes) || value.refreshMinutes <= 0 || !command(value.source?.command)) {
    throw new Error("invalid widget definition");
  }
  const seconds = value.source.timeoutSec ?? DEFAULT_TIMEOUT;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("invalid timeout");
  const actions = value.actions ?? [];
  if (!Array.isArray(actions)) throw new Error("invalid actions");
  const ids = new Set();
  for (const action of actions) {
    if (!action || typeof action.id !== "string" || !ID.test(action.id) || ids.has(action.id) || typeof action.label !== "string" || !action.label ||
        typeof action.symbol !== "string" || !action.symbol ||
        (action.id === "refresh" ? action.command !== undefined : !command(action.command))) {
      throw new Error("invalid action");
    }
    ids.add(action.id);
  }
  return { ...value, actions, timeoutMs: Math.min(seconds, MAX_TIMEOUT) * 1000 };
}

// A broken or partially written file must not hide unrelated widgets. Duplicate
// ids are omitted rather than choosing which definition may execute commands.
async function definitions(home) {
  let names;
  try {
    names = await readdir(join(home, "widgets"));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  const found = new Map();
  const duplicates = new Set();
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const item = definition(JSON.parse(await readFile(join(home, "widgets", name), "utf8")));
      if (found.has(item.id)) duplicates.add(item.id);
      else found.set(item.id, item);
    } catch {
      // Definition writers can replace a file while requests are in flight.
    }
  }
  for (const id of duplicates) found.delete(id);
  return found;
}

function publicActions(item) {
  return item.actions.map(({ id, label, symbol }) => ({ id, label, symbol }));
}

function run(argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(argv[0], argv.slice(1), { encoding: "utf8", maxBuffer: MAX_OUTPUT, detached: true }, (error, stdout) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(stdout);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Kill the process group as sources may spawn children that inherit pipes.
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      reject(new Error("command timed out"));
    }, timeoutMs);
    timer.unref();
  });
}

function send(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store" });
  res.end(bytes);
}

function requestPath(req) {
  // Avoid URL's dot-segment normalisation before validating an id.
  return (req.url ?? "/").split("?", 1)[0].split("/").slice(1).map((segment) => decodeURIComponent(segment));
}

function withinBudget(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(PENDING), Math.max(0, ms));
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export function createHandler({ home = process.env.ROBOB_WIDGETS_HOME || join(homedir(), ".local/share/robob-widgets"), now = () => Date.now(), responseBudgetMs = Number(process.env.ROBOB_WIDGETS_RESPONSE_BUDGET_MS ?? RESPONSE_BUDGET_MS) } = {}) {
  if (!Number.isFinite(responseBudgetMs) || responseBudgetMs <= 0) throw new Error("Invalid response budget");
  const states = new Map();
  const idempotency = new Map();
  const stateFor = (id) => {
    if (!states.has(id)) states.set(id, { generation: 0, cache: null, pending: null, actions: 0 });
    return states.get(id);
  };

  function model(item, data, isStale = false) {
    return { id: item.id, title: item.title, asOf: data.asOf, refreshMinutes: item.refreshMinutes, blocks: data.blocks, actions: publicActions(item), ...(isStale ? { stale: true } : {}) };
  }

  async function source(item, state, sourceKey) {
    for (;;) {
      if (state.actions) throw new Error("action in progress");
      let pending = state.pending;
      if (!pending) {
        pending = { sourceKey, generation: state.generation, promise: null };
        pending.promise = (async () => {
          try {
            const parsed = JSON.parse(await run(item.source.command, item.timeoutMs));
            if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.blocks)) throw new Error("source must return blocks");
            const time = now();
            const entry = { blocks: parsed.blocks, asOf: new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z"), fetchedAt: time, sourceKey };
            if (state.generation === pending.generation) state.cache = entry;
            return entry;
          } finally {
            if (state.pending === pending) state.pending = null;
          }
        })();
        state.pending = pending;
      }
      try {
        const data = await pending.promise;
        if (pending.sourceKey === sourceKey && pending.generation === state.generation) return data;
      } catch (error) {
        if (pending.sourceKey === sourceKey && pending.generation === state.generation) throw error;
      }
      // A source invalidated while running must finish before its successor starts.
    }
  }

  async function render(item, { force = false, stale = true } = {}) {
    const state = stateFor(item.id);
    if (state.actions) throw new Error("action in progress");
    const sourceKey = JSON.stringify([item.source.command, item.timeoutMs]);
    if (force && state.cache) state.cache.fetchedAt = -Infinity;
    if (!force && state.cache?.sourceKey === sourceKey && now() - state.cache.fetchedAt < CACHE_MS && now() >= state.cache.fetchedAt) {
      return model(item, state.cache);
    }
    try {
      return model(item, await source(item, state, sourceKey));
    } catch (error) {
      if (!stale || !state.cache || state.actions) throw error;
      return model(item, state.cache, true);
    }
  }

  function sweepKeys() {
    for (const [key, entry] of idempotency) {
      if (entry.state === "done" && entry.expiresAt <= now()) idempotency.delete(key);
    }
  }

  function reserveKey(key, execute) {
    sweepKeys();
    const existing = idempotency.get(key);
    if (existing) return existing.promise;
    if (idempotency.size >= MAX_IDEMPOTENCY_KEYS) {
      for (const [oldKey, entry] of idempotency) {
        if (entry.state === "done") { idempotency.delete(oldKey); break; }
      }
    }
    if (idempotency.size >= MAX_IDEMPOTENCY_KEYS) return null;
    const entry = { state: "running", promise: null, expiresAt: null };
    // Register before starting the command so two concurrent requests attach.
    entry.promise = Promise.resolve().then(execute).catch(() => ({ status: 500, body: { error: "Widget server error" } })).then((result) => {
      entry.state = "done";
      entry.result = result;
      entry.expiresAt = now() + IDEMPOTENCY_TTL_MS;
      // Map order is completion order, so the oldest completed result is evicted first.
      idempotency.delete(key);
      idempotency.set(key, entry);
      return result;
    });
    idempotency.set(key, entry);
    return entry.promise;
  }

  async function actionResult(item, actionId, action) {
    if (actionId === "refresh") {
      try { await render(item, { force: true, stale: false }); return { status: 200, body: { ok: true, message: "Refreshed" } }; }
      catch { return { status: 502, body: { error: "Widget source failed" } }; }
    }
    const state = stateFor(item.id);
    state.generation++;
    state.actions++;
    if (state.cache) state.cache.fetchedAt = -Infinity;
    try {
      await run(action.command, item.timeoutMs);
      return { status: 200, body: { ok: true, message: "Action completed" } };
    } catch {
      return { status: 502, body: { error: "Widget action failed" } };
    } finally {
      state.actions--;
      state.generation++;
      if (state.cache) state.cache.fetchedAt = -Infinity;
    }
  }

  return async (req, res) => {
    const started = performance.now();
    res.on("finish", () => {
      // Query strings and command output can contain private data.
      const path = (req.url ?? "/").split("?", 1)[0];
      process.stderr.write(`${JSON.stringify(req.method)} ${JSON.stringify(path)} ${res.statusCode} ${Math.round(performance.now() - started)}ms\n`);
    });
    try {
      let path;
      try { path = requestPath(req); } catch { return send(res, 400, { error: "Invalid path" }); }
      if (path[0] !== "api" || path[1] !== "widgets") return send(res, 404, { error: "Not found" });
      if (path.length === 2) {
        if (req.method !== "GET") return send(res, 405, { error: "Method not allowed" });
        const items = await definitions(home);
        return send(res, 200, { widgets: [...items.values()].map(({ id, title, families, refreshMinutes }) => ({ id, title, families, refreshMinutes })) });
      }
      if (!ID.test(path[2] ?? "")) return send(res, 400, { error: "Invalid widget id" });
      const isAction = path.length === 5 && path[3] === "actions";
      if (isAction && !ID.test(path[4])) return send(res, 400, { error: "Invalid action id" });
      if (path.length !== 3 && !isAction) return send(res, 404, { error: "Not found" });
      if ((isAction && req.method !== "POST") || (!isAction && req.method !== "GET")) return send(res, 405, { error: "Method not allowed" });
      // Native WidgetKit requests have no Origin; a web page on another origin
      // must not be able to trigger local command actions via a form or fetch.
      if (isAction && req.headers.origin && req.headers.origin !== "https://widgets.tail") return send(res, 403, { error: "Origin not allowed" });
      const remaining = () => Math.max(0, responseBudgetMs - (performance.now() - started));
      const headerCount = (name) => req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
      if (isAction && headerCount("idempotency-key") > 1) return send(res, 400, { error: "Invalid Idempotency-Key" });
      if (isAction && headerCount("idempotency-replay") > 1) return send(res, 400, { error: "Invalid Idempotency-Replay" });
      const idempotencyKey = isAction ? req.headers["idempotency-key"] : undefined;
      const replay = isAction ? req.headers["idempotency-replay"] : undefined;
      if (replay !== undefined && replay !== "1") return send(res, 400, { error: "Invalid Idempotency-Replay" });
      if (replay === "1" && idempotencyKey === undefined) return send(res, 400, { error: "Idempotency-Replay needs Idempotency-Key" });
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length > 200 || /[^\x20-\x7e]/.test(idempotencyKey))) {
        return send(res, 400, { error: "Invalid Idempotency-Key" });
      }
      const scopedKey = idempotencyKey === undefined ? null : JSON.stringify([path[2], path[4], idempotencyKey]);
      // Replay a previously accepted operation even if its definition has since changed.
      if (scopedKey !== null) {
        sweepKeys();
        const existing = idempotency.get(scopedKey);
        if (existing) {
          const result = await withinBudget(existing.promise, remaining());
          return result === PENDING ? send(res, 202, { ok: true, pending: true, message: "Still running" }) : send(res, result.status, result.body);
        }
        if (replay === "1") return send(res, 409, UNKNOWN_KEY);
      }
      const items = await withinBudget(definitions(home), remaining());
      if (items === PENDING) return send(res, 503, { error: "Widget definitions unavailable" });
      const item = items.get(path[2]);
      if (!item) return send(res, 404, { error: "Widget not found" });
      if (!isAction) {
        try {
          const result = await withinBudget(render(item), remaining());
          if (result !== PENDING) return send(res, 200, result);
          const state = stateFor(item.id);
          if (state.cache && !state.actions) return send(res, 200, model(item, state.cache, true));
          return send(res, 503, { error: "source still running" });
        }
        catch { return send(res, 502, { error: "Widget source failed" }); }
      }
      const action = item.actions.find((entry) => entry.id === path[4]);
      if (!action && path[4] !== "refresh") return send(res, 404, { error: "Action not found" });
      const execute = () => actionResult(item, path[4], action);
      const promise = scopedKey === null ? execute() : reserveKey(scopedKey, execute);
      if (!promise) return send(res, 503, { error: "busy" });
      const result = await withinBudget(promise, remaining());
      return result === PENDING ? send(res, 202, { ok: true, pending: true, message: "Still running" }) : send(res, result.status, result.body);
    } catch {
      return send(res, 500, { error: "Widget server error" });
    }
  };
}

export function startServer({ port = process.env.ROBOB_WIDGETS_PORT ?? 8495, home } = {}) {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error("Invalid ROBOB_WIDGETS_PORT");
  const server = createServer(createHandler({ home }));
  server.listen(number, "127.0.0.1");
  return server;
}
