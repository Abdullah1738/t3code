import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as OffMainSpawner from "./OffMainSpawner.ts";

const layer = OffMainSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.effect.each([
  { signal: undefined, expected: "SIGTERM" },
  { signal: "SIGUSR2" as const, expected: "SIGUSR2" },
])(
  "uses the explicit kill options independently of command cleanup ($expected)",
  ({ signal, expected }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const ready = yield* Deferred.make<void>();
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "-e",
            `
      for(const signal of ['SIGTERM','SIGUSR1','SIGUSR2'])
        process.on(signal,()=>{process.stdout.write(signal);process.exit(0)});
      process.stdout.write('ready');setInterval(()=>{},1000);
    `,
          ],
          { killSignal: "SIGUSR1" },
        ),
      );
      let output = "";
      const reader = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            output += chunk;
            if (output.includes("ready")) yield* Deferred.succeed(ready, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      yield* child.kill(signal === undefined ? undefined : { killSignal: signal });
      yield* Fiber.join(reader);
      assert.strictEqual(output, `ready${expected}`);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["ignore", "inherit"] as const)("drains writes when stdin is $0", (stdin) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", ""], { stdin }));
    yield* Stream.run(Stream.encodeText(Stream.make("discarded")), child.stdin);
    assert.strictEqual(yield* child.exitCode, 0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([
  { env: undefined, extendEnv: false, expected: "inherited" },
  { env: { SPAWN_ENV_TEST: "override" }, extendEnv: true, expected: "override" },
  { env: {}, extendEnv: false, expected: "absent" },
])("preserves per-command environment ($expected)", ({ env, extendEnv, expected }) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const before = process.env.SPAWN_ENV_TEST;
    process.env.SPAWN_ENV_TEST = "inherited";
    try {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          ["-e", "process.stdout.write(process.env.SPAWN_ENV_TEST ?? 'absent')"],
          { env, extendEnv },
        ),
      );
      const text = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
      assert.strictEqual(text, expected);
      assert.strictEqual(yield* child.exitCode, 0);
    } finally {
      if (before === undefined) delete process.env.SPAWN_ENV_TEST;
      else process.env.SPAWN_ENV_TEST = before;
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("keeps protocol stdin open between writes when endOnDone is false", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          "-e",
          `let text='';process.stdin.on('data',chunk=>{text+=chunk;if(text.length===2){process.stdout.write(text);process.exit(0)}});process.stdin.on('end',()=>process.exit(19))`,
        ],
        { stdin: { stream: "pipe", endOnDone: false } },
      ),
    );
    yield* Stream.run(Stream.encodeText(Stream.make("a")), child.stdin);
    yield* Stream.run(Stream.encodeText(Stream.make("b")), child.stdin);
    assert.strictEqual(yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString), "ab");
    assert.strictEqual(yield* child.exitCode, 0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("retains platform pipeline behavior", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, ["-e", "process.stdout.write('pipe')"]).pipe(
        ChildProcess.pipeTo(
          ChildProcess.make(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"]),
        ),
      ),
    );
    assert.strictEqual(yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString), "pipe");
    assert.strictEqual(yield* child.exitCode, 0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
