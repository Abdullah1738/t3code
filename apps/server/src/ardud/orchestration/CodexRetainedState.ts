import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

// Long enough for an async child to return, without keeping abandoned hosts forever.
export const CODEX_RETAINED_STATE_IDLE_CAP_MS = 30 * 60 * 1_000;
const READ_LIMIT = 8 * 1024 * 1024;
const LINE_LIMIT = 2 * 1024 * 1024;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const parse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
const short = (value: string) => value.slice(0, 160).replaceAll(/[\r\n]/g, " ");

export function makeCodexRetainedItems() {
  const cells = new Map<string, { origin: string; sessions: string[] }>();
  const sessions = new Set<string>();
  const calls = new Map<string, { cell?: string; sessions: string[] }>();
  const nested = new Map<string, string>();
  let uncertain = false;

  const observe = (value: unknown) => {
    const item = record(value);
    if (!item) return;
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    if ((item.type === "function_call" || item.type === "custom_tool_call") && callId) {
      const name = typeof item.name === "string" ? item.name.split(".").at(-1) : undefined;
      const args = typeof item.arguments === "string" ? record(parse(item.arguments)) : undefined;
      const cell = name === "wait" && typeof args?.cell_id === "string" ? args.cell_id : undefined;
      // Source text cannot prove a nested write_stdin executed. Only a native
      // tool invocation identifies which session a terminal result consumed.
      const ids: string[] = [];
      if (
        name === "write_stdin" &&
        (typeof args?.session_id === "number" || typeof args?.session_id === "string")
      )
        ids.push(String(args.session_id));
      calls.set(callId, {
        ...(cell ? { cell } : {}),
        sessions: [...new Set([...ids, ...(cell ? (cells.get(cell)?.sessions ?? []) : [])])],
      });
      return;
    }
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") return;
    const readParts = (output: unknown, depth = 0): string[] => {
      if (depth > 8) {
        uncertain = true;
        return [];
      }
      if (typeof output === "string") {
        const decoded = parse(output);
        if (Array.isArray(decoded) || record(decoded)) return readParts(decoded, depth + 1);
        return [output];
      }
      if (Array.isArray(output)) return output.flatMap((part) => readParts(part, depth + 1));
      const part = record(output);
      // text(await Promise.all(...)) serializes exec receipts as an object array.
      // Keep the receipt intact; its stdout is never walked for more receipts.
      if (typeof part?.chunk_id === "string") return [JSON.stringify(part)];
      if (part?.type === "input_text" && typeof part.text === "string")
        return readParts(part.text, depth + 1);
      // Promise.allSettled and callers' structured envelopes can wrap receipts.
      // Never treat an envelope's stdout fields as further tool metadata.
      return Object.entries(part ?? {}).flatMap(([key, value]) => {
        if (key === "output" || key === "stdout" || key === "stderr") return [];
        if (Array.isArray(value) || record(value)) return readParts(value, depth + 1);
        if (typeof value === "string" && (Array.isArray(parse(value)) || record(parse(value))))
          return readParts(value, depth + 1);
        return [];
      });
    };
    const parts = readParts(item.output);
    const text = parts.join("\n");
    const yielded = /^Script running with cell ID ([\w:-]+)$/m.exec(text)?.[1];
    const original = [...cells.values()].find((cell) => cell.origin === callId);
    const call =
      (callId ? calls.get(callId) : undefined) ??
      (original ? { sessions: original.sessions, cell: undefined } : undefined);
    if (yielded) cells.set(yielded, { origin: callId ?? "exec", sessions: call?.sessions ?? [] });
    if (
      !yielded &&
      /^(?:Script completed|Script failed|Script terminated|Script error:|cell \S+ (?:belongs|not found))/m.test(
        text,
      )
    ) {
      if (call?.cell) cells.delete(call.cell);
      if (callId) for (const [id, cell] of cells) if (cell.origin === callId) cells.delete(id);
    }
    const yieldedSessions = new Set<string>();
    let terminalSession = false;
    for (const part of parts) {
      const id = /^Process running with session ID (\d+)$/m.exec(part)?.[1];
      if (id) yieldedSessions.add(id);
      const result = record(parse(part));
      if (result && typeof result.chunk_id === "string") {
        if (typeof result.session_id === "number" || typeof result.session_id === "string")
          yieldedSessions.add(String(result.session_id));
        terminalSession ||= typeof result.exit_code === "number";
      }
      terminalSession ||= /^Process exited with code -?\d+$/m.test(part);
    }
    for (const id of yieldedSessions) sessions.add(id);
    if (!yielded && terminalSession && call?.sessions.length === 1)
      for (const id of call?.sessions ?? []) if (!yieldedSessions.has(id)) sessions.delete(id);
    if (callId) calls.delete(callId);
  };
  const observeNested = (item: {
    id: string;
    tool: string;
    arguments: unknown;
    status: string;
  }) => {
    // Codex prefixes code-mode nested MCP items with exec-. Ordinary tools
    // keep their existing turn-terminalization semantics.
    if (!item.id.startsWith("exec-")) return;
    if (item.status !== "inProgress") {
      nested.delete(item.id);
      return;
    }
    const args = record(item.arguments);
    const key =
      typeof args?.clientRequestId === "string"
        ? ` clientRequestId=${short(args.clientRequestId)}`
        : "";
    const number =
      args?.pullRequestNumber ??
      args?.prNumber ??
      (typeof args?.url === "string" ? /\/pull\/(\d+)/.exec(args.url)?.[1] : undefined);
    const pr =
      typeof number === "number" || typeof number === "string"
        ? ` PR #${short(String(number))}`
        : "";
    nested.set(item.id, `${short(item.tool)}${key}${pr}`);
  };
  // A dangling nested item alone can be a tool Codex already abandoned at
  // turn end. It labels a known cell loss, but does not prove a cell exists.
  const hasItems = () => cells.size > 0 || sessions.size > 0 || uncertain;
  const takeLoss = () => {
    if (!hasItems()) {
      calls.clear();
      nested.clear();
      return undefined;
    }
    const lines = [
      "Codex thread unloaded; retained state was lost:",
      ...[...cells.keys()].map((id) => `- Cell ${id} (exec result not consumed)`),
      ...[...sessions].map((id) => `- Exec session ${id} (may have unread output)`),
      ...[...nested.values()].map((label) => `- Pending call: ${label}`),
      ...(uncertain ? ["- Additional retained state could not be read completely."] : []),
      "The cell is gone; these calls may or may not have run, so check their result (same clientRequestId, task_status, list_thread_pull_requests) before retrying. Any output left in these exec sessions is no longer available; check saved files or command effects before rerunning.",
    ];
    cells.clear();
    sessions.clear();
    nested.clear();
    calls.clear();
    uncertain = false;
    return lines.join("\n");
  };
  return {
    observe,
    observeNested,
    hasItems,
    takeLoss,
    markUncertain: () => {
      uncertain = true;
    },
  };
}

