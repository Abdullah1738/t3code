import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { offlineSplit } from "./offlineSplit.ts";
import { validateOfflineArchive } from "./validateOfflineArchive.ts";

it.live("opens the install-time split with the real server SQL layer and reads cold payloads", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.resolve(".t3"), { recursive: true });
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: path.resolve(".t3"),
      prefix: "split-server-open-",
    });
    const filename = path.join(directory, "statev2.sqlite");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES ('old', 'p', 'Old', 'opencode', 'full-access', 'default', '2020-01-01', '2020-01-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES ('old:create','thread','old',1,'thread.created','2020-01-01','server','{}','{}',2),
          ('old:item','thread','old',2,'turn-item.updated','2020-01-01','server','{}','{}',2),
          ('old:latest','thread','old',3,'thread.metadata-updated','2020-01-01','server','{}','{}',2)`;
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json)
        VALUES ('old-item','old',1,'assistant_message','completed','2020-01-01','{"text":"base"}')`;
      }).pipe(Effect.provide(Sqlite.layerFromPath(filename))),
    );
    const result = yield* Effect.sync(() =>
      offlineSplit({
        source: filename,
        acknowledgeStopped: true,
        validate: validateOfflineArchive,
      }),
    );
    assert.isFalse(result.alreadyDone);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items`,
          [],
        );
        assert.deepEqual(
          yield* sql`SELECT payload_json FROM ardud_history_turn_items`.pipe(
            NodeSqliteClient.readOnly,
          ),
          [{ payload_json: '{"text":"base"}' }],
        );
        assert.deepEqual(
          yield* sql`SELECT event_id FROM ardud_history_events ORDER BY sequence`.pipe(
            NodeSqliteClient.readOnly,
          ),
          [{ event_id: "old:create" }, { event_id: "old:item" }, { event_id: "old:latest" }],
        );
      }).pipe(Effect.provide(Sqlite.layerFromPath(filename))),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
