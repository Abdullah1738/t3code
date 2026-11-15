// @effect-diagnostics nodeBuiltinImport:off -- the worker transport is the boundary under test.
import * as NodeEvents from "node:events";
import * as NodeWorkerThreads from "node:worker_threads";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";
import {
  ErrorObserver,
  sqliteErrorDetails,
  type SqliteErrorContext,
} from "@t3tools/shared/nodeSqliteErrors";
import { ServerActivation } from "../../serverActivation.ts";
import { archiveCheckpointLayer, HistoryArchiveDurability } from "./archiveCheckpoint.ts";

vi.mock("node:worker_threads", () => ({ Worker: vi.fn() }));
afterEach(() => vi.resetAllMocks());

type Request = { id: number; operation: "checkpoint" | "flush-main" | "maintenance" };
class CheckpointWorker extends NodeEvents.EventEmitter {
  readonly requests: Request[] = [];
  readonly waiting: Array<(request: Request) => void> = [];
  readonly sent: Request[] = [];
  terminated = false;
  ref() {}
  unref() {}
  postMessage(request: Request) {
    this.requests.push(request);
    const receiver = this.waiting.shift();
    if (receiver) receiver(request);
    else this.sent.push(request);
  }
  next = () =>
    Effect.callback<Request>((resume) => {
      const sent = this.sent.shift();
      if (sent) resume(Effect.succeed(sent));
      else this.waiting.push((request) => resume(Effect.succeed(request)));
    });
  async terminate() {
    this.terminated = true;
    return 0;
  }
  reply(request: Request, ok: boolean, failure?: unknown) {
    this.emit("message", {
      id: request.id,
      ok,
      failure,
      file:
        request.operation === "flush-main"
          ? "/isolated/statev2.sqlite"
          : "/isolated/archive.sqlite",
    });
  }
}

it.effect(
  "queues an archive barrier behind a busy worker and records faults without restoring checkpoint backoff",
  () => {
    const worker = new CheckpointWorker();
    vi.mocked(NodeWorkerThreads.Worker).mockImplementation(function () {
      return worker as unknown as NodeWorkerThreads.Worker;
    });
    const observations: Array<{ cause: unknown; context: SqliteErrorContext }> = [];
    return Effect.gen(function* () {
      const durability = yield* HistoryArchiveDurability;
      const first = yield* durability.flushHistorySource.pipe(Effect.forkChild);
      const flush = yield* worker.next();
      assert.equal(flush.operation, "flush-main");
      const started = yield* Deferred.make<void>();
      const archive = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(durability.syncArchive),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      assert.equal(worker.requests.length, 1);
      // A live worker can report an incomplete checkpoint because a reader pins WAL.
      // That must release the queue without imposing the respawn backoff.
      worker.reply(flush, false);
      assert.isFalse(yield* Fiber.join(first));
      const checkpoint = yield* worker.next();
      assert.equal(checkpoint.operation, "checkpoint");
      worker.reply(checkpoint, false, { errcode: 779, errstr: "database disk image is malformed" });
      yield* TestClock.adjust("250 millis");
      const retry = yield* worker.next();
      worker.reply(retry, true);
      assert.isTrue(yield* Fiber.join(archive));
      assert.equal(worker.requests.length, 3);
      assert.equal(vi.mocked(NodeWorkerThreads.Worker).mock.calls.length, 1);
      assert.equal(observations.length, 1);
      assert.equal(sqliteErrorDetails(observations[0]?.cause)?.errcode, 779);
      assert.include(observations[0]?.context, {
        file: "/isolated/archive.sqlite",
        role: "primary",
        operation: "checkpoint",
        connection: "archive-checkpoint",
        span: "HistoryArchiveDurability.checkpoint",
      });
    }).pipe(
      Effect.provide(archiveCheckpointLayer("/isolated/statev2.sqlite")),
      Effect.provideService(ErrorObserver, (cause, context) =>
        observations.push({ cause, context }),
      ),
      Effect.provideService(ServerActivation, Effect.never),
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          assert.isTrue(worker.terminated);
        }),
      ),
    );
  },
);

it.effect("parks maintenance until activation, then truncates at most once per minute", () => {
  const worker = new CheckpointWorker();
  vi.mocked(NodeWorkerThreads.Worker).mockImplementation(function () {
    return worker as unknown as NodeWorkerThreads.Worker;
  });
  return Effect.gen(function* () {
    const activation = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* HistoryArchiveDurability;
        yield* TestClock.adjust("5 minutes");
        assert.equal(worker.requests.length, 0);
        yield* Deferred.succeed(activation, undefined);
        yield* TestClock.adjust("59999 millis");
        assert.equal(worker.requests.length, 0);
        yield* TestClock.adjust("1 millis");
        const first = yield* worker.next();
        assert.equal(first.operation, "maintenance");
        worker.reply(first, true);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("59999 millis");
        assert.equal(worker.requests.length, 1);
        yield* TestClock.adjust("1 millis");
        const second = yield* worker.next();
        worker.reply(second, true);
        assert.equal(worker.requests.length, 2);
      }).pipe(
        Effect.provide(archiveCheckpointLayer("/isolated/statev2.sqlite")),
        Effect.provideService(ErrorObserver, () => {}),
        Effect.provideService(ServerActivation, Deferred.await(activation)),
      ),
    );
    assert.isTrue(worker.terminated);
  });
});
