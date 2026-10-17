// Talks to the Robob server's scribe routes with the control API token.
// The server owns cursors, notes and checks; this file only moves JSON.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.HOME || homedir();
const CONTROL_FILE = process.env.SCRIBE_CONTROL_FILE || join(HOME, '.robob/ardud-control.json');
export const SCRIBE_PREFIX = '/api/ardud/missions/scribe';

export function controlConfig() {
  let file = {};
  if (existsSync(CONTROL_FILE)) file = JSON.parse(readFileSync(CONTROL_FILE, 'utf8'));
  const url = (process.env.T3_CONTROL_URL || file.url || 'http://127.0.0.1:3773').replace(/\/$/, '');
  const token = process.env.T3_CONTROL_TOKEN || file.token;
  if (!token) throw new Error(`no control token (set T3_CONTROL_TOKEN or write ${CONTROL_FILE})`);
  return { url, token };
}

export function serverClient({ url, token, fetchImpl = fetch, timeoutMs = 30_000 } = controlConfig()) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${url}${SCRIBE_PREFIX}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.ok || data.ok === false) {
      throw new Error(`${method} ${path}: ${data.error?.code ?? res.status} ${data.error?.message ?? ''}`.trim());
    }
    return data;
  };
  const q = (params) => {
    const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null);
    return entries.length === 0 ? '' : `?${new URLSearchParams(entries).toString()}`;
  };
  return {
    /** Lanes the scribe should read, with their server-side cursor. */
    lanes: async (missionId) => (await call('GET', `/lanes${q({ missionId })}`)).lanes,
    openNotes: async (missionId, threadId) =>
      (await call('GET', `/open-notes${q({ missionId, threadId })}`)).notes,
    postBatch: async (batch) => (await call('POST', '/batches', batch)).result,
    editorInput: async (missionId) => (await call('GET', `/editor/input${q({ missionId })}`)).input,
    postEditor: async (output) => (await call('POST', '/editor', output)).result,
    report: async (request) => (await call('POST', '/reports', request)).report,
  };
}

/** Sink for runLane backed by the server. */
export function serverSink(client, lane) {
  return {
    cursor: async () => lane.cursor ?? 0,
    openNotes: () => client.openNotes(lane.missionId, lane.threadId),
    postBatch: (batch) => client.postBatch(batch),
  };
}
