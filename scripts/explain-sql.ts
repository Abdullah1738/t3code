// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- standalone offline CLI copies snapshots and prints one diagnostic record.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import {
  HISTORY_TABLES,
  historyViewSql,
  eventHistoryLookupViews,
  emptyBaseSchemaSql,
} from "../apps/server/src/ardud/persistence/historyArchiveSql.ts";
import {
  normalizeSql,
  sqlFingerprint,
  sqlParameterOffsets,
} from "../packages/shared/src/sqlDiagnostics.ts";

function snapshotPath(filename: string) {
  const path = NodeFS.realpathSync(filename);
  for (const home of [
    NodePath.join(NodeOS.homedir(), ".robob", "userdata"),
    NodePath.join(NodeOS.homedir(), ".t3", "userdata"),
  ]) {
    if (!NodeFS.existsSync(home)) continue;
    const live = NodeFS.realpathSync(home);
    if (path === live || path.startsWith(live + NodePath.sep))
      throw new Error("A live database is not a snapshot.");
  }
  return path;
}

/** Only opens private copies of offline snapshots, including each attached archive. */
export function explainSql(input: {
  snapshot: string;
  statement: string;
  fingerprint: string;
  parameters?: ReadonlyArray<NodeSqlite.SQLInputValue>;
  attachments?: ReadonlyArray<{ name: string; snapshot: string }>;
}) {
  const normalized = normalizeSql(input.statement);
  if (sqlFingerprint(normalized) !== input.fingerprint)
    throw new Error("Statement fingerprint mismatch or truncated statement.");
  // Keep large APFS snapshots on their own volume so cloning is cheap.
  const mainSnapshot = snapshotPath(input.snapshot);
  const directory = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(mainSnapshot), ".robob-sql-plan-"),
  );
  const clone = (source: string, destination: string) => {
    try {
      NodeFS.copyFileSync(source, destination, NodeFS.constants.COPYFILE_FICLONE_FORCE);
    } catch {
      // Small fixtures work on filesystems without cloning; never silently copy a huge database.
      if (NodeFS.statSync(source).size > 64 * 1024 * 1024)
        throw new Error("Large snapshots require same-volume copy-on-write support.");
      NodeFS.copyFileSync(source, destination);
    }
  };
  const copy = (filename: string, name: string) => {
    const source = snapshotPath(filename);
    const destination = NodePath.join(directory, name + ".sqlite");
    clone(source, destination);
    for (const suffix of ["-wal", "-shm"])
      if (NodeFS.existsSync(source + suffix))
        clone(snapshotPath(source + suffix), destination + suffix);
    return destination;
  };
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(copy(input.snapshot, "main"), { readOnly: true });
    for (const [index, attachment] of (input.attachments ?? []).entries()) {
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(attachment.name))
        throw new Error("Invalid archive schema name.");
      db.prepare(`ATTACH DATABASE ? AS "${attachment.name}"`).run(
        NodeURL.pathToFileURL(copy(attachment.snapshot, "archive" + index)).href + "?mode=ro",
      );
    }
    if (input.attachments?.some((attachment) => attachment.name === "ardud_archive")) {
      if (!input.attachments.some((attachment) => attachment.name === "ardud_base")) {
        db.exec("ATTACH DATABASE ':memory:' AS ardud_base");
        for (const sql of emptyBaseSchemaSql) db.exec(sql);
      }
      for (const sql of [...HISTORY_TABLES.map(historyViewSql), ...eventHistoryLookupViews])
        db.exec(sql);
    }
    // Bind NULL to redacted values. This is a structural snapshot plan, not proof
    // of the historical bindings, statistics, attachments or value-sensitive plan.
    const offsets = sqlParameterOffsets(normalized);
    let planSql = normalized;
    if (input.parameters !== undefined) {
      if (input.parameters.length !== offsets.length) throw new Error("Parameter count mismatch.");
      // Forced partial indexes must match constants at prepare time, before binding.
      const quote = db.prepare("SELECT quote(?) AS literal");
      for (let index = offsets.length - 1; index >= 0; index--) {
        const value = input.parameters[index]!;
        const literal =
          typeof value === "string" && value.includes("\0")
            ? "CAST(X'" +
              Array.from(new TextEncoder().encode(value), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join("") +
              "' AS TEXT)"
            : typeof value === "number" && Number.isInteger(value)
              ? String(value)
              : String(quote.get(value)?.literal);
        const offset = offsets[index]!;
        planSql = planSql.slice(0, offset) + literal + planSql.slice(offset + 1);
      }
    }
    const statement = db.prepare("EXPLAIN QUERY PLAN " + planSql);
    const rows =
      input.parameters === undefined
        ? statement.all(...Array.from({ length: offsets.length }, () => null))
        : statement.all();
    return {
      type: "sql.plan",
      "sql.fingerprint": input.fingerprint,
      "sql.plan.mode": "disposable-copy",
      "sql.plan.bindings": input.parameters ? "supplied-not-recorded" : "redacted-null",
      "sql.plan.rows": rows.slice(0, 256).map((row) => ({
        id: row.id,
        parent: row.parent,
        // Unnamed columns derive names from expressions, including restored literal values.
        detail: normalizeSql(String(row.detail)).slice(0, 1_000),
      })),
      "sql.plan.truncated": rows.length > 256,
    };
  } finally {
    db?.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

const decodeTraceLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      events: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            attributes: Schema.Record(Schema.String, Schema.Unknown),
          }),
        ),
      ),
    }),
  ),
);
const decodeParameters = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Finite, Schema.Null]))),
);

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  // node scripts/explain-sql.ts SNAPSHOT TRACE FINGERPRINT [SCHEMA=ARCHIVE_SNAPSHOT ...]
  const [, , snapshot, trace, fingerprint, ...archives] = process.argv;
  if (!snapshot || !trace || !fingerprint) {
    console.error(
      "Usage: node scripts/explain-sql.ts SNAPSHOT TRACE FINGERPRINT [SCHEMA=SNAPSHOT ...]",
    );
    process.exitCode = 1;
  } else {
    try {
      let statement: string | undefined;
      for (const line of NodeFS.readFileSync(trace, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const record = decodeTraceLine(line);
        for (const event of record.events ?? []) {
          if (
            event.name !== "sql.statement" ||
            event.attributes?.["sql.fingerprint"] !== fingerprint
          )
            continue;
          if (event.attributes["sql.statement.truncated"]) throw new Error("Truncated statement.");
          const text = event.attributes["sql.statement"];
          if (typeof text === "string") statement = text;
        }
      }
      if (!statement) throw new Error("Statement not found in trace.");
      const parametersIndex = archives.indexOf("--parameters-file");
      const parameters =
        parametersIndex < 0
          ? undefined
          : decodeParameters(NodeFS.readFileSync(archives[parametersIndex + 1]!, "utf8"));
      if (parametersIndex >= 0) archives.splice(parametersIndex, 2);
      console.log(
        JSON.stringify(
          explainSql({
            snapshot,
            statement,
            fingerprint,
            ...(parameters === undefined ? {} : { parameters }),
            attachments: archives.map((archive) => {
              const separator = archive.indexOf("=");
              if (separator < 1) throw new Error("Expected SCHEMA=SNAPSHOT.");
              return { name: archive.slice(0, separator), snapshot: archive.slice(separator + 1) };
            }),
          }),
        ),
      );
    } catch {
      // SQLite failures can quote SQL or data; keep the CLI failure structural.
      console.error(
        "SQL plan unavailable: check snapshot, same-volume cloning, attachments and complete statement record.",
      );
      process.exitCode = 1;
    }
  }
}
