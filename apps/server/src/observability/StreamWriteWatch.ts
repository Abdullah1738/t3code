// @effect-diagnostics nodeBuiltinImport:off - the watch has to sit on Node's own stream prototypes.
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import {
  LARGE_REPLY_BYTES,
  type LargeReply,
  type LargeReplyRecorder,
  utf8BytesIfLarge,
} from "./LargeReplyLog.ts";

// OOM crashes stop in StreamBase::WriteString: one huge string written to a
// socket, pipe or child stdin. No route reaches that layer, so a large write
// records where it came from instead.
const STACK_FRAMES = 12;

const sizeOf = (chunk: unknown): number | undefined => {
  if (typeof chunk === "string") return utf8BytesIfLarge(chunk);
  if (chunk instanceof Uint8Array)
    return chunk.byteLength >= LARGE_REPLY_BYTES ? chunk.byteLength : undefined;
  return undefined;
};

const destinationOf = (stream: unknown): { kind: LargeReply["kind"]; name: string } => {
  if (stream instanceof NodeNet.Socket) {
    const handle = (stream as unknown as { _handle?: { constructor?: { name?: string } } })._handle;
    const type = handle?.constructor?.name;
    if (type === "Pipe") return { kind: "pipe", name: type };
    if (type === "TTY") return { kind: "tty", name: type };
    return { kind: "socket", name: type ?? "Socket" };
  }
  const name = (stream as { constructor?: { name?: string } } | null)?.constructor?.name;
  return { kind: "stream", name: name ?? "Writable" };
};

// `below` hides the watch's own frames even when the server is bundled.
const callSite = (below: Function): ReadonlyArray<string> => {
  const holder: { stack?: string } = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_FRAMES;
  try {
    Error.captureStackTrace(holder, below);
  } finally {
    Error.stackTraceLimit = limit;
  }
  return (holder.stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim());
};

type WriteFn = (this: unknown, chunk: unknown, ...rest: Array<unknown>) => boolean;
type EndFn = (this: unknown, chunk?: unknown, ...rest: Array<unknown>) => unknown;

let installed: LargeReplyRecorder | undefined;

/**
 * Watches every Writable write/end for chunks of at least 1 MiB. Small writes
 * pay a type check and one length comparison. Returns the uninstaller.
 */
export const install = (log: LargeReplyRecorder): (() => void) => {
  if (installed !== undefined) return () => {};
  installed = log;
  const record = (stream: unknown, chunk: unknown, below: Function) => {
    try {
      const bytes = sizeOf(chunk);
      if (bytes === undefined) return;
      log.record({ ...destinationOf(stream), bytes, stack: callSite(below) });
    } catch {
      // The write itself must go ahead.
    }
  };
  // Duplex copies Writable's methods onto its own prototype, so both need it.
  const prototypes = [NodeStream.Writable.prototype, NodeStream.Duplex.prototype] as const;
  const restore: Array<() => void> = [];
  for (const proto of prototypes) {
    const target = proto as unknown as { write: WriteFn; end: EndFn };
    const write = target.write;
    const end = target.end;
    const watchedWrite: WriteFn = function (this: unknown, chunk, ...rest) {
      record(this, chunk, watchedWrite);
      return write.call(this, chunk, ...rest);
    };
    const watchedEnd: EndFn = function (this: unknown, chunk, ...rest) {
      if (typeof chunk !== "function") record(this, chunk, watchedEnd);
      return end.call(this, chunk, ...rest);
    };
    target.write = watchedWrite;
    target.end = watchedEnd;
    restore.push(() => {
      target.write = write;
      target.end = end;
    });
  }
  return () => {
    for (const undo of restore) undo();
    installed = undefined;
  };
};
