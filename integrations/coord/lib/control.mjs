// Robob control API location and token, shared by the pump (thread sends) and the messaging forward mode
// (missions API). Explicit values win, then T3_CONTROL_URL/T3_CONTROL_TOKEN, then the token file
// (T3_CONTROL_TOKEN_FILE, default ~/.robob/ardud-control.json, which must be chmod 600).
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function controlConfig(o = {}) {
  let url = o.url ?? process.env.T3_CONTROL_URL;
  let token = o.token ?? process.env.T3_CONTROL_TOKEN;
  if (!url || !token) {
    const file = process.env.T3_CONTROL_TOKEN_FILE ?? join(homedir(), '.robob', 'ardud-control.json');
    try {
      if (statSync(file).mode & 0o077) throw new Error(`${file} must be chmod 600`);
      const s = JSON.parse(readFileSync(file, 'utf8'));
      url ??= s.url;
      token ??= s.token;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  if (!url || !token) throw new Error('no control API url/token');
  return { url: url.replace(/\/+$/, ''), token };
}
