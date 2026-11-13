// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { expect, it, vi } from "vite-plus/test";
import { CompressedFileSink } from "./compressedFileSink.ts";

const disk = vi.hoisted(() => ({
  files: new Map<string, number>(),
  peak: 0,
  remove: undefined as ((file: string) => Promise<void>) | undefined,
  pipeline: undefined as ((input: string, output: string) => Promise<void>) | undefined,
}));
const observeBytes = () => {
  disk.peak = Math.max(
    disk.peak,
    [...disk.files.values()].reduce((a, b) => a + b, 0),
  );
};
vi.mock("node:fs/promises", () => {
  const missing = () => Object.assign(new Error("fixture missing file"), { code: "ENOENT" });
  return {
    mkdir: async () => undefined,
    readdir: async () => [...disk.files.keys()].map((f) => NodePath.basename(f)),
    stat: async (file: string) => {
      if (!disk.files.has(file)) throw missing();
      return { size: disk.files.get(file)! };
    },
    open: async () => ({ sync: async () => undefined, close: async () => undefined }),
    rename: async (from: string, to: string) => {
      if (!disk.files.has(from)) throw missing();
      disk.files.set(to, disk.files.get(from)!);
      disk.files.delete(from);
      observeBytes();
    },
    appendFile: async (file: string, buffer: Buffer) => {
      disk.files.set(file, (disk.files.get(file) ?? 0) + buffer.length);
      observeBytes();
    },
    rm: async (file: string, options?: { force?: boolean }) => {
      await disk.remove?.(file);
      if (!disk.files.delete(file) && !options?.force) throw missing();
    },
  };
});
vi.mock("node:fs", () => ({
  createReadStream: (path: string) => ({ path }),
  createWriteStream: (path: string) => ({ path }),
}));
vi.mock("node:zlib", () => ({ createGzip: () => ({}) }));
vi.mock("node:stream/promises", () => ({
  pipeline: async (input: { path: string }, _gzip: unknown, output: { path: string }) =>
    disk.pipeline?.(input.path, output.path),
}));
const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it.each(["plain", "mixed gzip", "recovered partial gzip"])(
  "keeps the byte cap during startup compression and delayed pruning: %s",
  async (form) => {
    const rawSize = 64 * 1024 * 1024;
    const cap = 1_000_000_000;
    const filePath = "/virtual/server.trace.ndjson";
    disk.files.clear();
    disk.peak = 0;
    const indices = Array.from({ length: 15 }, (_, i) => i + 1);
    const started = new Map(indices.map((i) => [i, latch()]));
    const finish = new Map(indices.map((i) => [i, latch()]));
    const firstRemove = latch();
    const allowRemove = [latch(), latch()];
    let oldestRemoves = 0;
    for (const i of indices) {
      const compressed = form === "mixed gzip" && i >= 2 && i <= 9;
      disk.files.set(
        `${filePath}.${i}${compressed ? ".gz" : ""}`,
        i === 15 ? 1_000_000 : i >= 2 && i <= 9 ? rawSize - 4_000_000 : rawSize,
      );
    }
    if (form === "recovered partial gzip") {
      disk.files.set(`${filePath}.13.gz`, 123);
      disk.files.set(`${filePath}.13.gz.tmp`, 99);
    }
    disk.files = new Map([...disk.files].sort(([a], [b]) => a.localeCompare(b)));
    disk.pipeline = async (input, output) => {
      const index = Number(input.split(".").at(-1));
      disk.files.set(output, disk.files.get(input)! + 23);
      observeBytes();
      started.get(index)!.resolve();
      await finish.get(index)!.promise;
    };
    disk.remove = async (file) => {
      if (file !== `${filePath}.15`) return;
      const call = oldestRemoves++;
      firstRemove.resolve();
      await allowRemove[call]?.promise;
    };
    const sink = new CompressedFileSink({
      filePath,
      maxBytes: rawSize,
      maxFiles: 128,
      maxTotalBytes: cap,
      platform: "linux",
    });
    await sink.initialize();
    for (const index of [1, 10, 11, 12]) {
      await started.get(index)!.promise;
      finish.get(index)!.resolve();
    }
    await started.get(13)!.promise;
    const writing = sink.write(Buffer.alloc(rawSize));
    await firstRemove.promise;
    finish.get(13)!.resolve();
    // All mock I/O is immediate except the latches. One event-loop turn drains those promise jobs.
    await NodeTimersPromises.setImmediate();
    allowRemove[0]!.resolve();
    await writing;
    allowRemove[1]!.resolve();
    for (const value of finish.values()) value.resolve();
    await sink.flush();
    expect(disk.peak).toBeLessThanOrEqual(cap);
    expect([...disk.files.values()].reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(cap);
    expect(disk.files.has(`${filePath}.15`)).toBe(false);
  },
);
