// Robob control API location and token, shared by the pump (thread sends) and the messaging forward mode
// (missions API). Explicit values win, then T3_CONTROL_URL/T3_CONTROL_TOKEN, then coord's own credential file:
// COORD_CONTROL_TOKEN_FILE, default ~/.robob/components/coord.json. While that default file doesn't exist the old
// shared token (~/.robob/ardud-control.json) still works. Either file must be chmod 600.
// T3_CONTROL_TOKEN_FILE is ignored on purpose: crw loads coord in-process and points that setting at its own
// credential, and Robob only takes forwarded coord calls from the coord credential.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function readTokenFile(file) {
  try {
    if (statSync(file).mode & 0o077) throw new Error(`${file} must be chmod 600`);
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function tokenFile() {
  const own = process.env.COORD_CONTROL_TOKEN_FILE;
  if (own) return readTokenFile(own);
  const robob = join(homedir(), '.robob');
  return readTokenFile(join(robob, 'components', 'coord.json')) ?? readTokenFile(join(robob, 'ardud-control.json'));
}

export function controlConfig(o = {}) {
  let url = o.url ?? process.env.T3_CONTROL_URL;
  let token = o.token ?? process.env.T3_CONTROL_TOKEN;
  if (!url || !token) {
    const s = tokenFile();
    url ??= s?.url;
    token ??= s?.token;
  }
  if (!url || !token) throw new Error('no control API url/token');
  return { url: url.replace(/\/+$/, ''), token };
}
