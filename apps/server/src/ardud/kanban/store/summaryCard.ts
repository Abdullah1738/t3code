import { KanbanCard } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * The few card fields the board list's badges read. Internal to the store:
 * not a wire schema, and no persistence columns.
 */
export const SummaryCard = Schema.Struct({
  id: KanbanCard.fields.id,
  stage: KanbanCard.fields.stage,
  settledAt: KanbanCard.fields.settledAt,
  activeThreadId: KanbanCard.fields.activeThreadId,
  // Whose turn each ask is: these keys are absent on most asks, as on the card.
  asks: Schema.Array(
    Schema.Struct({
      closedAt: Schema.NullOr(Schema.String),
      clarifyAskedAt: Schema.optional(Schema.String),
      handedAt: Schema.optional(Schema.String),
      expiresAt: Schema.optional(Schema.String),
      /** Only `ack` is read: a notice never counts for the owner. */
      respond: Schema.optional(Schema.Struct({ ack: Schema.optional(Schema.Boolean) })),
    }),
  ),
});
export type SummaryCard = typeof SummaryCard.Type;
