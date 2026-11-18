// OpenAI-compatible HTTP front on 127.0.0.1. Each request is cap-checked,
// SIWX-signed and forwarded to Venice; a 402 for low credit triggers one capped
// x402 top-up and one retry. Logs amounts and token counts, never content.
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { CapError, actualCost, estimateAndClamp } from './caps.mjs';
import { FALLBACK_MODELS } from './config.mjs';
import { builtinEgressCheck } from './egress.mjs';

const MAX_BODY = 32 * 1024 * 1024;
// Cloudflare/origin hiccups worth another try; anything else goes back to the client as-is.
const RETRY_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// "fetch failed" alone says nothing; the cause (ECONNRESET, UND_ERR_SOCKET...) does.
export const describeError = (e) => {
  const c = e?.cause;
  const cause = c ? c.code || c.message || String(c) : '';
  return String(e?.message ?? e) + (cause && cause !== e?.message ? ` (${cause})` : '');
};

export function createProxy({ cfg, venice, ledger, clientToken, log = () => {}, egressCheck = defaultEgressCheck(cfg, log) }) {
  const prices = structuredClone(FALLBACK_MODELS);
  let active = 0;
  const waiters = [];
  const acquire = () => (active < cfg.maxConcurrent ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
  const releaseSlot = () => {
    const next = waiters.shift();
    if (next) next();
    else active--;
  };

  // Live prices only ever raise our estimate.
  async function refreshPrices() {
    try {
      const list = await venice.publicModels();
      for (const m of list) {
        const p = prices[m.id];
        const lp = m.model_spec?.pricing;
        if (!p || !lp) continue;
        const inp = Number(lp.input?.usd) / 1e6;
        const out = Number(lp.output?.usd) / 1e6;
        if (inp > p.input) p.input = inp;
        if (out > p.output) p.output = out;
        const ctx = Number(m.model_spec?.availableContextTokens);
        if (ctx > 0) p.context = ctx;
      }
      log({ event: 'prices', models: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { inPerM: v.input * 1e6, outPerM: v.output * 1e6 }])) });
    } catch (e) {
      log({ event: 'prices_failed', error: String(e.message).slice(0, 200) });
    }
  }

  const send = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };
  const err = (res, status, code, message) => send(res, status, { error: { type: 'venice_x402', code, message } });

  const authorized = (req) => {
    const h = String(req.headers.authorization || '');
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    const want = Buffer.from(clientToken);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  async function readBody(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY) throw new CapError('too_large', 'request body too large');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function forward(body, signal) {
    return venice.authed('/chat/completions', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // Waits (up to egressWaitMs) for the Mullvad egress gate instead of failing
  // at once: a tunnel failover takes minutes, a client retry takes seconds.
  async function egressReady(signal) {
    const deadline = Date.now() + (cfg.egressWaitMs ?? 0);
    let waited = false;
    for (;;) {
      if (await egressCheck()) {
        if (waited) log({ event: 'egress_recovered' });
        return true;
      }
      if (signal?.aborted || Date.now() >= deadline) return false;
      waited = true;
      await sleep(Math.min(cfg.egressPollMs ?? 5000, Math.max(0, deadline - Date.now())));
    }
  }

  // Sends once, then retries connection failures and 5xx gateway errors. Only
  // used before any byte has gone to the client, so a retry is invisible to it.
  async function forwardWithRetry(body, signal) {
    const attempts = Math.max(1, cfg.upstreamAttempts ?? 1);
    for (let attempt = 1; ; attempt++) {
      let up = null;
      let error = null;
      try {
        up = await forward(body, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        error = e;
      }
      if (up && !RETRY_STATUS.has(up.status)) return up;
      if (attempt >= attempts) {
        if (up) return up;
        throw error;
      }
      const why = up ? `status ${up.status}` : describeError(error);
      if (up) await up.body?.cancel().catch(() => {});
      log({ event: 'upstream_retry', attempt, why });
      egressCheck.reset?.(); // the tunnel may have just dropped: re-verify before resending
      await sleep((cfg.retryDelayMs ?? 0) * attempt);
      if (signal?.aborted) throw error ?? new Error('client closed');
      if (!(await egressReady(signal))) {
        const e = new Error('Venice egress via Mullvad could not be verified after an upstream failure; request not resent');
        e.code = 'egress_unverified';
        throw e;
      }
    }
  }

  async function chat(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return err(res, 400, e.code || 'bad_request', e.message);
    }
    const price = prices[body.model];
    if (!price) return err(res, 400, 'model_not_allowed', `model ${body.model} is not enabled on this proxy (${cfg.models.join(', ')})`);
    // Aborts the upstream call (and any wait) when the client goes away.
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    if (!(await egressReady(ac.signal))) {
      if (ac.signal.aborted) return;
      log({ event: 'egress_refused', waitedMs: cfg.egressWaitMs ?? 0 });
      return err(res, 503, 'egress_unverified', 'Venice egress via Mullvad could not be verified; request not sent');
    }

    let est;
    let slot;
    try {
      est = estimateAndClamp(body, price, cfg.maxRequestUsd);
      slot = ledger.reserve(est.estUsd);
    } catch (e) {
      if (e instanceof CapError) {
        ledger.record({ kind: 'reject', code: e.code, model: body.model });
        log({ event: 'reject', code: e.code, message: e.message });
        return err(res, 429, e.code, e.message);
      }
      throw e;
    }
    // Strip reasoning-effort knobs the model does not accept (OpenCode sends its variant).
    if (price.reasoningEffort === false) {
      delete body.reasoning_effort;
      delete body.reasoning;
    }
    if (body.stream) body.stream_options = { ...(body.stream_options || {}), include_usage: true };

    await acquire();
    const started = Date.now();
    let usage = null;
    let status = 0;
    let requestId = null;
    try {
      let up = await forwardWithRetry(body, ac.signal);
      if (up.status === 402 && cfg.autoTopUp) {
        const info = await up.json().catch(() => ({}));
        if (info.reason === 'insufficient_balance' || info.code === 'PAYMENT_REQUIRED') {
          try {
            await venice.topUp('insufficient_balance');
          } catch (e) {
            log({ event: 'topup_failed', error: String(e.message).slice(0, 300) });
            return err(res, 402, e.code || 'topup_failed', `Venice credit is low and top-up failed: ${e.message}`);
          }
          up = await forwardWithRetry(body, ac.signal);
        } else {
          return err(res, 402, 'payment_required', String(info.error || 'Venice returned 402').slice(0, 300));
        }
      }
      status = up.status;
      if (!up.ok) {
        const text = await up.text();
        log({ event: 'upstream_error', status, body: text.slice(0, 300) });
        res.writeHead(status, { 'content-type': up.headers.get('content-type') || 'application/json' });
        return res.end(text);
      }
      if (!body.stream) {
        const json = await up.json();
        usage = json.usage;
        requestId = json.id;
        return send(res, 200, json);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of up.body) {
        res.write(chunk);
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.usage) usage = j.usage;
            if (j.id) requestId = j.id;
          } catch {}
        }
      }
      res.end();
    } catch (e) {
      if (ac.signal.aborted) {
        log({ event: 'client_closed', streamed: res.headersSent });
      } else {
        log({ event: 'proxy_error', error: describeError(e).slice(0, 300), streamed: res.headersSent });
        if (!res.headersSent) {
          if (e.code === 'egress_unverified') err(res, 503, 'egress_unverified', e.message);
          else err(res, 502, 'upstream_failed', describeError(e));
        } else res.end();
      }
    } finally {
      releaseSlot();
      ledger.release(slot);
      if (status === 200 || usage) {
        const c = actualCost(usage, price);
        const entry = ledger.record({
          kind: 'charge',
          model: body.model,
          requestId,
          stream: !!body.stream,
          estUsd: est.estUsd,
          maxOutTokens: est.outTokens,
          clamped: est.clamped,
          // No usage reported (stream cut): book the worst case.
          ...(c ?? { costUsd: est.estUsd, usageMissing: true }),
          ms: Date.now() - started,
        });
        log({ event: 'charge', model: body.model, costUsd: entry.costUsd, estUsd: est.estUsd, promptTokens: entry.promptTokens, completionTokens: entry.completionTokens, day: ledger.snapshot() });
      }
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://x').pathname.replace(/^\/v1/, '');
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, address: venice.account.address, day: ledger.snapshot() });
      if (!authorized(req)) return err(res, 401, 'unauthorized', 'missing or wrong bearer token');
      if (req.method === 'GET' && path === '/models') {
        return send(res, 200, {
          object: 'list',
          data: cfg.models.map((id) => ({ id, object: 'model', owned_by: 'venice', context_length: prices[id].context })),
        });
      }
      if (req.method === 'POST' && path === '/chat/completions') return await chat(req, res);
      return err(res, 404, 'not_found', `${req.method} ${path} is not served by venice-x402`);
    } catch (e) {
      log({ event: 'handler_error', error: String(e.message).slice(0, 300) });
      if (!res.headersSent) err(res, 500, 'internal', 'internal error');
    }
  });
  return { server, refreshPrices, prices };
}

