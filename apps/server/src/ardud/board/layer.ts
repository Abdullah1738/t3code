import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BoardImport from "./BoardImport.ts";
import * as BoardService from "./BoardService.ts";
import * as BoardStore from "./BoardStore.ts";

/** Board services, started once: reconcile, then follow thread changes. */
export const ArdudBoardLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const board = yield* BoardService.BoardService;
    yield* board.start;
  }),
).pipe(
  Layer.provideMerge(BoardImport.layer),
  Layer.provideMerge(BoardService.layer),
  Layer.provideMerge(BoardStore.layer),
);
