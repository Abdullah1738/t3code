import assert from 'node:assert/strict';

export function assertScanProps(actual, expected) {
  const {loopBlockMaxMs, longestSyncOp, longestSyncMs, ...rest} = actual;
  assert.ok(Number.isInteger(loopBlockMaxMs) && loopBlockMaxMs >= 0);
  assert.ok(Number.isInteger(longestSyncMs) && longestSyncMs >= 0);
  assert.match(longestSyncOp, /^[A-Za-z][A-Za-z0-9]*$/);
  assert.deepEqual(rest, expected);
}
