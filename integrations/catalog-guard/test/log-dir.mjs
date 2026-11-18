import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.ROUTER_LOG_DIR === undefined) {
  const root = mkdtempSync(join(tmpdir(), 'router-log-test-'));
  process.env.ROUTER_LOG_DIR = root;
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
}
