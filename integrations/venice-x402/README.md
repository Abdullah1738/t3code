# venice-x402

Local OpenAI-compatible proxy that pays Venice AI per request over
[x402](https://docs.venice.ai/guides/integrations/x402-venice-api), with no
Venice account or API key. Robob uses it through OpenCode as
`venice-x402/abliteration-abliterated-model-large-v2`.

Owner request, 15 Nov 2026: x402 access to Venice "Abliterated Large v2" via
OpenCode, funded from a dedicated wallet, sent through his Mullvad split tunnel.

## How Venice x402 works

- **Credit, then sign-in.** `POST /x402/top-up` returns a 402 with Base and
  Solana USDC rails. The proxy signs an EIP-3009 `transferWithAuthorization` on
  Base (gasless; Venice's facilitator settles it), and Venice credits the
  wallet. The minimum top-up is $5. Each inference call then carries a fresh
  `SIGN-IN-WITH-X` header (EIP-4361 SIWE message on Base, signed EIP-191,
  single use, valid 5 min), and Venice debits the credit after serving.
- Venice serves a call only while the credit is at least $0.10, with at most
  5 concurrent requests per wallet.
- USDC sent straight to Venice's address is **not** credited. Only a signed
  x402 top-up counts.

## Pieces

| What | Where |
| --- | --- |
| Source | this dir (fork `integrations/venice-x402`) |
| Live copy | `~/.local/share/venice-x402` (`install.zsh`) |
| LaunchAgent | `com.ardud.venice-x402`, `http://127.0.0.1:43402/v1` |
| Wallet key | login Keychain `venice-x402-wallet` / `ardud`. Read at start, kept in memory only, never logged |
| Wallet address | `0x1E1328736C2758d3b3CF329FcE3f1F0f4A467c6B` (Base; fund with native USDC) |
| Local client token | `~/.config/venice-x402/client-token` (0600). Bearer token OpenCode sends; other local processes can't spend |
| Ledger | `~/.local/share/venice-x402/data/ledger.jsonl`: amounts, token counts, ids. No prompts or content |
| Log | `~/Library/Logs/venice-x402.log` |
| OpenCode | `~/.config/opencode/opencode.jsonc` → `provider."venice-x402"`. Don't name it `venice`: that id is OpenCode's built-in catalog and pulls in ~160 models |

## Spend caps (env in the plist)

| Env | Default | Meaning |
| --- | --- | --- |
| `VENICE_X402_MAX_REQUEST_USD` | unlimited | `unlimited`, `none` or `0` = no per-request limit (owner, 15 Nov 2026); a number caps the Worst-case cost per request. Input is over-estimated as body bytes/3 plus 2,000 tokens for the prompt Venice adds itself. `max_completion_tokens` is clamped to fit, and oversized requests get a 429 |
| `VENICE_X402_MAX_DAILY_USD` | 1000 | Booked cost plus in-flight worst cases per Asia/Dubai day |
| `VENICE_X402_TOPUP_USD` | 5 | Auto top-up size (Venice minimum is $5) |
| `VENICE_X402_MAX_TOPUP_USD` | 5 | Per top-up payment |
| `VENICE_X402_MAX_TOPUP_DAILY_USD` | 1000 | USDC moved into Venice credit per day. A signed top-up counts from the moment it is signed; it is released only on a definite failure (400 / `SETTLEMENT_FAILED`) |
| `VENICE_X402_AUTO_TOPUP` | 1 | 0 = never top up by itself (402s go back to the client) |
| `VENICE_X402_PAYTO_ALLOW` | Venice's documented Base receiver | Top-ups to any other `payTo` are refused |

A top-up runs only from a Venice 402 `insufficient_balance` and is serialised.
It re-checks the balance first, takes rails only from `https://api.venice.ai`,
and accepts only the `exact` scheme, Base, native USDC and an allowed `payTo`.
An ambiguous outcome is never retried.

## Mullvad egress gate

`bin/egress-check` must exit 0 before anything is sent to Venice (cached
5 min). It needs `venice.ai` and `api.venice.ai` to resolve into the
venice-mullvad tunnel's fake range (198.18.0.0/15), the tunnel daemon to
report healthy, and Cloudflare's `venice.ai/cdn-cgi/trace` IP to equal the
tunnel's Mullvad exit IP. While the check fails the request is held and the
check re-run every 5 s for up to 5 min (`VENICE_X402_EGRESS_WAIT_S`), because a
tunnel failover after a blocked transport takes 2-4 min. Only then is it
refused with 503 `egress_unverified`. Each failure is logged as `egress_failed`
with the check's reason. Tunnel: `~/Documents/assistant/venice-mullvad`. Run
`bin/egress-check -v` to see why it fails.

## Resilience (16 Nov 2026)

The proxy kept dropping when the Mullvad tunnel failed over: UAE networks cut
WireGuard-over-UDP after 20-30 min and the daemon needed minutes to move to
another transport. Requests failed at once (`egress_unverified`, `fetch failed`).

- Connection failures and 502/503/504/52x from Venice are retried before any
  byte reaches the client (5 attempts, `VENICE_X402_UPSTREAM_ATTEMPTS`), with a
  growing delay and a fresh egress check (and wait) before each resend.
  A resend after a reset may be billed twice by Venice (cents per request).
- A client that disconnects aborts the upstream call (`client_closed`).
- Logged causes: `upstream_retry`, `egress_failed`, `egress_recovered`,
  `proxy_error` (with the socket cause, e.g. `fetch failed (ECONNRESET)`).
- `com.ardud.venice-x402-guard` (every 60 s, `bin/venice-ensure`) re-bootstraps
  or kickstarts the proxy when nothing listens on the port. `install.zsh`
  installs both agents.

## Commands

```bash
node ~/.local/share/venice-x402/cli.mjs address        # public address
node ~/.local/share/venice-x402/cli.mjs wallet         # on-chain USDC/ETH on Base (no Venice call)
node ~/.local/share/venice-x402/cli.mjs status         # Venice credit + today's spend (egress-gated)
node ~/.local/share/venice-x402/cli.mjs transactions   # Venice ledger (egress-gated)
node ~/.local/share/venice-x402/cli.mjs topup 5        # manual capped top-up (moves USDC)
zsh integrations/venice-x402/install.zsh [--check]     # deploy / drift check
```

## Dependencies

Pinned exactly, each at least 7 days old (the `~/.npmrc` `min-release-age=7`
policy was not overridden): `viem` 2.57.16, `@x402/core` and `@x402/evm`
2.30.0 (Coinbase). `npm audit`: 0 vulnerabilities at install. Tests:
`npm test` (node:test, mocked Venice, throwaway key).
