// Spend caps and the append-only ledger. The ledger records amounts, token
// counts and ids only: never prompts, completions, headers or keys.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class CapError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Worst-case cost estimate. Input tokens are over-estimated as bytes/3 of the
// whole request body (messages + tools). Output is clamped so input + output
// fits the per-request cap; the clamp is written back into the body.
export function estimateAndClamp(body, price, maxRequestUsd) {
  const bytes = Buffer.byteLength(JSON.stringify(body.messages ?? []) + JSON.stringify(body.tools ?? []), 'utf8');
  const inTokens = Math.ceil(bytes / 3);
  const inCost = inTokens * price.input;
  if (inCost >= maxRequestUsd) {
    throw new CapError('request_cap', `input (~${inTokens} tokens, ~$${inCost.toFixed(4)}) exceeds the per-request cap $${maxRequestUsd}`);
  }
  const field = body.max_completion_tokens !== undefined ? 'max_completion_tokens' : body.max_tokens !== undefined ? 'max_tokens' : 'max_completion_tokens';
  const requested = Number(body[field] ?? price.maxOutput);
  const room = Math.floor((maxRequestUsd - inCost) / price.output);
  const out = Math.min(requested > 0 ? requested : price.maxOutput, room, price.maxOutput);
  if (out < 256) {
    throw new CapError('request_cap', `only ${out} output tokens fit the per-request cap $${maxRequestUsd} after ~${inTokens} input tokens`);
  }
  const clamped = out < requested;
  body[field] = out;
  return { inTokens, outTokens: out, estUsd: round6(inCost + out * price.output), clamped, field };
}

export function actualCost(usage, price) {
  if (!usage) return null;
  const prompt = Number(usage.prompt_tokens ?? 0);
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  return {
    promptTokens: prompt,
    cachedTokens: cached,
    completionTokens: completion,
    costUsd: round6((prompt - cached) * price.input + cached * (price.cachedInput ?? price.input) + completion * price.output),
  };
}

export class Ledger {
  constructor({ ledgerFile, timeZone, maxDailyUsd, maxTopUpDailyUsd, maxTopUpPerPaymentUsd, now = () => new Date() }) {
    Object.assign(this, { ledgerFile, timeZone, maxDailyUsd, maxTopUpDailyUsd, maxTopUpPerPaymentUsd, now });
    this.reserved = new Map();
    this.seq = 0;
    this.totals = { day: dayKey(now(), timeZone), spent: 0, toppedUp: 0, requests: 0 };
    mkdirSync(dirname(ledgerFile), { recursive: true });
    this.#load();
  }

  #load() {
    if (!existsSync(this.ledgerFile)) return;
    for (const line of readFileSync(this.ledgerFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        this.#apply(JSON.parse(line));
      } catch {
        /* skip a torn line */
      }
    }
  }

  #roll() {
    const d = dayKey(this.now(), this.timeZone);
    if (d !== this.totals.day) this.totals = { day: d, spent: 0, toppedUp: 0, requests: 0 };
  }

  #apply(e) {
    this.#roll();
    if (e.day !== this.totals.day) return;
    if (e.kind === 'charge') {
      this.totals.spent = round6(this.totals.spent + (e.costUsd ?? 0));
      this.totals.requests += 1;
    }
    // A top-up counts against the daily cap from the moment it is signed;
    // only a definite "not transferred" result gives it back.
    if (e.kind === 'topup_signed') this.totals.toppedUp = round6(this.totals.toppedUp + e.amountUsd);
    if (e.kind === 'topup_released') this.totals.toppedUp = round6(this.totals.toppedUp - e.amountUsd);
  }

  record(entry) {
    const e = { ts: this.now().toISOString(), day: dayKey(this.now(), this.timeZone), ...entry };
    appendFileSync(this.ledgerFile, JSON.stringify(e) + '\n', { mode: 0o600 });
    this.#apply(e);
    return e;
  }

  reservedTotal() {
    let s = 0;
    for (const v of this.reserved.values()) s += v;
    return s;
  }

  reserve(estUsd) {
    this.#roll();
    const projected = this.totals.spent + this.reservedTotal() + estUsd;
    if (projected > this.maxDailyUsd) {
      throw new CapError('daily_cap', `daily cap $${this.maxDailyUsd} reached (spent $${this.totals.spent.toFixed(4)}, in flight $${this.reservedTotal().toFixed(4)}, this request up to $${estUsd.toFixed(4)})`);
    }
    const id = ++this.seq;
    this.reserved.set(id, estUsd);
    return id;
  }

  release(id) {
    this.reserved.delete(id);
  }

  checkTopUp(amountUsd) {
    this.#roll();
    if (amountUsd > this.maxTopUpPerPaymentUsd) throw new CapError('topup_cap', `top-up $${amountUsd} exceeds per-payment cap $${this.maxTopUpPerPaymentUsd}`);
    if (this.totals.toppedUp + amountUsd > this.maxTopUpDailyUsd) {
      throw new CapError('topup_daily_cap', `daily top-up cap $${this.maxTopUpDailyUsd} reached (already $${this.totals.toppedUp})`);
    }
  }

  snapshot() {
    this.#roll();
    return { ...this.totals, inFlightUsd: round6(this.reservedTotal()), maxDailyUsd: this.maxDailyUsd, maxTopUpDailyUsd: this.maxTopUpDailyUsd };
  }
}
