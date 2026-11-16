sed -n '450,470p' src/server.js; sed -n '78,105p' src/dia.js; cat >> test/navigation-metadata.test.js <<'EOF'

const scriptFailures = [
  [-600, 'app_not_running'], [-609, 'app_not_running'],
  [-1728, 'no_such_window'], [-1719, 'no_such_window'],
  [-1712, 'apple_event_timeout'],
  [-2740, 'script_syntax'], [-2741, 'script_syntax'], [-2752, 'script_syntax'], [-2753, 'script_syntax'], [-2760, 'script_syntax'],
  [-1743, 'permission_denied'], [-10004, 'permission_denied'], [-2700, 'other']
];
for (const [number, errorClass] of scriptFailures) test(`native diagnostic ${number} beats echoed lookup source`, async () => {
  const lines = [], history = createTabHistory(); history.record('101');
  await logContext.run({ args: { tabId: '101' }, tabHistory: history, write: value => lines.push(safeLine(value, date)) }, async () => {
    await assert.rejects(runOsascript(['-e', secret], 1024, 1000, 'focus tab', async () => {
      throw Object.assign(new Error(`Command failed: osascript source if (!found) throw Error("Unknown Dia tab") ${secret}`), { stderr: `DIA_SCRIPT_STEP:find_tab\nActual native diagnostic ${secret} (${number})` });
    }), error => { assert.equal(error.errorClass, errorClass); return true; });
  });
  const line = lines.find(line => line.name === 'osascript.call');
  assert.equal(line.props.errorClass, errorClass);
  assert.equal(line.props.errorNumber, number);
  assert.equal(line.props.step, 'find_tab');
  assert.equal(line.error.tag, number === -1712 ? 'osascript_timeout' : 'operation_failed');
  assert.doesNotMatch(JSON.stringify(lines), /PRIVATE|Actual native diagnostic|Unknown Dia tab/);
});

for (const method of ['Runtime.evaluate', 'Page.captureScreenshot', 'DOM.getDocument']) test(`non-navigation ${method} socket closure preserves target_closed`, async t => {
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    terminate() { this.close(); }
    send(text) {
      const request = JSON.parse(text);
      queueMicrotask(() => {
        if (request.method === method) this.close();
        else this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result: {} }) }));
      });
    }
  }
  t.mock.method(cdp.socketTransport, 'create', () => new Socket());
  t.after(() => cdp.closeDownloadSubscriptions());
  const f = bridgeFixture({ evaluateTarget: cdp.evaluateTarget, callTarget: cdp.callTarget, screenshotTarget: cdp.screenshotTarget });
  f.state.targets[0].webSocketDebuggerUrl = 'ws://mock.test/';
  const tool = method === 'Runtime.evaluate' ? 'dia_page_state' : method === 'Page.captureScreenshot' ? 'dia_screenshot' : 'dia_cdp';
  const result = await f.handlers.get(tool)({ profileName: 'Personal', tabId: '101', method, params: {} });
  assert.equal(result.isError, true);
  const call = f.lines.find(line => line.name === 'tool.call');
  assert.equal(call.error.tag, 'tab_not_found');
  assert.equal(call.props.errorClass, 'target_closed');
  assert.equal(call.props.step, 'tab_lookup');
  assert.equal(call.props.tabSeen, true);
});
EOF
python3 -I - <<'PY'
from pathlib import Path
p=Path('test/navigation-metadata.test.js')
s=p.read_text().replace('function bridgeFixture() {','function bridgeFixture(cdpOverrides = {}) {').replace('callTarget: async () => ({}) },','callTarget: async () => ({}), ...cdpOverrides },')
p.write_text(s)
PY
node --test test/navigation-metadata.test.js test/native-failure-tools.test.js test/osascript-metadata.test.js