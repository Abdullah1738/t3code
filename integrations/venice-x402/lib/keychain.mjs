// Reads the wallet key from the macOS login Keychain. The key stays in this
// process's memory only; it is never logged, written or returned to callers.
import { spawnSync } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';

export function loadAccount({ keychainService, keychainAccount }) {
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', keychainService, '-a', keychainAccount, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) throw new Error(`keychain item ${keychainService}/${keychainAccount} not readable (exit ${r.status})`);
  const pk = r.stdout.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('keychain item is not a 32-byte hex key');
  return privateKeyToAccount(pk);
}
