import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off - Atomic fsync/rename and byte-preserving fixture verification require native file handles.
import * as NodeZlib from "node:zlib";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { ThreadRedactionCount } from "@t3tools/contracts";
import {
  outputs,
  parseJson,
  replaceText,
  escapedNeedles,
  replaceScalarText,
  sameStructure,
} from "./content.ts";

const decodeText = (bytes: Uint8Array): string => {
  try {
    // Preserve BOM bytes too; default TextDecoder would silently remove them.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Redaction requires valid UTF-8 text.");
  }
};
const decompress = NodeUtil.promisify(NodeZlib.gunzip);
const compress = NodeUtil.promisify(NodeZlib.gzip);
export async function readTextFile(file: string): Promise<string> {
  const bytes = await NodeFSP.readFile(file);
  return decodeText(file.endsWith(".gz") ? await decompress(bytes) : bytes);
}

export async function filesBelow(root: string): Promise<string[]> {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw new Error("Redaction file inventory failed.");
    },
  );
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const name = NodePath.join(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Redaction refuses symbolic links.");
      return entry.isDirectory() ? filesBelow(name) : entry.isFile() ? [name] : [];
    }),
  );
  return nested.flat();
}

export async function readNeedle(file: string): Promise<string> {
  const stat = await NodeFSP.lstat(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) {
    throw new Error("Needle file must be an owned regular file with mode 0600.");
  }
  const handle = await NodeFSP.open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error("Needle file changed.");
    const needle = decodeText(await handle.readFile());
    if (!needle) throw new Error("Needle file is empty.");
    return needle;
  } finally {
    await handle.close();
  }
}

const validateTranscript = (file: string, text: string, before?: string) => {
  if (!file.endsWith(".jsonl")) return;
  try {
    const rewritten = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => parseJson(line) as unknown);
    if (before !== undefined) {
      const original = before
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => parseJson(line) as unknown);
      if (
        original.length !== rewritten.length ||
        original.some((value, i) => !sameStructure(value, rewritten[i]))
      )
        throw new Error("Transcript structure changed.");
    }
  } catch {
    throw new Error("Redaction transcript validation failed.");
  }
};

export interface RewritePlan {
  path: string;
  before: string;
  after: string;
  mode: number;
  ino: number;
  mtimeMs: number;
}

export async function planFile(
  file: string,
  needles: readonly string[],
  marker: string,
): Promise<RewritePlan> {
  const stat = await NodeFSP.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error("Redaction requires an unlinked regular file.");
  const before = await readTextFile(file);
  const after = (file.endsWith(".jsonl") ? replaceText : replaceScalarText)(
    before,
    needles,
    marker,
  ).text;
  validateTranscript(file, after, before);
  return {
    path: file,
    before,
    after,
    mode: stat.mode & 0o777,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
  };
}

async function rewriteFileNative(
  plan: RewritePlan,
  needles: readonly string[],
  marker: string,
): Promise<ThreadRedactionCount> {
  validateTranscript(plan.path, plan.after, plan.before);
  const count = (plan.path.endsWith(".jsonl") ? replaceText : replaceScalarText)(
    plan.before,
    needles,
    marker,
  ).count;
  if (plan.before !== plan.after) {
    const temp = NodePath.join(
      NodePath.dirname(plan.path),
      `.redaction-${NodeCrypto.randomUUID()}`,
    );
    const handle = await NodeFSP.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(
        plan.path.endsWith(".gz") ? await compress(plan.after, { level: 6 }) : plan.after,
      );
      await handle.chmod(plan.mode);
      await handle.sync();
      await handle.close();
      const stat = await NodeFSP.lstat(plan.path);
      if (
        stat.ino !== plan.ino ||
        stat.mtimeMs !== plan.mtimeMs ||
        (await readTextFile(plan.path)) !== plan.before
      ) {
        throw new Error("Redaction file changed; retry after stopping its writer.");
      }
      await NodeFSP.rename(temp, plan.path);
      const directory = await NodeFSP.open(NodePath.dirname(plan.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle.close().catch(() => undefined);
      await NodeFSP.unlink(temp).catch(() => undefined);
    }
  }
  const remainingAfter = (plan.path.endsWith(".jsonl") ? replaceText : replaceScalarText)(
    await readTextFile(plan.path),
    needles,
    marker,
  ).count;
  return { store: plan.path, matchedBefore: count, replaced: count, remainingAfter };
}

export class RedactionFileError extends Schema.TaggedError<RedactionFileError>()(
  "RedactionFileError",
  {},
) {
  override get message() {
    return "Redaction file changed or could not be rewritten.";
  }
}

// Native rename/fsync cannot be aborted; keep the maintenance barriers until they settle.
export const rewriteFile = Effect.fn("ThreadRedaction.rewriteFile")(
  (plan: RewritePlan, needles: readonly string[], marker: string) =>
    Effect.tryPromise({
      try: () => rewriteFileNative(plan, needles, marker),
      catch: () => new RedactionFileError({}),
    }).pipe(Effect.uninterruptible),
);

/** Unchanged JSONL lines are never reserialized. */
export async function providerResult(
  file: string,
  itemId: string,
): Promise<{ matched: number; outputs: string[]; taskIds: string[] }> {
  const text = await readTextFile(file);
  const found: string[] = [];
  let matched = 0;
  const taskIds = new Set<string>();
  const result = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const record = v as Record<string, unknown>;
    if (
      (record.type === "tool_result" && record.tool_use_id === itemId) ||
      (record.type === "function_call_output" && record.call_id === itemId)
    ) {
      matched++;
      found.push(...outputs(record));
    }
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const frame = parseJson(line) as Record<string, unknown>;
    if (
      frame.type === "system" &&
      frame.subtype === "task_started" &&
      frame.tool_use_id === itemId &&
      typeof frame.task_id === "string" &&
      /^[a-zA-Z0-9_-]+$/.test(frame.task_id)
    )
      taskIds.add(frame.task_id);
    result(frame);
    if (frame.type === "response_item") result(frame.payload);
    if (frame.message && typeof frame.message === "object") {
      const message = frame.message as Record<string, unknown>;
      if (Array.isArray(message.content)) for (const block of message.content) result(block);
    }
  }
  return { matched, outputs: found, taskIds: [...taskIds] };
}

