// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as HostProcess from "./HostProcess.ts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { CompressedFileSink } from "./compressedFileSink.ts";

vi.mock("node:zlib", async (original) => {
  const zlib = await original<typeof import("node:zlib")>();
  return { ...zlib, createGzip: vi.fn(zlib.createGzip) };
});
const directories: string[] = [];
const fixture = async (maxTotalBytes = 10_000, maxFiles = 10) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "compressed-trace-"));
  directories.push(directory);
  const filePath = NodePath.join(directory, "trace.ndjson");
  const sink = new CompressedFileSink({
    platform: HostProcess.Platform.defaultValue(),
    filePath,
    maxBytes: 256,
    maxFiles,
    maxTotalBytes,
  });
  await sink.initialize();
  return { directory, filePath, sink };
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

it("rotates to gzip in order, removes plain sources and resumes after startup", async () => {
  const { sink, filePath, directory } = await fixture();
  const chunks = ["a", "b", "c"].map((c) => Buffer.from(`${c.repeat(255)}\n`));
  for (const chunk of chunks) await sink.write(chunk);
  await sink.flush();
  expect(await NodeFSP.readdir(directory)).toEqual(
    expect.arrayContaining(["trace.ndjson", "trace.ndjson.1.gz", "trace.ndjson.2.gz"]),
  );
  expect(await NodeFSP.readFile(filePath)).toEqual(chunks[2]);
  expect(NodeZlib.gunzipSync(await NodeFSP.readFile(`${filePath}.1.gz`))).toEqual(chunks[1]);
  expect(NodeZlib.gunzipSync(await NodeFSP.readFile(`${filePath}.2.gz`))).toEqual(chunks[0]);
  await expect(NodeFSP.stat(`${filePath}.1`)).rejects.toMatchObject({ code: "ENOENT" });
  await NodeFSP.writeFile(`${filePath}.1`, chunks[1]!);
  await NodeFSP.writeFile(`${filePath}.1.gz.tmp`, "partial");
  const resumed = new CompressedFileSink({
    platform: HostProcess.Platform.defaultValue(),
    filePath,
    maxBytes: 256,
    maxFiles: 10,
    maxTotalBytes: 10_000,
  });
  await resumed.initialize();
  await resumed.flush();
  expect(NodeZlib.gunzipSync(await NodeFSP.readFile(`${filePath}.1.gz`))).toEqual(chunks[1]);
  await expect(NodeFSP.stat(`${filePath}.1.gz.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a plain source when gzip fails, then recovers it at startup", async () => {
  const { sink, filePath } = await fixture();
  const chunk = Buffer.from("x".repeat(256));
  await sink.write(chunk);
  vi.mocked(NodeZlib.createGzip).mockImplementationOnce(() => {
    throw new Error("gzip fixture failure");
  });
  await sink.write(Buffer.from("next"));
  await sink.flush();
  expect(await NodeFSP.readFile(`${filePath}.1`)).toEqual(chunk);
  await expect(NodeFSP.stat(`${filePath}.1.gz`)).rejects.toMatchObject({ code: "ENOENT" });
  const resumed = new CompressedFileSink({
    platform: HostProcess.Platform.defaultValue(),
    filePath,
    maxBytes: 256,
    maxFiles: 10,
    maxTotalBytes: 10_000,
  });
  await resumed.initialize();
  await resumed.flush();
  expect(NodeZlib.gunzipSync(await NodeFSP.readFile(`${filePath}.1.gz`))).toEqual(chunk);
});

it("enforces actual bytes with scratch reserve and evicts the oldest archives first", async () => {
  const { sink, filePath, directory } = await fixture(1_900);
  for (let n = 0; n < 80; n++) {
    await sink.write(Buffer.from(String(n).padEnd(256, "x")));
    const total = (
      await Promise.all(
        (await NodeFSP.readdir(directory)).map(
          async (name) =>
            await NodeFSP.stat(NodePath.join(directory, name)).then(
              (s) => s.size,
              (e: NodeJS.ErrnoException) => {
                if (e.code === "ENOENT") return 0;
                throw e;
              },
            ),
        ),
      )
    ).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(1_900);
  }
  await sink.flush();
  const names = await NodeFSP.readdir(directory);
  expect(names).toContain("trace.ndjson.1.gz");
  expect(NodeZlib.gunzipSync(await NodeFSP.readFile(`${filePath}.1.gz`))).toEqual(
    Buffer.from("78".padEnd(256, "x")),
  );
  expect(names.length).toBeLessThan(11);
});
