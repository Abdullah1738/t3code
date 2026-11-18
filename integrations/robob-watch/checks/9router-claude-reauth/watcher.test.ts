import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalize, shouldPause } from '../../src/lib.ts';

for (const name of ['watcher.json', 'watcher-definition.json']) {
  test(`${name} validates and keeps checking after sustained failures`, () => {
    const watcher = normalize(JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')));
    expect(watcher.max_consecutive_failures).toBe(0);
    expect(watcher.timeout_s).toBe(90);
    expect(shouldPause(watcher, { status: 'active', fires: 0, consecutive_failures: 120, failure_alerted: true }, false)).toBe(false);
  });
}
