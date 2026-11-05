// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous hashes avoid a new runtime service for claim-file paths.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import { postCutoverSelectionProblem } from "@t3tools/client-runtime/ardud/models/harnessRouting";
import type { ModelSelection } from "@t3tools/contracts";

const Claims = Schema.Struct({
  version: Schema.Literal(1),
  interruptedThreads: Schema.Array(
    Schema.Struct({ threadId: Schema.String, runId: Schema.String }),
  ),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Claims));
const decodeCutover = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1) })),
);
const ExemptionJson = Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), threadId: Schema.String }));
const decodeExemption = Schema.decodeUnknownEffect(ExemptionJson);
const encodeExemption = Schema.encodeEffect(ExemptionJson);

const exemptionFile = Effect.fn("HarnessCutover.exemptionFile")(function* (threadId: string) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const digest = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
  return path.join(config.stateDir, "harness-cutover-exemptions", `${digest}.json`);
});

export const cutoverThreadReleased = Effect.fn("HarnessCutover.threadReleased")(function* (
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const record = yield* fs
    .readFileString(yield* exemptionFile(threadId))
    .pipe(Effect.flatMap(decodeExemption), Effect.result);
  return record._tag === "Success" && record.success.threadId === threadId;
});

export const releaseCutoverThread = Effect.fn("HarnessCutover.releaseThread")(function* (
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* exemptionFile(threadId);
  const root = path.dirname(target);
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
  const temporary = yield* fs.makeTempFileScoped({ directory: root, prefix: ".pending-" });
  yield* fs.chmod(temporary, 0o600);
  const handle = yield* fs.open(temporary, { flag: "w", mode: 0o600 });
  yield* handle.writeAll(Buffer.from(yield* encodeExemption({ version: 1, threadId }), "utf8"));
  yield* handle.sync;
  yield* fs.rename(temporary, target);
  const directory = yield* fs.open(root, { flag: "r" });
  yield* directory.sync;
}, Effect.scoped);

export const cutoverAdmissionHeld = Effect.fn("HarnessCutover.admissionHeld")(function* (
  threadId: string,
  selection: ModelSelection,
) {
  if (yield* cutoverThreadReleased(threadId)) return false;
  if (
    !["claudeAgent", "codex", "codex-cu"].includes(selection.instanceId) &&
    postCutoverSelectionProblem(selection) === null
  )
    return false;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const input = path.join(config.baseDir, "harness-cutover-input.json");
  if (!(yield* fs.exists(input).pipe(Effect.orElseSucceed(() => true)))) return false;
  const prepared = yield* fs
    .readFileString(input)
    .pipe(Effect.flatMap(decodeCutover), Effect.result);
  if (prepared._tag === "Failure") return true;
  const released = path.join(config.stateDir, "harness-cutover-released.json");
  const release = yield* fs
    .readFileString(released)
    .pipe(Effect.flatMap(decodeCutover), Effect.result);
  return release._tag === "Failure";
});

/** The installer writes claims before restart, closing the gap before the post-ready job runs. */
export const preparedCutoverOwns = Effect.fn("HarnessCutover.preparedClaim")(function* (
  threadId: string,
  runId: string,
) {
  if (yield* cutoverThreadReleased(threadId)) return false;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(config.baseDir, "harness-cutover-input.json");
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => true)))) return false;
  const input = yield* fs.readFileString(file).pipe(Effect.flatMap(decode), Effect.result);
  // An unreadable preparation file must not cause a second continuation producer to take over.
  if (input._tag === "Failure") return true;
  return input.success.interruptedThreads.some(
    (row) => row.threadId === threadId && row.runId === runId,
  );
});
