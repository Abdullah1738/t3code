/** Internal, one-shot Dia MCP transport. Only profiles + fixed read-only extractor.
 * No CDP client, browser launch, navigation, auth, cookies, persistence or raw logs.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9-]{1,128}$/;
const HISTORY = /^\/(?:gp\/your-account\/order-history|your-orders\/orders)(?:\/ref=[^/?#]+)?\/?$/;
const DETAILS = /^\/your-orders\/order-details(?:\/ref=[^/?#]+)?\/?$/;
const SAFE_ERRORS = new Set(['DIA_TIMEOUT', 'DIA_TRANSPORT_FAILED', 'DIA_RESPONSE_TOO_LARGE',
  'DIA_INVALID_RESPONSE', 'DIA_TOOL_FAILED', 'DIA_BINDING_MISMATCH', 'DIA_LOCATION_MISMATCH',
  'DIA_BRIDGE_UNAVAILABLE', 'PERSONAL_PROFILE_REQUIRED', 'DIA_PROFILE_UNMAPPED',
  'AMAZON_ORDERS_TAB_REQUIRED', 'AMAZON_ORDERS_TAB_AMBIGUOUS', 'TAB_NOT_FOUND',
  'UNSUPPORTED_PAGE', 'PAGE_NOT_READY', 'DIA_TARGET_AMBIGUOUS', 'INVALID_ARGUMENTS',
  'EXTRACTOR_UNAVAILABLE']);
export class SafeError extends Error {}
const fail = code => { throw new SafeError(code); };
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
export const safeCode = error => error instanceof SafeError && SAFE_ERRORS.has(error.message)
  ? error.message : 'DIA_TRANSPORT_FAILED';

function orderUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 16384) return null;
    const u = new URL(value);
    if (!['https://www.amazon.ae', 'https://amazon.ae'].includes(u.origin) || u.username || u.password ||
        (!HISTORY.test(u.pathname) && !DETAILS.test(u.pathname))) return null;
    return u;
  } catch { return null; }
}
function normalized(value) {
  const u = orderUrl(value);
  if (!u) return null;
  u.hash = '';
  return u.href.replace(/\/$/, '');
}

export function decodeTool(value) {
  if (!object(value)) fail('DIA_INVALID_RESPONSE');
  if (value.isError) fail('DIA_TOOL_FAILED');
  if (!Array.isArray(value.content) || value.content.length !== 1 || value.content[0]?.type !== 'text' ||
      typeof value.content[0].text !== 'string') fail('DIA_INVALID_RESPONSE');
  if (Buffer.byteLength(value.content[0].text) > MAX_BYTES) fail('DIA_RESPONSE_TOO_LARGE');
  try {
    const decoded = JSON.parse(value.content[0].text);
    if (!object(decoded)) fail('DIA_INVALID_RESPONSE');
    return decoded;
  } catch { fail('DIA_INVALID_RESPONSE'); }
}

export function selectTab(inventory, requestedTab) {
  if (requestedTab !== undefined && (typeof requestedTab !== 'string' || !ID.test(requestedTab)))
    fail('INVALID_ARGUMENTS');
  if (!object(inventory) || !Array.isArray(inventory.profiles)) fail('DIA_INVALID_RESPONSE');
  const profiles = inventory.profiles.filter(p => p?.profile === 'Personal');
  if (profiles.length !== 1) fail('PERSONAL_PROFILE_REQUIRED');
  const p = profiles[0];
  if (p.mappingStatus !== 'mapped' || typeof p.browserContextId !== 'string' || !p.browserContextId)
    fail('DIA_PROFILE_UNMAPPED');
  if (!Array.isArray(p.tabs)) fail('DIA_INVALID_RESPONSE');
  const tabs = p.tabs.filter(t => requestedTab ? t?.id === requestedTab : orderUrl(t?.url));
  if (!tabs.length) fail(requestedTab ? 'TAB_NOT_FOUND' : 'AMAZON_ORDERS_TAB_REQUIRED');
  if (tabs.length !== 1) fail('AMAZON_ORDERS_TAB_AMBIGUOUS');
  const tab = tabs[0];
  if (!orderUrl(tab.url)) fail('UNSUPPORTED_PAGE');
  if (tab.loading !== false) fail('PAGE_NOT_READY');
  if (typeof tab.id !== 'string' || !ID.test(tab.id) || !Array.isArray(tab.targetMatches))
    fail('DIA_INVALID_RESPONSE');
  // No title-only fallback: the bridge inventory includes loose title matches.
  const matches = tab.targetMatches.filter(t => t?.browserContextId === p.browserContextId &&
    normalized(t.url) === normalized(tab.url));
  if (matches.length !== 1 || typeof matches[0].targetId !== 'string' || !ID.test(matches[0].targetId))
    fail('DIA_TARGET_AMBIGUOUS');
  return { tab_id: tab.id, target_id: matches[0].targetId, context: p.browserContextId, url: tab.url };
}

export function projectResponse(response, binding) {
  const t = response?.target;
  if (response?.profileName !== 'Personal' || response?.diaTabId !== binding.tab_id || !object(t) ||
      (t.targetId ?? t.id) !== binding.target_id || ('id' in t && t.id !== (t.targetId ?? t.id)) ||
      t.type !== 'page' || (t.browserContextId || 'default') !== binding.context)
    fail('DIA_BINDING_MISMATCH');
  if (!normalized(t.url) || normalized(t.url) !== normalized(binding.url)) fail('DIA_LOCATION_MISMATCH');
  if (!object(response.result) || response.result.exceptionDetails ||
      response.result.result?.type !== 'object' || !object(response.result.result.value))
    fail('DIA_INVALID_RESPONSE');
  const u = orderUrl(t.url);
  // Only validation metadata needed by parse_dia_result crosses the private pipe.
  // No inventory, titles, websocket endpoints, raw target URLs or SDK errors.
  return { binding: { tab_id: binding.tab_id, target_id: binding.target_id }, response: {
    profileName: 'Personal', diaTabId: binding.tab_id,
    target: { targetId: binding.target_id, type: 'page', url: u.origin + u.pathname },
    result: { result: { type: 'object', value: response.result.result.value } },
  } };
}

export async function runRead(client, { tabId, expression, deadline }) {
  const call = async (name, args) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) fail('DIA_TIMEOUT');
    return decodeTool(await client.callTool({ name, arguments: args }, undefined,
      { timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false }));
  };
  const binding = selectTab(await call('dia_profiles', {}), tabId);
  // tabId only: bridge targetId branch deliberately does NOT return diaTabId.
  const response = await call('dia_evaluate', { profileName: 'Personal', tabId: binding.tab_id,
    expression, awaitPromise: true, returnByValue: true });
  return projectResponse(response, binding);
}

export function bridgeEnvironment(timeoutMs) {
  const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k])
    .map(k => [k, process.env[k]]));
  return { ...env, DIA_AUTO_HEAL: '0', DIA_CDP_ENDPOINT: 'http://127.0.0.1:9222',
    DIA_TOOL_TIMEOUT_MS: String(timeoutMs), DIA_OSASCRIPT_TIMEOUT_MS: String(Math.min(10000, timeoutMs)),
    DIA_CDP_HTTP_TIMEOUT_MS: String(Math.min(5000, timeoutMs)),
    DIA_CDP_OPEN_TIMEOUT_MS: String(Math.min(5000, timeoutMs)), DIA_CDP_CALL_TIMEOUT_MS: String(timeoutMs) };
}

async function main() {
  let client, transport, timer, closingTimer;
  let output;
  try {
    const args = process.argv.slice(2);
    let tabId, timeoutMs = 29000;
    const seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      if (seen.has(args[i]) || i + 1 >= args.length) fail('INVALID_ARGUMENTS');
      seen.add(args[i]);
      if (args[i] === '--tab-id') tabId = args[i + 1];
      else if (args[i] === '--timeout-ms' && /^\d+$/.test(args[i + 1])) timeoutMs = Number(args[i + 1]);
      else fail('INVALID_ARGUMENTS');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 59000 ||
        (tabId !== undefined && !ID.test(tabId))) fail('INVALID_ARGUMENTS');
    const deadline = Date.now() + timeoutMs;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new SafeError('DIA_TIMEOUT')), timeoutMs); });
    const work = async () => {
      const root = join(homedir(), '.config/opencode/dia-agent-bridge');
      const sdk = join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm');
      let Client, StdioClientTransport;
      try {
        ({ Client } = await import(pathToFileURL(join(sdk, 'client/index.js')).href));
        ({ StdioClientTransport } = await import(pathToFileURL(join(sdk, 'client/stdio.js')).href));
      } catch { fail('DIA_BRIDGE_UNAVAILABLE'); }
      let expression;
      try {
        const source = await readFile(new URL('./amazon_browser_orders.py', import.meta.url), 'utf8');
        expression = source.match(/^DIA_EXTRACTOR = r"""([\s\S]*?)"""$/m)?.[1];
        if (!expression || Buffer.byteLength(expression) > 32768) fail('EXTRACTOR_UNAVAILABLE');
      } catch { fail('EXTRACTOR_UNAVAILABLE'); }
      if (Date.now() >= deadline) fail('DIA_TIMEOUT');
      transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'src/server.js')],
        env: bridgeEnvironment(timeoutMs), stderr: 'ignore', maxBufferSize: MAX_BYTES });
      client = new Client({ name: 'amazon-browser-orders-readonly', version: '1.0.0' });
      await client.connect(transport, { timeout: Math.max(1, deadline - Date.now()) });
      return runRead(client, { tabId, expression, deadline });
    };
    output = await Promise.race([work(), timeout]);
  } catch (error) {
    output = { error: safeCode(error) };
  } finally {
    clearTimeout(timer);
    const pid = transport?.pid;
    try {
      await Promise.race([client?.close(), new Promise(resolve => { closingTimer = setTimeout(resolve, 300); })]);
    } catch { /* Private errors are discarded. Python also reaps the whole group. */ }
    clearTimeout(closingTimer);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already closed. */ } }
  }
  let text = JSON.stringify(output);
  if (Buffer.byteLength(text) > MAX_BYTES) text = JSON.stringify({ error: 'DIA_RESPONSE_TOO_LARGE' });
  process.stdout.write(text + '\n', () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stdout.write('{"error":"DIA_TRANSPORT_FAILED"}\n', () => process.exit(0)); });
}
