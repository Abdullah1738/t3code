// @effect-diagnostics nodeBuiltinImport:off - tests mock the native libproc transport.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import { beforeEach, vi } from "vite-plus/test";
import { diskReadDelta, sampleProcessDiskRead } from "./processDiskRead.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it.each([
  "linux",
  "win32",
  "aix",
  "android",
  "freebsd",
  "haiku",
  "openbsd",
  "sunos",
  "cygwin",
  "netbsd",
] as const)("reports unavailable without native I/O on %s", async (platform) => {
  assert.strictEqual(await sampleProcessDiskRead(platform), undefined);
  assert.strictEqual(vi.mocked(NodeChildProcess.execFile).mock.calls.length, 0);
});

it.each([
  {
    name: "bytes",
    output: '{"bytes":42,"identity":"start"}',
    expected: { bytes: 42, identity: "start" },
  },
  {
    name: "zero",
    output: '{"bytes":0,"identity":"start"}',
    expected: { bytes: 0, identity: "start" },
  },
  { name: "negative", output: '{"bytes":-1,"identity":"start"}', expected: undefined },
  { name: "fractional", output: '{"bytes":1.5,"identity":"start"}', expected: undefined },
  {
    name: "unsafe integer",
    output: '{"bytes":9007199254740992,"identity":"start"}',
    expected: undefined,
  },
  { name: "missing identity", output: '{"bytes":42}', expected: undefined },
  { name: "invalid JSON", output: "not JSON", expected: undefined },
  { name: "native failure", output: "", expected: undefined, failed: true },
])("validates Darwin sampler output: $name", async ({ output, expected, failed }) => {
  vi.mocked(NodeChildProcess.execFile).mockImplementation((...args) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(failed ? new Error("libproc unavailable") : null, output, "");
    return {} as NodeChildProcess.ChildProcess;
  });
  assert.deepEqual(await sampleProcessDiskRead("darwin"), expected);
});

it("reports bytes only across consecutive samples of the same process", () => {
  const first = { bytes: 100, identity: "start-1" };
  assert.strictEqual(diskReadDelta(first, { bytes: 160, identity: "start-1" }), 60);
  assert.strictEqual(diskReadDelta(first, { bytes: 100, identity: "start-1" }), 0);
  for (const [previous, current] of [
    [undefined, first],
    [first, undefined],
    [first, { bytes: 90, identity: "start-1" }],
    [first, { bytes: 160, identity: "start-2" }],
  ] as const)
    assert.strictEqual(diskReadDelta(previous, current), undefined);
});
