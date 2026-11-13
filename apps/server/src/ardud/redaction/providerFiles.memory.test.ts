// @effect-diagnostics nodeBuiltinImport:off - A separate Node heap makes archive retention failures observable.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

it("preflights, rewrites and verifies many gzip archives within a bounded heap", async () => {
  const fixture = NodeURL.fileURLToPath(
    new URL("./testkit/ProviderFilesMemory.fixture.mjs", import.meta.url),
  );
  const { stdout } = await execFile(
    HostProcess.ExecutablePath.defaultValue(),
    ["--expose-gc", "--max-old-space-size=256", fixture],
    { timeout: 540_000 },
  );
  const result = JSON.parse(stdout) as {
    archives: number;
    expandedBytes: number;
    matchedArchives: number;
    replaced: number;
    remaining: number;
    maxRetainedHeap: number;
  };
  expect(result.archives).toBe(40);
  expect(result.expandedBytes).toBeGreaterThan(600 * 1024 * 1024);
  expect(result.matchedArchives).toBe(20);
  expect(result.replaced).toBeGreaterThan(0);
  expect(result.remaining).toBe(0);
  expect(result.maxRetainedHeap).toBeLessThan(128 * 1024 * 1024);
}, 600_000);