/** Match the adapter's per-session task layout; unknown ownership prevents complete coverage. */
export async function claudeTaskFiles(roots: readonly string[], sessionIds: ReadonlySet<string>) {
  const result: { path: string; sessionId: string; taskId: string }[] = [];
  for (const root of new Set(roots)) {
    const projects = await NodeFSP.readdir(root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw new Error("Redaction task inventory failed.");
      },
    );
    for (const project of projects) {
      if (project.isSymbolicLink()) throw new Error("Redaction refuses symbolic links.");
      if (!project.isDirectory()) continue;
      for (const sessionId of sessionIds) {
        const session = NodePath.join(root, project.name, sessionId);
        const stat = await NodeFSP.lstat(session).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw new Error("Redaction task inventory failed.");
        });
        if (!stat) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("Redaction refuses symbolic links.");
        const tasks = NodePath.join(session, "tasks");
        const taskStat = await NodeFSP.lstat(tasks).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw new Error("Redaction task inventory failed.");
        });
        if (!taskStat) continue;
        if (!taskStat.isDirectory() || taskStat.isSymbolicLink())
          throw new Error("Redaction refuses symbolic links.");
        for (const file of (await filesBelow(tasks)).filter((file) => file.endsWith(".output")))
          result.push({ path: file, sessionId, taskId: NodePath.basename(file, ".output") });
      }
    }
  }
  return [...new Map(result.map((entry) => [entry.path, entry])).values()];
}

export async function providerOutputs(file: string, itemId: string): Promise<string[]> {
  return (await providerResult(file, itemId)).outputs;
}

/** Scan physical SQLite/WAL bytes without retaining a whole database in memory. */
export async function countFile(
  file: string,
  needles: readonly string[],
  physicalSqlite = false,
): Promise<number> {
  if (!physicalSqlite) {
    try {
      return (file.endsWith(".jsonl") ? replaceText : replaceScalarText)(
        await readTextFile(file),
        needles,
        "[verification]",
      ).count;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      // oxlint-disable-next-line preserve-caught-error -- Native causes may retain original content.
      throw new Error("Redaction file verification failed.");
    }
  }
  const { createReadStream } = await import("node:fs");
  let maxBackslashes = 0;
  let run = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      for (const byte of chunk) {
        run = byte === 92 ? run + 1 : 0;
        maxBackslashes = Math.max(maxBackslashes, run);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    // oxlint-disable-next-line preserve-caught-error -- Native causes must not retain redacted content.
    throw new Error("Redaction physical verification failed.");
  }
  const variants = escapedNeedles(needles, maxBackslashes).map((n) => Buffer.from(n));
  const overlap = Math.max(0, ...variants.map((n) => n.length - 1));
  let tail = Buffer.alloc(0);
  let count = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      const bytes = Buffer.concat([tail, chunk]);
      for (const needle of variants) {
        let from = 0;
        while (true) {
          const at = bytes.indexOf(needle, from);
          if (at < 0) break;
          if (at + needle.length > tail.length) count++;
          from = at + needle.length;
        }
      }
      tail = bytes.subarray(Math.max(0, bytes.length - overlap));
    }
    return count;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    // oxlint-disable-next-line preserve-caught-error -- Underlying errors must never retain redacted content.
    throw new Error("Redaction physical verification failed.");
  }
}
