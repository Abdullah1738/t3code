import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import { CUTOVER_BRIEF_BYTE_LIMIT, cutoverBriefBytes } from "./CutoverBrief.ts";

export class CutoverContextError extends Schema.TaggedError<CutoverContextError>()(
  "CutoverContextError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["storage", "conflict", "ambiguous", "budget"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "ambiguous"
      ? "Harness carry-on context belongs to another run; reconcile its delivery before continuing."
      : `Harness carry-on context failed during ${this.operation} (${this.reason}).`;
  }
}

export class CutoverContext extends Context.Service<
  CutoverContext,
  {
    readonly put: (input: {
      readonly threadId: string;
      readonly targetInstance: string;
      readonly text: string;
      readonly refreshPending?: boolean;
    }) => Effect.Effect<void, CutoverContextError>;
    readonly read: (input: {
      readonly threadId: string;
      readonly targetInstance: string;
      readonly runId: string;
    }) => Effect.Effect<string | null, CutoverContextError>;
    readonly accepted: (input: {
      readonly threadId: string;
      readonly runId: string;
    }) => Effect.Effect<void, CutoverContextError>;
    readonly refused: (input: {
      readonly threadId: string;
      readonly runId: string;
    }) => Effect.Effect<void, CutoverContextError>;
    readonly remove: (threadId: string) => Effect.Effect<void, CutoverContextError>;
    readonly status: (
      threadId: string,
    ) => Effect.Effect<"missing" | "pending" | "claimed" | "accepted", CutoverContextError>;
  }
>()("t3/ardud/harness-migrate/CutoverContext") {}

const Record = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  targetInstance: Schema.String,
  text: Schema.String,
  status: Schema.Literals(["pending", "claimed", "accepted"]),
  runId: Schema.NullOr(Schema.String),
});
type Record = typeof Record.Type;
const JsonRecord = Schema.fromJsonString(Record);
const decode = Schema.decodeUnknownEffect(JsonRecord);
const encode = Schema.encodeEffect(JsonRecord);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const root = path.join(config.stateDir, "harness-cutover-context");
  // One shared service per server home serializes the job and provider-turn claims.
  const lock = yield* Semaphore.make(1);
  const storage = (operation: string) => (cause: unknown) =>
    new CutoverContextError({ operation, reason: "storage", cause });
  const file = Effect.fn("CutoverContext.path")(function* (threadId: string) {
    const digest = yield* crypto
      .digest("SHA-256", Buffer.from(threadId))
      .pipe(Effect.mapError(storage("path")));
    return path.join(root, `${Buffer.from(digest).toString("hex")}.json`);
  });
  const load = Effect.fn("CutoverContext.load")(function* (threadId: string) {
    const target = yield* file(threadId);
    if (!(yield* fs.exists(target).pipe(Effect.mapError(storage("exists"))))) return null;
    const record = yield* fs
      .readFileString(target)
      .pipe(Effect.flatMap(decode), Effect.mapError(storage("read")));
    if (record.threadId !== threadId)
      return yield* new CutoverContextError({ operation: "read", reason: "conflict" });
    return record;
  });
  const save = Effect.fn("CutoverContext.save")(
    function* (record: Record) {
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      const temporary = yield* fs.makeTempFileScoped({ directory: root, prefix: ".pending-" });
      const handle = yield* fs.open(temporary, { flag: "w", mode: 0o600 });
      yield* handle.writeAll(Buffer.from(yield* encode(record), "utf8"));
      yield* handle.sync;
      yield* fs.rename(temporary, yield* file(record.threadId));
      const directory = yield* fs.open(root, { flag: "r" });
      yield* directory.sync;
    },
    Effect.scoped,
    Effect.mapError(storage("write")),
  );
  const put = Effect.fn("CutoverContext.put")(function* (input: {
    readonly threadId: string;
    readonly targetInstance: string;
    readonly text: string;
    readonly refreshPending?: boolean;
  }) {
    if (!input.text.trim() || cutoverBriefBytes(input.text) > CUTOVER_BRIEF_BYTE_LIMIT) {
      return yield* new CutoverContextError({ operation: "put", reason: "budget" });
    }
    const current = yield* load(input.threadId);
    if (current !== null) {
      if (current.targetInstance === input.targetInstance && current.text === input.text) return;
      if (
        input.refreshPending === true &&
        current.targetInstance === input.targetInstance &&
        current.status === "pending" &&
        current.runId === null
      ) {
        yield* save({ ...current, text: input.text });
        return;
      }
      return yield* new CutoverContextError({ operation: "put", reason: "conflict" });
    }
    yield* save({ ...input, version: 1, status: "pending", runId: null });
  }, lock.withPermits(1));
  const read = Effect.fn("CutoverContext.read")(function* (input: {
    readonly threadId: string;
    readonly targetInstance: string;
    readonly runId: string;
  }) {
    const current = yield* load(input.threadId);
    if (
      current === null ||
      current.targetInstance !== input.targetInstance ||
      current.status === "accepted"
    )
      return null;
    if (current.runId !== null && current.runId !== input.runId) {
      return yield* new CutoverContextError({ operation: "read", reason: "ambiguous" });
    }
    if (current.status === "pending")
      yield* save({ ...current, status: "claimed", runId: input.runId });
    return current.text;
  }, lock.withPermits(1));
  const settle = Effect.fn("CutoverContext.settle")(function* (
    input: { readonly threadId: string; readonly runId: string },
    accepted: boolean,
  ) {
    const current = yield* load(input.threadId);
    if (current === null) return;
    if (!accepted && current.status === "pending" && current.runId === null) return;
    if (current.runId !== input.runId) {
      return yield* new CutoverContextError({
        operation: accepted ? "accepted" : "refused",
        reason: "ambiguous",
      });
    }
    if (current.status === "accepted") return;
    yield* save({
      ...current,
      status: accepted ? "accepted" : "pending",
      runId: accepted ? input.runId : null,
    });
  }, lock.withPermits(1));
  const remove = Effect.fn("CutoverContext.remove")(function* (threadId: string) {
    const target = yield* file(threadId);
    if (yield* fs.exists(target).pipe(Effect.mapError(storage("exists")))) {
      yield* fs.remove(target).pipe(Effect.mapError(storage("remove")));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs.open(root, { flag: "r" });
          yield* directory.sync;
        }),
      ).pipe(Effect.mapError(storage("remove-sync")));
    }
  }, lock.withPermits(1));
  const status = Effect.fn("CutoverContext.status")(function* (threadId: string) {
    return (yield* load(threadId))?.status ?? "missing";
  }, lock.withPermits(1));
  return CutoverContext.of({
    put,
    read,
    accepted: (input) => settle(input, true),
    refused: (input) => settle(input, false),
    remove,
    status,
  });
});

export const layer = Layer.effect(CutoverContext, make).pipe(Layer.provide(NodeCrypto.layer));
