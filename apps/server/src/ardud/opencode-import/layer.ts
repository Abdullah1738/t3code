import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as LegacyV1ThreadImporter from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { forkParked } from "../../serverActivation.ts";
import * as OpenCodeImporter from "./OpenCodeImporter.ts";

/**
 * The legacy transcript hook ThreadManagementService runs before it reads or
 * changes a thread, extended to pull imported OpenCode transcripts too.
 */
export const withOpenCodeTranscripts = Layer.effect(
  LegacyV1ThreadImporter.LegacyV1ThreadImporter,
  Effect.gen(function* () {
    const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const importer = yield* OpenCodeImporter.OpenCodeImporter;
    return LegacyV1ThreadImporter.LegacyV1ThreadImporter.of({
      ...legacy,
      ensureTranscript: (threadId) =>
        legacy
          .ensureTranscript(threadId)
          .pipe(Effect.tap(() => importer.ensureTranscript(threadId))),
    });
  }),
);

/**
 * Off by default. With T3CODE_ARDUD_OPENCODE_SYNC=1 the server imports new and
 * changed OpenCode sessions at start, then every
 * T3CODE_ARDUD_OPENCODE_SYNC_MINUTES (default 5), so sessions made outside T3
 * keep showing up.
 */
const syncEnabled = Config.Boolean("T3CODE_ARDUD_OPENCODE_SYNC").pipe(Config.withDefault(false));
const syncMinutes = Config.Int("T3CODE_ARDUD_OPENCODE_SYNC_MINUTES").pipe(Config.withDefault(5));

const syncOnce = (importer: OpenCodeImporter.OpenCodeImporterShape, sinceDays?: number) =>
  importer.run(sinceDays === undefined ? {} : { sinceDays }).pipe(
    Effect.tap((result) =>
      result.created + result.updated + result.failed > 0
        ? Effect.logInfo("Synced OpenCode sessions", result)
        : Effect.void,
    ),
    Effect.catchCause((cause) => Effect.logWarning("OpenCode session sync failed", { cause })),
  );

export const ArdudOpenCodeImportLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const importer = yield* OpenCodeImporter.OpenCodeImporter;
    const enabled = yield* syncEnabled.pipe(Effect.orElseSucceed(() => false));
    if (!enabled) return;
    const minutes = Math.max(1, yield* syncMinutes.pipe(Effect.orElseSucceed(() => 5)));
    yield* forkParked(
      syncOnce(importer).pipe(
        Effect.andThen(
          // Later passes only look at sessions touched in the last two days.
          syncOnce(importer, 2).pipe(Effect.repeat(Schedule.spaced(`${minutes} minutes`))),
        ),
        Effect.delay("10 seconds"),
      ),
    );
  }),
);
