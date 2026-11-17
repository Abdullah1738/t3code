import { KanbanError, PositiveInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ExactEdits = Schema.Array(
  Schema.Struct({
    oldString: Schema.String.check(Schema.isMinLength(1)),
    newString: Schema.String,
    count: Schema.optional(PositiveInt),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(50));

// Count across independent texts without allowing a match across their boundaries.
export const applyExactEdits = Effect.fn("Kanban.applyExactEdits")(function* (
  texts: ReadonlyArray<string>,
  edits: typeof ExactEdits.Type,
) {
  const invalid = (detail: string) => Effect.fail(new KanbanError({ code: "invalid", detail }));
  if (edits.length < 1 || edits.length > 50)
    return yield* invalid("edits must contain 1–50 entries");
  let next = texts;
  for (const [index, edit] of edits.entries()) {
    const expected = edit.count ?? 1;
    if (edit.oldString.length === 0 || !Number.isSafeInteger(expected) || expected < 1)
      return yield* invalid(
        `edit ${index + 1} needs a non-empty oldString and a positive integer count`,
      );
    const parts = next.map((text) => text.split(edit.oldString));
    const found = parts.reduce((total, text) => total + text.length - 1, 0);
    if (found !== expected)
      return yield* invalid(
        `edit ${index + 1}: expected ${expected}, found ${found} occurrences of "${edit.oldString.slice(0, 80)}"`,
      );
    next = parts.map((text) => text.join(edit.newString));
  }
  return next;
});
