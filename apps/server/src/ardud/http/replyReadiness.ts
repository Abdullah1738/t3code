import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { KanbanService } from "../kanban/engine/KanbanService.ts";
import { BoardsDatabase } from "../persistence/BoardsDatabase.ts";

export const controlReadiness = Effect.gen(function* () {
  const database = yield* Effect.serviceOption(BoardsDatabase);
  return Option.isSome(database) ? database.value.ready : Effect.void;
});

// Storage admission must precede the shared builder permit, including startup pool rekey.
export const boardReadiness = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(KanbanService);
  return Option.isSome(service) ? service.value.ready : yield* controlReadiness;
});

export const controlReady = Effect.flatten(controlReadiness);
export const boardReady = Effect.flatten(boardReadiness);
