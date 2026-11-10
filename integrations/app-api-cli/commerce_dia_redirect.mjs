// The redirect travels over stdin and MCP pipes, never argv or console output.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const bridge = join(homedir(), '.config/opencode/dia-agent-bridge');
const require = createRequire(join(bridge, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const client = new Client({ name: 'commerce-redirect', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(bridge, 'src/server.js')], stderr: 'ignore' }));
  const inventory = await client.callTool({ name: 'dia_profiles', arguments: {} });
  if (inventory.isError) throw new Error('inventory failed');
  const result = await client.callTool({ name: 'dia_window_create', arguments: {
    profileName: 'Personal', url: JSON.parse(input).url,
    label: 'Noon bank verification', keepOpen: true,
  } }, undefined, { timeout: 95000 });
  if (result.isError) throw new Error('window failed');
  process.stdout.write('{"opened":true}\n');
} catch (_) {
  process.exitCode = 1;
} finally {
  await client.close();
}
