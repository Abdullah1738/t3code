import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

it.effect.each(["subagent-results", "delegated-completions"] as const)(
  "discovers %s on the background reader while the writer is held",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "delegated-recovery-reader-",
        });
        const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"));
        const dependencies = ProjectionStore.layer.pipe(Layer.provideMerge(database));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const spans: Tracer.Span[] = [];
          const observe: Statement.Transformer = (statement, _sql, _fiber, span) =>
            Effect.sync(() => {
              spans.push(span);
              return statement;
            });
          yield* Effect.acquireUseRelease(
            sql
              .withTransaction(
                Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
              )
              .pipe(Effect.forkChild),
            () =>
              Effect.gen(function* () {
                yield* Deferred.await(held);
                const ids = yield* projections
                  .getRecoveryThreadIds(kind)
                  .pipe(
                    Effect.provideService(Statement.CurrentTransformer, observe),
                    Effect.provideService(Statement.SpanPropagationEnabled, true),
                    NodeSqliteClient.foregroundReads,
                  );
                assert.deepEqual(ids, []);
                assert.lengthOf(spans, 1);
                assert.equal(spans[0]?.attributes.get("db.connection"), "reader");
                assert.equal(spans[0]?.attributes.get("db.reader.lane"), "background");
              }),
            (fiber) => Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(fiber))),
          );
        }).pipe(Effect.provide(dependencies));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
