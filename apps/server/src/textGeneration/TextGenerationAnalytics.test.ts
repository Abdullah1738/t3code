import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
  type AnalyticsEvent,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as ServerConfig from "../config.ts";
import {
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import * as TextGenerationAnalytics from "./TextGenerationAnalytics.ts";

const decodeClaude = Schema.decodeSync(ClaudeSettings);
const decodeCodex = Schema.decodeSync(CodexSettings);
const Probe = Schema.Struct({ ok: Schema.Boolean });
const layer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "text-generation-acquisition-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("TextGeneration child acquisition", (it) => {
  it.effect.each([
    { name: "Claude inference", provider: "claude", targetSpawn: 1, phase: "inference" },
    { name: "Codex discovery", provider: "codex", targetSpawn: 1, phase: "discovery" },
    { name: "Codex inference", provider: "codex", targetSpawn: 2, phase: "inference" },
  ] as const)("counts cancellation during $name acquisition", ({ provider, targetSpawn, phase }) =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const releaseAcquisition = yield* Deferred.make<void>();
      const events: AnalyticsEvent[] = [];
      let spawns = 0;
      let releases = 0;
      let active = 0;
      let targetIoReads = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const current = ++spawns;
            active++;
            if (current === targetSpawn) {
              yield* Deferred.succeed(acquired, yield* Effect.fiber);
              yield* Deferred.await(releaseAcquisition);
            }
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(current),
              exitCode: Effect.sync(() => {
                if (current === targetSpawn) targetIoReads++;
                return ChildProcessSpawner.ExitCode(0);
              }),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(Stream.make("[]")),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
          () =>
            Effect.sync(() => {
              releases++;
              active--;
            }),
        ),
      );
      const generation = yield* (
        provider === "claude"
          ? makeClaudeTextGeneration(
              decodeClaude({}),
              undefined,
              Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
            )
          : makeCodexTextGeneration(decodeCodex({}))
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const instanceId = ProviderInstanceId.make(provider);
      const fiber = yield* generation.generateJson!({
        cwd: process.cwd(),
        prompt: "Reply ok",
        outputSchema: Probe,
        modelSelection: createModelSelection(
          instanceId,
          provider === "claude" ? SYNTHETIC_CLAUDE_STANDARD_MODEL : "gpt-5.4-mini",
        ),
      }).pipe(
        Effect.provideService(TextGenerationAnalytics.job, {
          provider,
          operation: "generateJson:writeGroups",
          boardId: "board-test",
        }),
        Effect.provideService(
          Analytics.Analytics,
          Analytics.Analytics.of({
            record: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            flush: Effect.void,
            ingest: () => Effect.void,
            read: () => Effect.die("unused"),
          }),
        ),
        Effect.forkScoped,
      );
      const spawningFiber = yield* Deferred.await(acquired);
      yield* Effect.sync(() => spawningFiber.interruptUnsafe());
      yield* Deferred.succeed(releaseAcquisition, undefined);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(spawns).toBe(targetSpawn);
      expect(releases).toBe(spawns);
      expect(active).toBe(0);
      expect(targetIoReads).toBe(0);
      const children = events.filter((event) => event.kind === "text-generation.child");
      expect(children).toHaveLength(spawns);
      const cancelled = children.filter((event) => event.outcome === "interrupted");
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]).toMatchObject({
        boardId: "board-test",
        props: { provider, operation: "generateJson:writeGroups", phase, count: 1 },
      });
      expect(cancelled[0]!.props).not.toHaveProperty("exitCode");
    }).pipe(Effect.scoped),
  );
});
