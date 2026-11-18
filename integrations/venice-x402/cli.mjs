#!/usr/bin/env node
// venice-x402: local OpenAI-compatible proxy that pays Venice via x402.
//
//   cli.mjs serve                 run the proxy (LaunchAgent entry point)
//   cli.mjs address               print the wallet's public address
//   cli.mjs wallet                on-chain USDC / ETH balance on Base (no Venice call)
//   cli.mjs status                local spend today + Venice credit balance (calls Venice)
//   cli.mjs transactions [n]      Venice ledger for this wallet (calls Venice)
//   cli.mjs topup [usd]           one capped top-up now (calls Venice, moves USDC)
import { readFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { Ledger } from './lib/caps.mjs';
import { BASE_USDC, loadConfig } from './lib/config.mjs';
import { loadAccount } from './lib/keychain.mjs';
import { createProxy, defaultEgressCheck } from './lib/server.mjs';
import { Venice } from './lib/venice.mjs';

const cfg = loadConfig();
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
const [cmd = 'help', ...args] = process.argv.slice(2);

function deps() {
  const account = loadAccount(cfg);
  const ledger = new Ledger(cfg);
  const venice = new Venice({ cfg, account, ledger, log });
  return { account, ledger, venice };
}

const egressOk = defaultEgressCheck(cfg, log);

async function needEgress() {
  if (!(await egressOk())) {
    console.error('refusing: Venice egress via Mullvad not verified (VENICE_X402_EGRESS_CHECK failed)');
    process.exit(4);
  }
}

switch (cmd) {
  case 'serve': {
    const { venice, ledger, account } = deps();
    const clientToken = readFileSync(cfg.clientTokenFile, 'utf8').trim();
    if (clientToken.length < 32) throw new Error('client token too short');
    const { server, refreshPrices } = createProxy({ cfg, venice, ledger, clientToken, log });
    server.listen(cfg.port, cfg.host, () =>
      log({ event: 'listening', url: `http://${cfg.host}:${cfg.port}/v1`, address: account.address, caps: { maxRequestUsd: cfg.maxRequestUsd, maxDailyUsd: cfg.maxDailyUsd, topUpUsd: cfg.topUpUsd, maxTopUpDailyUsd: cfg.maxTopUpDailyUsd, autoTopUp: cfg.autoTopUp }, egressCheck: !!cfg.egressCheck }),
    );
    if (await egressOk()) await refreshPrices();
    setInterval(async () => (await egressOk()) && refreshPrices(), 6 * 3600 * 1000).unref();
    break;
  }
  case 'address':
    console.log(loadAccount(cfg).address);
    break;
  case 'wallet': {
    const { address } = loadAccount(cfg);
    const pc = createPublicClient({ chain: base, transport: http(cfg.baseRpc) });
    const [usdc, eth] = await Promise.all([
      pc.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
      pc.getBalance({ address }),
    ]);
    console.log(JSON.stringify({ address, network: 'base', usdc: formatUnits(usdc, 6), eth: formatUnits(eth, 18) }));
    break;
  }
  case 'status': {
    await needEgress();
    const { venice, ledger, account } = deps();
    const bal = await venice.balance();
    console.log(JSON.stringify({ address: account.address, venice: bal, today: ledger.snapshot() }, null, 2));
    break;
  }
  case 'transactions': {
    await needEgress();
    const { venice } = deps();
    console.log(JSON.stringify(await venice.transactions(Number(args[0] || 10)), null, 2));
    break;
  }
  case 'topup': {
    await needEgress();
    const { venice } = deps();
    const usd = Number(args[0] || cfg.topUpUsd);
    console.log(JSON.stringify(await venice.topUp('manual', { amountUsd: usd, force: true }), null, 2));
    break;
  }
  default:
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).join('\n'));
}
