import type { ArdudBoardImportInput, ArdudBoardImportResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import * as BoardService from "./BoardService.ts";
import * as BoardStore from "./BoardStore.ts";
import { parseOpenChamberLedger, planOpenChamberImport } from "./openchamberImport.ts";

export class BoardImportError extends Schema.TaggedError<BoardImportError>()("BoardImportError", {
  source: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not import the OpenChamber board from ${this.source}: ${this.detail}`;
  }
}

/**
 * Imports OpenChamber's session board ledger. Sessions map to threads through
 * `ardud_opencode_import` (filled by the OpenCode session importer); unmapped
 * sessions are counted and skipped, so the import can be re-run after more
 * sessions are imported.
 */
export class BoardImport extends Context.Service<
  BoardImport,
  {
    readonly importOpenChamber: (
      input: ArdudBoardImportInput,
    ) => Effect.Effect<ArdudBoardImportResult, BoardImportError>;
  }
>()("t3/ardud/board/BoardImport") {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* BoardStore.BoardStore;
  const board = yield* BoardService.BoardService;

  const importOpenChamber = (input: ArdudBoardImportInput) =>
    Effect.gen(function* () {
      const source =
        input.path ?? path.join(NodeOS.homedir(), ".config", "openchamber", "session-board.json");
      const dryRun = input.dryRun ?? false;
      const fail = (detail: string) => (cause: unknown) =>
        new BoardImportError({ source, detail, cause });
      const text = yield* fileSystem
        .readFileString(source)
        .pipe(Effect.mapError(fail("the file could not be read")));
      const parsed = yield* decodeJson(text).pipe(
        Effect.mapError(fail("the file is not valid JSON")),
      );
      const ledger = yield* Effect.try({
        try: () => parseOpenChamberLedger(parsed),
        catch: fail("the file is not a session board ledger"),
      });
      const mapping = yield* store
        .importedThreads(ledger.records.map((record) => record.sessionId))
        .pipe(Effect.mapError(fail("the session mapping could not be read")));
      const plan = planOpenChamberImport(ledger, mapping);
      const existing = yield* store
        .existingThreads(plan.rows.map((row) => row.threadId))
        .pipe(Effect.mapError(fail("threads could not be read")));
      const rows = plan.rows.filter((row) => existing.has(row.threadId));
      const current = yield* board.rows;
      const keptNewer = rows.filter((row) => {
        const ours = current.get(row.threadId);
        return ours !== undefined && (ours.promptAt ?? 0) > (row.promptAt ?? 0);
      }).length;
      let imported = rows.length - keptNewer;
      if (!dryRun) {
        yield* store
          .rememberOrigins(plan.origins)
          .pipe(Effect.mapError(fail("origins could not be saved")));
        imported = yield* board
          .importRows(rows)
          .pipe(Effect.mapError(fail("rows could not be saved")));
        // Origins can change which cards show; refresh what the board knows.
        yield* board.reconcile.pipe(Effect.ignore);
      }
      return {
        dryRun,
        source,
        ...plan.summary,
        imported,
        keptNewer,
        missingThreads: plan.rows.length - rows.length,
      } satisfies ArdudBoardImportResult;
    });

  return BoardImport.of({ importOpenChamber });
});

export const layer = Layer.effect(BoardImport, make);
