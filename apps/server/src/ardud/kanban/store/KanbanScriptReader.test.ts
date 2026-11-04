import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KanbanBoardId, KanbanScriptId, type KanbanScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";

import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as KanbanStore from "./KanbanStore.ts";

it.effect("reads committed script changes on the file database reader", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kanban-script-reader-" });
    const layer = KanbanStore.layer.pipe(
      Layer.provideMerge(Sqlite.layerFromPath(path.join(directory, "state.sqlite"))),
    );
    const reads: Array<Tracer.Span> = [];
    const observeReads: Statement.Transformer = (statement, _sql, _fiber, span) => {
      const [query] = statement.compile();
      if (query.includes("SELECT json FROM ardud_kanban_scripts WHERE id =")) reads.push(span);
      return Effect.succeed(statement);
    };

    yield* Effect.gen(function* () {
      const store = yield* KanbanStore.KanbanStore;
      const script: KanbanScript = {
        id: KanbanScriptId.make("script-1"),
        boardId: KanbanBoardId.make("board-1"),
        name: "Watcher",
        path: "/test/watcher.sh",
        trigger: { _tag: "manual" },
        enabled: true,
        createdBy: { _tag: "owner" },
        createdAt: "2026-10-29T00:00:00.000Z",
        lastRun: null,
      };
      const lastRun = {
        startedAt: "2026-10-29T00:01:00.000Z",
        endedAt: "2026-10-29T00:02:00.000Z",
        exitCode: 0,
      };

      yield* store.putScript(script);
      const firstRead = yield* store.script(script.id);
      assert.deepStrictEqual(firstRead, script);
      yield* store.putScript({ ...firstRead!, enabled: false });

      const secondRead = yield* store.script(script.id);
      assert.deepStrictEqual(secondRead, { ...script, enabled: false });
      yield* store.putScript({ ...secondRead!, lastRun });

      assert.deepStrictEqual(yield* store.script(script.id), {
        ...script,
        enabled: false,
        lastRun,
      });
      assert.deepStrictEqual(
        reads.map((span) => span.attributes.get("db.connection")),
        ["reader", "reader", "reader"],
      );
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(Statement.CurrentTransformer, observeReads),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