export const make = Effect.fn("CodexRetainedState.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const permit = yield* Semaphore.make(1);
  const threads = new Map<
    string,
    {
      path?: string;
      offset: bigint;
      remainder: string;
      decoder: InstanceType<typeof TextDecoder>;
      closed?: boolean;
      idleAt?: number;
      items: ReturnType<typeof makeCodexRetainedItems>;
    }
  >();
  const get = (id: string) => {
    let state = threads.get(id);
    if (!state) {
      state = {
        offset: 0n,
        remainder: "",
        decoder: new TextDecoder(),
        items: makeCodexRetainedItems(),
      };
      threads.set(id, state);
    }
    return state;
  };
  const register = Effect.fn("CodexRetainedState.register")(function* (
    id: string,
    path: string | null | undefined,
  ) {
    const state = get(id);
    if (!path || (state.path && !state.closed)) return;
    // Resume starts a new host: historical cells belong to restart recovery (#876).
    const info = yield* fs.stat(path).pipe(Effect.option);
    if (Option.isNone(info)) return;
    state.path = path;
    state.offset = info.value.size;
    state.remainder = "";
    state.decoder = new TextDecoder();
  });
  const refresh = Effect.fn("CodexRetainedState.refresh")(function* (id: string) {
    const state = get(id);
    if (!state.path || state.closed) return;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(state.path!, { flag: "r" });
        const size = (yield* file.stat).size;
        if (size < state.offset) {
          state.items.markUncertain();
          return;
        }
        yield* file.seek(state.offset, "start");
        let remaining = READ_LIMIT;
        while (remaining > 0 && state.offset < size) {
          const bytes = yield* file.readAlloc(Math.min(64 * 1024, remaining));
          if (Option.isNone(bytes)) break;
          state.offset += BigInt(bytes.value.byteLength);
          remaining -= bytes.value.byteLength;
          const lines = (
            state.remainder + state.decoder.decode(bytes.value, { stream: true })
          ).split("\n");
          state.remainder = lines.pop() ?? "";
          for (const line of lines) {
            const entry = record(parse(line));
            if (entry?.type === "response_item") state.items.observe(entry.payload);
          }
          if (state.remainder.length > LINE_LIMIT) {
            state.items.markUncertain();
            state.remainder = "";
          }
        }
        if (state.offset < size) state.items.markUncertain();
      }),
    ).pipe(Effect.catchCause(() => Effect.sync(state.items.markUncertain)));
  }, permit.withPermit);
  const holds = Effect.fn("CodexRetainedState.holds")(function* (id: string) {
    const state = get(id);
    const now = yield* Clock.currentTimeMillis;
    return (
      (state.items.hasItems() || state.remainder.length > 0) &&
      (state.idleAt === undefined || now - state.idleAt < CODEX_RETAINED_STATE_IDLE_CAP_MS)
    );
  });
  return {
    register,
    refresh,
    holds,
    observe: (id: string, item: unknown) => {
      if (!get(id).closed) get(id).items.observe(item);
    },
    observeNested: (
      id: string,
      item: Parameters<ReturnType<typeof makeCodexRetainedItems>["observeNested"]>[0],
    ) => {
      if (!get(id).closed) get(id).items.observeNested(item);
    },
    active: (id: string) => {
      delete get(id).idleAt;
      delete get(id).closed;
    },
    idle: Effect.fn("CodexRetainedState.idle")(function* (id: string) {
      get(id).idleAt = yield* Clock.currentTimeMillis;
      yield* refresh(id);
    }),
    takeLoss: Effect.fn("CodexRetainedState.takeLoss")(function* (id: string) {
      yield* refresh(id);
      const state = get(id);
      state.closed = true;
      if (state.remainder.length > 0) state.items.markUncertain();
      state.remainder = "";
      return state.items.takeLoss();
    }),
  };
});
