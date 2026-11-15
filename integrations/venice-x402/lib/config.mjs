// Runtime configuration. Everything comes from the environment (set in the
// LaunchAgent plist) with conservative defaults. No secrets live here: the
// wallet key is read from the login Keychain at start (lib/keychain.mjs).
import { homedir } from 'node:os';
import { join } from 'node:path';

const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad numeric config value: ${v}`);
  return n;
};

// Fallback prices (USD per token) used when the live /models catalog is not
// reachable. Live prices win only when they are higher (we never under-estimate).
export const FALLBACK_MODELS = {
  'abliteration-abliterated-model-large-v2': {
    name: 'Abliterated Large V2 (Venice x402)',
    input: 3 / 1e6,
    cachedInput: 0.3 / 1e6,
    output: 5 / 1e6,
    context: 1_000_000,
    maxOutput: 32_768,
    // Venice: supportsReasoning true, supportsReasoningEffort false (always reasons).
    reasoningEffort: false,
  },
};

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_NETWORK = 'eip155:8453';

export function loadConfig(env = process.env) {
  const home = env.HOME || homedir();
  const dataDir = env.VENICE_X402_DATA_DIR || join(home, '.local/share/venice-x402/data');
  return {
    host: '127.0.0.1',
    port: num(env.VENICE_X402_PORT, 43402),
    apiBase: (env.VENICE_X402_API_BASE || 'https://api.venice.ai/api/v1').replace(/\/$/, ''),
    keychainService: env.VENICE_X402_KEYCHAIN_SERVICE || 'venice-x402-wallet',
    keychainAccount: env.VENICE_X402_KEYCHAIN_ACCOUNT || 'ardud',
    clientTokenFile: env.VENICE_X402_CLIENT_TOKEN_FILE || join(home, '.config/venice-x402/client-token'),
    dataDir,
    ledgerFile: join(dataDir, 'ledger.jsonl'),
    timeZone: env.VENICE_X402_TZ || 'Asia/Dubai',
    // Spend caps (USD).
    maxRequestUsd: num(env.VENICE_X402_MAX_REQUEST_USD, 0.5),
    maxDailyUsd: num(env.VENICE_X402_MAX_DAILY_USD, 1000),
    // Top-ups move USDC from the wallet into Venice credit. Venice minimum is $5.
    autoTopUp: (env.VENICE_X402_AUTO_TOPUP ?? '1') !== '0',
    topUpUsd: num(env.VENICE_X402_TOPUP_USD, 5),
    maxTopUpPerPaymentUsd: num(env.VENICE_X402_MAX_TOPUP_USD, 5),
    maxTopUpDailyUsd: num(env.VENICE_X402_MAX_TOPUP_DAILY_USD, 1000),
    // Venice's documented Base receiver. Top-ups to any other payTo are refused.
    payToAllow: (env.VENICE_X402_PAYTO_ALLOW || '0x2670B922ef37C7Df47158725C0CC407b5382293F')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    models: Object.keys(FALLBACK_MODELS),
    // Command that must exit 0 before any request leaves for Venice (Mullvad
    // egress check). Cached for egressCheckTtlMs. Empty = no check.
    egressCheck: env.VENICE_X402_EGRESS_CHECK || '',
    egressCheckTtlMs: num(env.VENICE_X402_EGRESS_CHECK_TTL_S, 300) * 1000,
    maxConcurrent: num(env.VENICE_X402_MAX_CONCURRENT, 4),
    baseRpc: env.VENICE_X402_BASE_RPC || 'https://mainnet.base.org',
  };
}
