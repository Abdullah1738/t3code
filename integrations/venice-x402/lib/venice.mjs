// Venice x402 client: SIWX-authenticated calls, balance, and capped USDC
// top-ups over x402 (EIP-3009 transferWithAuthorization on Base; gasless).
import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { BASE_NETWORK, BASE_USDC } from './config.mjs';
import { CapError } from './caps.mjs';
import { siwxHeader } from './siwx.mjs';

export class Venice {
  constructor({ cfg, account, ledger, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { cfg, account, ledger, fetch: fetchImpl, log });
    this.topUpLock = Promise.resolve();
  }

  url(path) {
    return `${this.cfg.apiBase}${path}`;
  }

  async authed(path, init = {}) {
    const url = this.url(path);
    const { header } = await siwxHeader(this.account, url);
    return this.fetch(url, { ...init, redirect: 'error', headers: { ...(init.headers || {}), 'SIGN-IN-WITH-X': header } });
  }

  async balance() {
    const r = await this.authed(`/x402/balance/${this.account.address}`);
    const text = await r.text();
    if (!r.ok) throw new Error(`balance ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).data;
  }

  async transactions(limit = 10) {
    const r = await this.authed(`/x402/transactions/${this.account.address}?limit=${limit}&offset=0`);
    const text = await r.text();
    if (!r.ok) throw new Error(`transactions ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).data;
  }

  async publicModels() {
    const r = await this.fetch(this.url('/models?type=text'), { redirect: 'error' });
    if (!r.ok) throw new Error(`models ${r.status}`);
    return (await r.json()).data ?? [];
  }

  // Serialised so concurrent 402s produce at most one top-up.
  topUp(reason, { amountUsd = this.cfg.topUpUsd, force = false } = {}) {
    const run = this.topUpLock.then(() => this.#topUp(reason, amountUsd, force));
    this.topUpLock = run.catch(() => {});
    return run;
  }

  async #topUp(reason, amountUsd, force) {
    if (!force) {
      const bal = await this.balance().catch(() => null);
      if (bal?.canConsume) return { skipped: true, balanceUsd: bal.balanceUsd };
    }
    // Discovery: requirements come only from api.venice.ai over HTTPS.
    const topUpUrl = this.url('/x402/top-up');
    if (!topUpUrl.startsWith('https://api.venice.ai/')) throw new Error('refusing top-up: api base is not https://api.venice.ai');
    const disc = await this.fetch(topUpUrl, { method: 'POST', redirect: 'error' });
    if (disc.status !== 402) throw new Error(`top-up discovery expected 402, got ${disc.status}`);
    const discBody = await disc.json().catch(() => ({}));

    const pick = (reqs) =>
      reqs.filter(
        (r) =>
          r.scheme === 'exact' &&
          (r.network === BASE_NETWORK || r.network === 'base') &&
          String(r.asset).toLowerCase() === BASE_USDC &&
          this.cfg.payToAllow.includes(String(r.payTo).toLowerCase()),
      );

    const core = x402Client.fromConfig({
      schemes: [{ network: BASE_NETWORK, client: new ExactEvmScheme(this.account) }],
      spendControls: { maxAmountPerPayment: `$${this.cfg.maxTopUpPerPaymentUsd}` },
      policies: [(_v, reqs) => pick(reqs)],
    });
    const http = new x402HTTPClient(core);
    const required = http.getPaymentRequiredResponse((n) => disc.headers.get(n), discBody);
    const rails = pick(required.accepts ?? []);
    if (rails.length === 0) throw new Error('no acceptable Base USDC rail to an allowed payTo in Venice 402 response; refusing to pay');
    const rail = rails[0];
    const minUnits = BigInt(rail.amount);
    let units = BigInt(Math.round(amountUsd * 1e6));
    if (units < minUnits) units = minUnits;
    const usd = Number(units) / 1e6;
    this.ledger.checkTopUp(usd); // throws CapError

    rail.amount = units.toString();
    required.accepts = [rail];
    const payload = await http.createPaymentPayload(required);
    const headers = http.encodePaymentSignatureHeader(payload);

    this.ledger.record({ kind: 'topup_signed', amountUsd: usd, reason, payTo: rail.payTo, network: rail.network });
    this.log({ event: 'topup_signed', amountUsd: usd, reason });
    let r;
    try {
      r = await this.fetch(topUpUrl, { method: 'POST', redirect: 'error', headers });
    } catch (e) {
      this.ledger.record({ kind: 'topup_unknown', amountUsd: usd, error: String(e.message).slice(0, 200) });
      throw new Error(`top-up send failed; outcome unknown, not retrying: ${e.message}`);
    }
    const text = await r.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {}
    if (r.ok && body.success) {
      let settle = null;
      try {
        settle = http.getPaymentSettleResponse((n) => r.headers.get(n));
      } catch {}
      const e = this.ledger.record({
        kind: 'topup_ok',
        amountUsd: body.data?.amountCredited ?? usd,
        newBalanceUsd: body.data?.newBalance,
        paymentId: body.data?.paymentId,
        tx: settle?.transaction,
      });
      this.log({ event: 'topup_ok', amountUsd: e.amountUsd, newBalanceUsd: e.newBalanceUsd, tx: e.tx });
      return { ok: true, ...e };
    }
    const code = body.error || body.code || '';
    // Definitely not transferred: validation errors (400) and SETTLEMENT_FAILED.
    const definite = r.status === 400 || code === 'SETTLEMENT_FAILED';
    this.ledger.record({ kind: definite ? 'topup_released' : 'topup_unknown', amountUsd: usd, status: r.status, code });
    throw new Error(`top-up failed ${r.status} ${code}${definite ? '' : ' (outcome unknown; check balance before retrying)'}`);
  }
}

export { CapError };
