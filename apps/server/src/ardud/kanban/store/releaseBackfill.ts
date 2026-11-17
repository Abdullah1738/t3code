import { KanbanBoard, KanbanCardId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const BoardJson = Schema.fromJsonString(KanbanBoard);
const decodeBoard = Schema.decodeUnknownEffect(BoardJson);
const encodeBoard = Schema.encodeEffect(BoardJson);

// #1460 s4 predates the interrupting flag. Event 186861 records the actual
// install start; its 22:47 tick and 22:43 healthy time are not release starts.
export const backfillRelease12 = Effect.fn("KanbanStore.backfillRelease12")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const cardId = "card-9b02ad5e-c58b-4893-8474-8437cf436063";
      const rows = yield* sql<{ json: string; body: string }>`
        SELECT b.json, json_extract(e.json, '$.body') AS body
        FROM ardud_kanban_boards b
        JOIN ardud_kanban_cards c ON c.board_id = b.id
        JOIN ardud_kanban_card_events e ON e.card_id = c.id
        WHERE b.id = 'board-robob' AND c.id = ${cardId} AND c.number = 1460
          AND EXISTS (SELECT 1 FROM json_each(c.json, '$.subtasks') s
            WHERE json_extract(s.value, '$.id') = 's4'
              AND json_extract(s.value, '$.state') = 'done')
          AND json_extract(e.json, '$.kind') = 'subtask'
          AND json_extract(e.json, '$.at') = '2026-11-14T22:47:28.947Z'
          AND json_extract(e.json, '$.body') LIKE 's4 done:%Installed 22:33Z%buildCommit d86aed779b94%'
        LIMIT 1
      `;
      const evidence = rows[0];
      if (!evidence) return;
      const board = yield* decodeBoard(evidence.json);
      const ledger = board.historicalReleaseLedger ?? [];
      if (
        [...(board.releaseLedger ?? []), ...ledger].some(
          (row) => row.cardId === cardId && row.subtaskId === "s4",
        )
      )
        return;
      const at = "2026-11-14T22:33:00.000Z";
      if (ledger.length >= 200 && ledger.every((row) => row.at > at)) return;
      const historicalReleaseLedger = [
        ...ledger,
        {
          boardId: board.id,
          cardId: KanbanCardId.make(cardId),
          cardNumber: 1460,
          subtaskId: "s4",
          service: "robob",
          at,
          buildCommit: "d86aed779b94",
          postHoc: true,
          critical: null,
          approvalId: evidence.body.match(/cleared by standing approval ([a-z0-9-]+)/)?.[1] ?? null,
        },
      ]
        .toSorted((a, b) => a.at.localeCompare(b.at))
        .slice(-200);
      const json = yield* encodeBoard({
        ...board,
        historicalReleaseLedger,
      });
      yield* sql`UPDATE ardud_kanban_boards SET json = ${json} WHERE id = ${board.id}`;
    }),
  );
});