// Async (no event-loop stall for streams in flight); concurrent callers share one run.
// Failures are logged with the check's own reason (VENICE_EGRESS_VERBOSE=1).
// reset() drops a cached success, e.g. after an upstream connection failure.
// cfg.egressCheck 'builtin' runs the checks in this process (no spawn); any
// other value is a shell command that must exit 0.
export function defaultEgressCheck(cfg, log = () => {}, { builtin = builtinEgressCheck({ statePath: cfg.mullvadState }) } = {}) {
  let okUntil = 0;
  let running = null;
  const runBuiltin = async () => {
    const r = await builtin();
    if (!r.ok) log({ event: 'egress_failed', reason: r.reason });
    return r.ok;
  };
  const run = () =>
    cfg.egressCheck === 'builtin' ? runBuiltin() : new Promise((resolve) => {
      const p = spawn('/bin/zsh', ['-c', cfg.egressCheck], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VENICE_EGRESS_VERBOSE: '1' },
      });
      let out = '';
      const take = (d) => (out = (out + d).slice(-2000));
      p.stdout.on('data', take);
      p.stderr.on('data', take);
      const t = setTimeout(() => p.kill('SIGKILL'), 30_000);
      const done = (ok, why) => {
        clearTimeout(t);
        if (!ok) log({ event: 'egress_failed', reason: why || out.trim().split('\n').filter((l) => /FAIL/.test(l)).join('; ').slice(0, 300) || out.trim().slice(-300) });
        resolve(ok);
      };
      p.on('error', (e) => done(false, `spawn: ${e.message}`));
      p.on('close', (code, sig) => done(code === 0, sig ? `killed ${sig}` : undefined));
    });
  const check = async () => {
    if (!cfg.egressCheck) return true;
    if (Date.now() < okUntil) return true;
    running ??= run().finally(() => (running = null));
    const ok = await running;
    if (ok) okUntil = Date.now() + cfg.egressCheckTtlMs;
    return ok;
  };
  check.reset = () => {
    okUntil = 0;
  };
  return check;
}
