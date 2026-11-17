import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitExecRate from "./GitExecRate.ts";
import * as VcsProcess from "./VcsProcess.ts";

it.effect("aggregates actual Git attempts into one private, bounded event each minute", () => {
  const events: AnalyticsEvent[] = [];
  const analytics = Layer.mock(Analytics.Analytics)({
    record: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  });
  return Effect.gen(function* () {
    const rate = yield* GitExecRate.GitExecRate;
    const process = yield* VcsProcess.make.pipe(
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: () =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(0),
              stdout: "",
              stderr: "",
              timedOut: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
    );
    const input = {
      operation: "GitManager.test",
      command: "git",
      args: ["-c", "private=secret", "-C", "/private/repo", "config", "--get", "remote.origin.url"],
      cwd: "/private/repo",
    };
    yield* Effect.all(
      Array.from({ length: 12 }, () => process.run(input)),
      { concurrency: "unbounded" },
    );
    yield* process.run({ ...input, command: "gh" });
    assert.lengthOf(events, 0);
    yield* TestClock.adjust("1 second");
    for (let i = 0; i < 25; i++)
      yield* rate.record({
        operation: `GitManager.test${i}`,
        args: ["--git-dir=/private/dir", "for-each-ref"],
        cwd: `/private/${i}`,
      });
    yield* TestClock.adjust("59 seconds");
    assert.lengthOf(events, 1);
    const event = events[0]!;
    assert.equal(event.kind, "vcs.git_exec_rate");
    assert.equal(event.props?.total, 37);
    assert.equal(event.props?.maxPerSecond, 25);
    assert.equal(event.props?.distinctCwds, 26);
    assert.equal(event.props?.windowMs, 60_000);
    assert.lengthOf(event.props?.top ?? [], 20);
    assert.deepInclude(event.props?.top?.[0], {
      operation: "GitManager.test",
      subcommand: "config",
      count: 12,
    });
    assert.notInclude(JSON.stringify(event), "private");
    assert.notInclude(JSON.stringify(event), "secret");
    yield* Schema.decodeUnknownEffect(AnalyticsEvent)(event);
    yield* TestClock.adjust("1 minute");
    assert.lengthOf(events, 2);
    assert.equal(events[1]?.props?.total, 0);
    assert.equal(events[1]?.props?.maxPerSecond, 0);
  }).pipe(
    Effect.provide(GitExecRate.layer.pipe(Layer.provide(analytics))),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(NodeServices.layer),
  );
});
