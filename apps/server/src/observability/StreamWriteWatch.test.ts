// @effect-diagnostics nodeBuiltinImport:off - exercises Node's own stream prototypes.
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import { afterEach, describe, expect, it } from "@effect/vitest";

import type * as LargeReplyLog from "./LargeReplyLog.ts";
import * as StreamWriteWatch from "./StreamWriteWatch.ts";

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

const sink = () =>
  new NodeStream.Writable({
    write: (_chunk, _encoding, callback) => callback(),
  });

describe("StreamWriteWatch", () => {
  it("records large string and buffer writes with a call site, and ignores small ones", () => {
    const entries: LargeReplyLog.LargeReply[] = [];
    uninstall = StreamWriteWatch.install({ record: (entry) => entries.push(entry) });
    const stream = sink();
    stream.write("small");
    stream.write("é".repeat(600_000));
    stream.end(Buffer.alloc(1024 * 1024));
    expect(entries.map(({ kind, name, bytes }) => ({ kind, name, bytes }))).toEqual([
      { kind: "stream", name: "Writable", bytes: 1_200_000 },
      { kind: "stream", name: "Writable", bytes: 1024 * 1024 },
    ]);
    expect(entries[0]!.stack!.length).toBeGreaterThan(0);
    expect(entries[0]!.stack!.join("\n")).toContain("StreamWriteWatch.test");
    expect(JSON.stringify(entries)).not.toContain("é");
  });

  it("covers sockets, whose Duplex prototype has its own write", () => {
    const entries: LargeReplyLog.LargeReply[] = [];
    uninstall = StreamWriteWatch.install({ record: (entry) => entries.push(entry) });
    const socket = new NodeNet.Socket();
    socket.on("error", () => {});
    socket.write("x".repeat(1024 * 1024));
    socket.destroy();
    expect(entries.map(({ kind, bytes }) => ({ kind, bytes }))).toEqual([
      { kind: "socket", bytes: 1024 * 1024 },
    ]);
  });

  it("restores the original methods and never blocks a write when recording throws", () => {
    const original = NodeStream.Writable.prototype.write;
    uninstall = StreamWriteWatch.install({
      record: () => {
        throw new Error("logging failure");
      },
    });
    expect(NodeStream.Writable.prototype.write).not.toBe(original);
    expect(sink().write("x".repeat(1024 * 1024))).toBe(true);
    uninstall();
    uninstall = undefined;
    expect(NodeStream.Writable.prototype.write).toBe(original);
  });
});
