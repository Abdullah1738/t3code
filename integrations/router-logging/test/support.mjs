import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), '9router-log-'));
  const previous = process.env.ROUTER_LOG_DIR;
  process.env.ROUTER_LOG_DIR = root;
  t.after(() => {
    if (process.env.ROUTER_LOG_CAPTURE) for (const file of fs.readdirSync(root).filter(x=>x.endsWith('.ndjson'))) {
      const path = join(root,file);
      if (fs.statSync(path).size < 2*1024*1024) fs.appendFileSync(process.env.ROUTER_LOG_CAPTURE, fs.readFileSync(path));
    }
    if (previous === undefined) delete process.env.ROUTER_LOG_DIR; else process.env.ROUTER_LOG_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  const rows = () => fs.readdirSync(root).filter(x=>x.endsWith('.ndjson')).flatMap(x=>fs.readFileSync(join(root,x),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  return {root, rows};
}
