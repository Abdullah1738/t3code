// @effect-diagnostics nodeBuiltinImport:off -- this serialized Node worker owns native SQLite backup and file fsync.
import type * as NodeFS from "node:fs";
import type * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";

export type BackupCommand =
  | { readonly op: "open"; readonly boardsPath: string; readonly tempPath: string }
  | {
      readonly op: "schema";
      readonly name: string;
      readonly sql: string;
      readonly columns: string[];
      readonly source: string;
    }
  | { readonly op: "rows"; readonly rows: ReadonlyArray<Record<string, NodeSqlite.SQLInputValue>> }
  | {
      readonly op: "finish";
      readonly writtenAt: string;
      readonly serverVersion: string;
      readonly buildCommit: string;
    };

// Serialized into a server-owned worker: native backup, counts and destination I/O
// never block the server event loop. This worker never opens statev2.sqlite.
export function backupSnapshotWorker(
  sqlite: typeof NodeSqlite,
  fs: typeof NodeFS,
  port: NodeWorkerThreads.MessagePort,
) {
  let out: NodeSqlite.DatabaseSync | undefined;
  let tempPath = "";
  let insert: NodeSqlite.StatementSync | undefined;
  let columns: string[] = [];
  const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
  port.on("message", async (command: BackupCommand) => {
    try {
      switch (command.op) {
        case "open": {
          tempPath = command.tempPath;
          const source = new sqlite.DatabaseSync(command.boardsPath, { readOnly: true });
          try {
            source.exec("PRAGMA busy_timeout=100; PRAGMA cache_size=-4096; BEGIN");
            // Pin before backup: concurrent board commits cannot restart the copy.
            source.prepare("SELECT count(*) FROM sqlite_schema").get();
            await sqlite.backup(source, tempPath, { rate: 64 });
          } finally {
            source.close();
          }
          fs.chmodSync(tempPath, 0o600);
          out = new sqlite.DatabaseSync(tempPath);
          // Selected state tables can reference projections deliberately absent from this backup.
          out.exec(`PRAGMA foreign_keys=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF;
            CREATE TABLE backup_sources (name TEXT PRIMARY KEY, source_sql TEXT NOT NULL);
            CREATE TABLE backup_meta (written_at TEXT, server_version TEXT, build_commit TEXT, tables TEXT);
            BEGIN`);
          const names = out
            .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
            .all()
            .map((row) => String(row.name));
          port.postMessage({ ok: true, names });
          return;
        }
        case "schema": {
          if (!out) throw new Error("Snapshot is not open");
          out.exec(command.sql);
          out.prepare("INSERT INTO backup_sources VALUES (?, ?)").run(command.name, command.source);
          columns = command.columns;
          insert = out.prepare(
            `INSERT INTO ${q(command.name)} (${columns.map(q).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          );
          break;
        }
        case "rows": {
          if (!insert) throw new Error("Snapshot table is not open");
          for (const row of command.rows) insert.run(...columns.map((column) => row[column]!));
          break;
        }
        case "finish": {
          if (!out) throw new Error("Snapshot is not open");
          const tables: Record<string, number> = {};
          const names = out
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('backup_meta','backup_sources') ORDER BY name",
            )
            .all();
          for (const { name } of names) {
            tables[String(name)] = Number(
              out.prepare(`SELECT count(*) AS n FROM ${q(String(name))}`).get()!.n,
            );
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          out
            .prepare("INSERT INTO backup_meta VALUES (?, ?, ?, ?)")
            .run(
              command.writtenAt,
              command.serverVersion,
              command.buildCommit,
              JSON.stringify(tables),
            );
          out.exec("COMMIT");
          out.close();
          out = undefined;
          const fd = fs.openSync(tempPath, "r+");
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          port.postMessage({ ok: true, tables });
          return;
        }
      }
      port.postMessage({ ok: true });
    } catch (error) {
      port.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
