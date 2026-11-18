// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { describe, it } from "@effect/vitest";
import { expect, afterEach } from "vite-plus/test";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HttpClient, HttpClientResponse } from "effect/http";
import { runBackendProcess } from "./DesktopBackendManager.ts";
import {
  captureBackendProcess,
  forceKillCapturedBackends,
  setBackendProcessReporter,
  waitForBackendShutdown,
  type BackendProcessAction,
} from "./DesktopBackendProcess.ts";

afterEach(() => {
  forceKillCapturedBackends();
  setBackendProcessReporter(() => {});
});

describe("desktop backend shutdown", () => {
  it.live.each([true, false])(
    "observes real backend exit before allowing quit (wedged=%s)",
    (wedged) =>
      Effect.gen(function* () {
        const actions: BackendProcessAction[] = [];
        setBackendProcessReporter((event) => actions.push(event));
        const ready = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        let pid: number | undefined;
        const script = wedged
          ? 'process.on("SIGTERM", () => {}); process.stdout.write("ready", () => { while(true) {} });'
          : 'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready"); setInterval(() => {}, 1000);';
        const program = runBackendProcess({
          executablePath: process.execPath,
          entryPath: "test-child",
          cwd: process.cwd(),
          args: ["-e", script],
          env: {},
          extendEnv: true,
          manageProcessShutdown: true,
          terminateGraceMs: 80,
          captureOutput: true,
          bootstrapDelivery: "stdin",
          bootstrap: {
            mode: "desktop",
            noBrowser: true,
            port: 1,
            host: "127.0.0.1",
            t3Home: "/unused-test-home",
            desktopBootstrapToken: "test",
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          },
          preflightFailure: Option.none(),
          httpBaseUrl: new URL("http://127.0.0.1:1"),
          desktopTelemetryStream: Stream.empty,
          onStarted: (value) =>
            Effect.sync(() => {
              pid = value;
            }),
          onOutput: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
        }).pipe(
          Scope.provide(scope),
          Effect.provide(NodeServices.layer),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
              ),
            ),
          ),
          Effect.exit,
        );
        const running = yield* Effect.forkChild(program);
        yield* Effect.gen(function* () {
          yield* Effect.raceFirst(
            Deferred.await(ready),
            Fiber.join(running).pipe(Effect.andThen(Effect.die("Backend exited before readiness"))),
          );
          const start = performance.now();
          let shutdownFinished!: () => void;
          const shutdown = new Promise<void>((resolve) => {
            shutdownFinished = resolve;
          });
          const closing = yield* Scope.close(scope, Exit.void).pipe(
            Effect.ensuring(Effect.sync(() => shutdownFinished())),
            Effect.forkDetach,
          );
          yield* Effect.promise(() => waitForBackendShutdown(shutdown, 2000));
          const allowQuit = () => {
            expect(() => process.kill(pid!, 0)).toThrowError(
              expect.objectContaining({ code: "ESRCH" }),
            );
          };
          allowQuit();
          expect(performance.now() - start).toBeLessThan(2000);
          expect(actions.some((event) => event.signals.includes("SIGKILL"))).toBe(wedged);
          yield* Fiber.join(closing);
          yield* Fiber.join(running);
        }).pipe(
          Effect.ensuring(
            Effect.sync(forceKillCapturedBackends).pipe(
              Effect.andThen(Scope.close(scope, Exit.void)),
            ),
          ),
        );
      }),
    5000,
  );

  it("kills the captured child synchronously when the shutdown deadline expires", async () => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["-e", 'process.send("ready"); while(true) {}'],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const exit = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once("exit", (_code, signal) => resolve(signal));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
    });
    captureBackendProcess(child.pid!, exit);
    await waitForBackendShutdown(new Promise(() => {}), 10);
    const signal = await exit;
    expect(signal).toBe("SIGKILL");
    expect(() => process.kill(child.pid!, 0)).toThrowError(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });
});
