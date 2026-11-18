// In-process Mullvad egress check: the same three checks as bin/egress-check,
// without spawning zsh, dscacheutil, python3 and curl. On 16 Nov 2026 the Mac
// ran at load ~150 after a reboot and the spawned script could not finish in
// 30 s, so a healthy tunnel was reported as unverified and requests were
// refused. This version needs one DNS lookup per host, one file read and one
// HTTPS request.
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';

const FAKE = /^198\.1[89]\./; // sing-box fake-IP range 198.18.0.0/15
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms).unref?.())]);

export function builtinEgressCheck({
  statePath = '/usr/local/var/venice-mullvad/state.json',
  hosts = ['venice.ai', 'api.venice.ai'],
  traceUrl = 'https://venice.ai/cdn-cgi/trace',
  maxHealthAgeMs = 15 * 60 * 1000,
  timeoutMs = 20_000,
  lookup = (h) => dnsLookup(h, { family: 4 }),
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  // Returns { ok, reason }. Order matters: DNS first, so nothing is sent to
  // Venice unless its names resolve into the tunnel.
  return async () => {
    try {
      for (const h of hosts) {
        const { address } = await withTimeout(lookup(h), timeoutMs, `DNS ${h}`);
        if (!FAKE.test(address || '')) return { ok: false, reason: `FAIL ${h} resolves to '${address || 'nothing'}', not the tunnel range` };
      }
      let st;
      try {
        st = JSON.parse(await readFile(statePath, 'utf8'));
      } catch (e) {
        return { ok: false, reason: `FAIL no tunnel state at ${statePath} (${e.code || e.message})` };
      }
      const fresh = st.healthy && now() - Number(st.healthy_at || 0) * 1000 < maxHealthAgeMs && st.exit_ip;
      if (!fresh) return { ok: false, reason: 'FAIL tunnel not healthy (or health older than 15 min)' };
      const r = await fetchImpl(traceUrl, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const seen = (await r.text()).match(/^ip=(.+)$/m)?.[1]?.trim() || '';
      if (seen !== st.exit_ip) return { ok: false, reason: `FAIL Venice sees '${seen || 'nothing'}', Mullvad exit is ${st.exit_ip}` };
      return { ok: true };
    } catch (e) {
      const c = e?.cause;
      return { ok: false, reason: `FAIL ${e.message}${c ? ` (${c.code || c.message})` : ''}`.slice(0, 300) };
    }
  };
}
