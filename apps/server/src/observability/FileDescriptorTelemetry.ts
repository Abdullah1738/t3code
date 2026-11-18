// @effect-diagnostics nodeBuiltinImport:off - reads this process's native descriptor table and resource limits.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";

const Limit = Schema.Union([Schema.Number, Schema.Literal("unlimited")]);
const ReportLimits = Schema.Struct({
  userLimits: Schema.Struct({
    open_files: Schema.Struct({ soft: Limit, hard: Limit }),
  }),
});

const decodeReportLimits = Schema.decodeUnknownSync(ReportLimits);

export interface FileDescriptorLimits {
  readonly soft: number | "unlimited" | null;
  readonly hard: number | "unlimited" | null;
}

export interface FileDescriptorTelemetry {
  readonly limits: Effect.Effect<FileDescriptorLimits>;
  readonly count: Effect.Effect<number | null>;
}

export const parseLimits = (report: unknown): FileDescriptorLimits =>
  decodeReportLimits(report).userLimits.open_files;

// getReport reads the effective getrlimit values after Node's startup adjustment.
// Only retain the limits: the rest of the report includes environment and handle data.
const limits = Effect.try(() => parseLimits(process.report.getReport())).pipe(
  Effect.orElseSucceed(() => ({ soft: null, hard: null })),
);

export const descriptorDirectory = (platform: NodeJS.Platform) =>
  platform === "darwin" ? "/dev/fd" : platform === "linux" ? "/proc/self/fd" : undefined;

export const countDescriptors = (entries: ReadonlyArray<string>) =>
  entries.filter((entry) => /^\d+$/.test(entry)).length;

export const nodeTelemetry = Effect.gen(function* () {
  const directory = descriptorDirectory(yield* HostProcess.Platform);
  return {
    limits,
    count:
      directory === undefined
        ? Effect.succeed(null)
        : Effect.tryPromise(async () => countDescriptors(await NodeFSP.readdir(directory))).pipe(
            Effect.orElseSucceed(() => null),
          ),
  } satisfies FileDescriptorTelemetry;
});
