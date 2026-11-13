import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

export class ProviderLogMaintenanceError extends Schema.TaggedError<ProviderLogMaintenanceError>()(
  "ProviderLogMaintenanceError",
  {},
) {
  override get message() {
    return "Provider logs could not be drained for maintenance.";
  }
}

export type ProviderLogMaintenance = <A, E, R>(
  threadId: ThreadId,
  effect: Effect.Effect<A, E, R>,
  maintenance?: {
    readonly relatedThreadIds?: Iterable<ThreadId>;
    readonly shouldInvalidate?: () => boolean;
  },
) => Effect.Effect<A, E | ProviderLogMaintenanceError, R>;

export interface EventNdjsonLogger {
  readonly filePath: string;
  readonly write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  {
    readonly withMaintenance?: ProviderLogMaintenance;
    readonly native: EventNdjsonLogger | undefined;
    readonly canonical: EventNdjsonLogger | undefined;
  }
>()("@t3tools/provider-core/server/ProviderEventLoggers") {}

export const NoOpProviderEventLoggers: ProviderEventLoggers["Service"] = {
  withMaintenance: (_threadId, effect) => effect,
  native: undefined,
  canonical: undefined,
};
