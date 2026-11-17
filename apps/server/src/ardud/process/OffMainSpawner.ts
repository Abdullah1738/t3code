// @effect-diagnostics globalDate:off -- native process-group grace must elapse during Effect TestClock suspension and shutdown.
// @effect-diagnostics globalDateInEffect:off -- same bounded native callback deadline.
// @effect-diagnostics globalTimers:off -- native process-group polling is independent of the Effect scheduler.
// @effect-diagnostics nodeBuiltinImport:off -- Node process/stream adapter; native spawn runs in its owned worker.
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSink from "@effect/platform-node/NodeSink";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { SpawnClient } from "./SpawnClient.ts";

const platformError = (method: string, cause: unknown) =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag:
        (cause as NodeJS.ErrnoException)?.code === "ENOENT"
          ? "NotFound"
          : (cause as NodeJS.ErrnoException)?.code === "EACCES"
            ? "PermissionDenied"
            : "Unknown",
      module: "ChildProcess",
      method,
      cause,
    }),
  );

const terminate = (
  child: ReturnType<SpawnClient["spawn"]>,
  killOptions: ChildProcess.KillOptions,
) =>
  Effect.callback<void, PlatformError.PlatformError>((resume) => {
    // Cancellation is independent of the worker's spawn queue. Match the Node
    // spawner's process-group grace and optional escalation bounds.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const deadline =
      Date.now() +
      (killOptions.forceKillAfter === undefined
        ? 1000
        : Duration.toMillis(Duration.fromInputUnsafe(killOptions.forceKillAfter)));
    let escalated = false;
    const finish = () => {
      stopped = true;
      clearTimeout(timer);
      resume(Effect.void);
    };
    const alive = () => {
      try {
        return child.signal(0);
      } catch {
        return false;
      }
    };
    const poll = () => {
      if (stopped) return;
      if (!child.isRunning() && !alive()) {
        finish();
        return;
      }
      if (Date.now() >= deadline && !escalated) {
        if (killOptions.forceKillAfter === undefined) {
          void child.exit.then(finish, finish);
          return;
        }
        escalated = true;
        try {
          child.signal("SIGKILL");
        } catch {
          /* The leader may have exited. */
        }
        timer = setTimeout(() => {
          void child.exit.then(finish, finish);
        }, 1000);
        return;
      }
      timer = setTimeout(poll, 10);
    };
    try {
      child.signal(killOptions.killSignal ?? "SIGTERM");
    } catch (cause) {
      resume(Effect.fail(platformError("kill", cause)));
      return;
    }
    poll();
    return Effect.sync(() => {
      stopped = true;
      clearTimeout(timer);
    });
  });

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const fallback = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new SpawnClient()),
    (client) => Effect.promise(() => client.close()),
  );
  return ChildProcessSpawner.make(
    Effect.fn("OffMainSpawner.spawn")(function* (command) {
      // Preserve the platform implementation for pipelines, custom descriptors and
      // supplied stream/sink configurations. The hot Git/JSON commands use defaults.
      if (platform === "win32" || command._tag !== "StandardCommand")
        return yield* fallback.spawn(command);
      const options = command.options;
      const stdin = options.stdin;
      const stdoutConfig = options.stdout;
      const stderrConfig = options.stderr;
      if (
        options.additionalFds !== undefined ||
        options.detached === false ||
        Stream.isStream(stdin) ||
        Sink.isSink(stdoutConfig) ||
        Sink.isSink(stderrConfig)
      )
        return yield* fallback.spawn(command);
      const stdinConfig: ChildProcess.StdinConfig | undefined =
        typeof stdin === "string" ? { stream: stdin } : stdin;
      const input = stdinConfig?.stream ?? "pipe";
      const output =
        typeof stdoutConfig === "string" ? stdoutConfig : (stdoutConfig?.stream ?? "pipe");
      const errorOutput =
        typeof stderrConfig === "string" ? stderrConfig : (stderrConfig?.stream ?? "pipe");
      if (Stream.isStream(input) || Sink.isSink(output) || Sink.isSink(errorOutput))
        return yield* fallback.spawn(command);
      if (options.cwd !== undefined) yield* fs.access(options.cwd);
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          client.spawn(command.command, command.args, {
            cwd: options.cwd === undefined ? undefined : path.resolve(options.cwd),
            env: options.extendEnv
              ? { ...process.env, ...options.env }
              : (options.env ?? { ...process.env }),
            detached: true,
            shell: options.shell,
            killSignal: options.killSignal,
            windowsHide: options.windowsHide ?? false,
            stdio: [input, output, errorOutput],
          }),
        ),
        (child) =>
          Effect.gen(function* () {
            if (!child.hasStarted()) child.cancel();
            else if (child.isReferenced() || child.hasFailed())
              yield* terminate(child, options).pipe(Effect.ignore);
            if (child.isReferenced()) child.dispose();
          }),
      );
      const pid = yield* Effect.callback<number, PlatformError.PlatformError>((resume) => {
        void child.started.then(
          (pid) => resume(Effect.succeed(pid)),
          (cause) => resume(Effect.fail(platformError("spawn", cause))),
        );
        return Effect.sync(child.cancel);
      });
      const stdout = NodeStream.fromReadable({
        evaluate: () => child.stdout,
        onError: (cause) => platformError("stdout", cause),
      });
      const stderr = NodeStream.fromReadable({
        evaluate: () => child.stderr,
        onError: (cause) => platformError("stderr", cause),
      });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.tryPromise({
          try: () => child.exit,
          catch: (cause) => platformError("exitCode", cause),
        }).pipe(
          Effect.flatMap(([code, signal]) =>
            code === null
              ? Effect.fail(platformError("exitCode", new Error(`Process interrupted: ${signal}`)))
              : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          ),
        ),
        isRunning: Effect.sync(child.isRunning),
        kill: (killOptions) => terminate(child, killOptions ?? {}),
        unref: Effect.sync(() => {
          child.unref();
          return Effect.sync(child.ref);
        }),
        stdin:
          input !== "pipe"
            ? Sink.drain
            : NodeSink.fromWritable({
                evaluate: () => child.stdin,
                onError: (cause) => platformError("stdin", cause),
                ...(stdinConfig === undefined
                  ? {}
                  : { endOnDone: stdinConfig.endOnDone, encoding: stdinConfig.encoding }),
              }),
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
});

export const layer = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, make);
