/**
 * Settling an OpenCode 2 server's model catalog before T3 trusts it.
 *
 * A location the server has not loaded yet lists its models before its plugins
 * settle: nothing at first, then the built-in providers only, then everything
 * once `provider.updated` and `model.updated` fire for the directory. Live on
 * 2.0.22 (2026-10-19) a cold directory listed nothing for 2.6s, then 11 free
 * models for 1.4s, then all 28 right after the catalog events. A probe that
 * kept the first non-empty listing kept the 11 until something refreshed it,
 * and every model from a plugin provider was refused meanwhile.
 *
 * @module provider/opencode/ardud/catalogSettle
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import type { OpenCode2Model } from "../status.ts";
import * as OpenCode2Client from "../v2/OpenCode2Client.ts";

const EMPTY_RETRY = "250 millis";
const EMPTY_DEADLINE = "5 seconds";
/** How long a warm directory's first listing waits for a catalog event before it is read again. */
const SETTLE_WAIT = "1 second";
/** A directory that listed nothing at first is loading; its catalog event usually follows within seconds. */
const COLD_SETTLE_WAIT = "10 seconds";
const SETTLE_POLL = "500 millis";
/** `provider.updated` comes a few milliseconds before `model.updated`; read after both. */
const EVENT_SETTLE = "250 millis";
const SETTLE_READS = 6;
/**
 * A first catalog, or a settled one that loses models, is read again this much
 * later before it is trusted, since a directory that was already loading can
 * hold a partial listing still for about a second.
 */
const CONFIRM_WAIT = "3 seconds";
/** One model list read. The status check holds the provider's refresh lock while it reads. */
const READ_TIMEOUT = "10 seconds";
const CHANGE_COALESCE = "1 second";
const RESUBSCRIBE_DELAY_MS = 5_000;
const RESUBSCRIBE_DELAY_MAX_MS = 5 * 60_000;
const STABLE_STREAM_MS = 30_000;
const SILENT_STREAM_TIMEOUT = "2 minutes";
/** A stalled server can accept a subscription and never answer it; reads go on without one. */
const SUBSCRIBE_TIMEOUT = "3 seconds";
const WATCH_SUBSCRIBE_TIMEOUT = "10 seconds";

const CATALOG_EVENTS = new Set(["model.updated", "provider.updated"]);

export interface SettledOpenCode2Catalog {
  readonly models: ReadonlyArray<OpenCode2Model>;
  /** Two reads in a row listed the same models. */
  readonly settled: boolean;
}

const catalogKey = (models: ReadonlyArray<OpenCode2Model>) =>
  models
    .map(
      (model) =>
        `${model.providerID}/${model.id}:${model.variants.map((variant) => variant.id).join(",")}`,
    )
    .toSorted()
    .join("\n");

const slugOf = (model: OpenCode2Model) => `${model.providerID}/${model.id}`;

/** Bounds one model list read, so a stalled server cannot hold a status check for minutes. */
export const boundedCatalogRead = <E, R>(
  read: Effect.Effect<ReadonlyArray<OpenCode2Model>, E, R>,
) =>
  read.pipe(
    Effect.timeoutOrElse({
      duration: READ_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "model.list",
            detail: "Timed out waiting for the OpenCode model list.",
          }),
        ),
    }),
  );

/**
 * Reads until two listings agree. An empty listing is read again for a while.
 * After the first non-empty one, the next read waits for `changed` (the
 * directory's catalog event) or a pause, whichever comes first; the pause is
 * longer when the directory listed nothing at first, since it is still loading.
 * A read right after an event never confirms the listing before it: the
 * catalog may still be moving.
 */
export const readSettledOpenCode2Models = <E, R>(
  read: Effect.Effect<ReadonlyArray<OpenCode2Model>, E, R>,
  changed: Effect.Effect<void>,
): Effect.Effect<SettledOpenCode2Catalog, E, R> =>
  Effect.gen(function* () {
    let sawEmpty = false;
    const first = yield* read.pipe(
      Effect.tap((models) =>
        Effect.sync(() => {
          if (models.length === 0) sawEmpty = true;
        }),
      ),
      Effect.repeat({
        until: (models) => models.length > 0,
        schedule: Schedule.spaced(EMPTY_RETRY),
      }),
      Effect.timeoutOption(EMPTY_DEADLINE),
    );
    if (first._tag === "None" || first.value.length === 0) return { models: [], settled: false };
    let previous = first.value;
    for (let attempt = 0; attempt < SETTLE_READS; attempt++) {
      const wait = attempt > 0 ? SETTLE_POLL : sawEmpty ? COLD_SETTLE_WAIT : SETTLE_WAIT;
      const woke = yield* changed.pipe(Effect.timeoutOption(wait));
      if (woke._tag === "Some") yield* Effect.sleep(EVENT_SETTLE);
      // A follow-up read that fails leaves the listing unconfirmed, not lost.
      const reread = yield* Effect.exit(read);
      if (Exit.isFailure(reread)) return { models: previous, settled: false };
      const next = reread.value;
      if (next.length === 0) continue;
      if (woke._tag === "None" && catalogKey(next) === catalogKey(previous)) {
        return { models: next, settled: true };
      }
      previous = next;
    }
    return { models: previous, settled: false };
  });

/**
 * Keeps the last settled catalog. An unsettled read that lacks known models
 * never replaces it, and the first settled catalog, like a settled read that
 * drops models, is confirmed by a second settled read a little later. A
 * partial listing so cannot stand in for a complete one, while a model that
 * was really removed still disappears and an added one shows up at once. The
 * status check confirms the server answers before it lists models, so a failed
 * listing is a blip and the known catalog stands in for it.
 */
export const makeSettledOpenCode2ModelLoader = <E, R>(
  read: Effect.Effect<SettledOpenCode2Catalog, E, R>,
) =>
  Effect.sync(() => {
    let known: ReadonlyArray<OpenCode2Model> = [];
    const keep = (models: ReadonlyArray<OpenCode2Model>) => {
      known = models;
      return models;
    };
    const drops = (from: ReadonlyArray<OpenCode2Model>, models: ReadonlyArray<OpenCode2Model>) => {
      const listed = new Set(models.map(slugOf));
      return from.some((model) => !listed.has(slugOf(model)));
    };
    const dropsKnown = (models: ReadonlyArray<OpenCode2Model>) => drops(known, models);
    return Effect.gen(function* () {
      const result = yield* Effect.exit(read);
      if (Exit.isFailure(result)) {
        if (known.length === 0) return yield* Effect.failCause(result.cause);
        yield* Effect.logWarning(
          "OpenCode 2 model list failed; keeping the last settled catalog.",
          result.cause,
        );
        return known;
      }
      const { models, settled } = result.value;
      if (!settled) return dropsKnown(models) ? known : models;
      const first = known.length === 0;
      if (!first && !dropsKnown(models)) return keep(models);
      yield* Effect.sleep(CONFIRM_WAIT);
      const confirmed = yield* Effect.exit(read);
      if (Exit.isFailure(confirmed) || !confirmed.value.settled) {
        // Unconfirmed: a first catalog still beats none, and anything it lacks
        // is an addition the next read takes.
        return first ? keep(models) : known;
      }
      // A first catalog only grows here; a removal waits for its own confirmation.
      if (first && drops(models, confirmed.value.models)) return keep(models);
      return keep(confirmed.value.models);
    });
  });

interface SnapshotCatalog {
  readonly installed: boolean;
  readonly status: string;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isCustom: boolean;
    readonly capabilities?:
      | {
          readonly optionDescriptors?:
            | ReadonlyArray<{
                readonly id: string;
                readonly options?: ReadonlyArray<{ readonly id: string }>;
              }>
            | undefined;
        }
      | null
      | undefined;
  }>;
}

/** The startup snapshot, published before the first status check finished. */
export const isPendingSnapshot = (snapshot: SnapshotCatalog): boolean =>
  !snapshot.installed && snapshot.status === "warning";

/**
 * Whether a fresh listing differs from the models a snapshot offers (slugs
 * and reasoning variants), ignoring rows that come from settings. The pending
 * startup snapshot never differs: its own probe is already running. Any other
 * snapshot that is not ready does.
 */
export const catalogDiffersFromSnapshot = (
  snapshot: SnapshotCatalog,
  listed: ReadonlyArray<OpenCode2Model>,
): boolean => {
  if (isPendingSnapshot(snapshot)) return false;
  if (snapshot.status !== "ready") return true;
  const offered = snapshot.models
    .filter((model) => !model.isCustom)
    .map((model) => {
      const variant = model.capabilities?.optionDescriptors?.find((d) => d.id === "variant");
      return `${model.slug}:${(variant?.options ?? []).map((option) => option.id).join(",")}`;
    })
    .toSorted()
    .join("\n");
  return offered !== catalogKey(listed);
};

export const isOpenCode2CatalogEvent = (
  event: OpenCode2Client.OpenCode2StreamEvent,
  directory: string,
): boolean =>
  CATALOG_EVENTS.has(event.type) && "location" in event && event.location?.directory === directory;

/**
 * Subscribes to the server's events and returns an effect that completes on
 * the directory's next catalog event. Subscribe before the first read, since
 * the read is what loads a cold directory. Without a stream it never
 * completes, and readers fall back to their pauses.
 */
export const openCode2CatalogChanges = (
  events: OpenCode2Client.OpenCode2Api["events"],
  directory: string,
) =>
  Effect.gen(function* () {
    const changes = yield* Queue.sliding<void>(1);
    const stream = yield* events.pipe(
      Effect.option,
      Effect.timeoutOption(SUBSCRIBE_TIMEOUT),
      Effect.map(Option.flatten),
    );
    if (stream._tag === "Some") {
      yield* stream.value.pipe(
        Stream.runForEach((event) =>
          isOpenCode2CatalogEvent(event, directory) ? Queue.offer(changes, undefined) : Effect.void,
        ),
        Effect.ignore,
        Effect.forkScoped,
      );
    }
    return changes;
  }).pipe(Effect.map((changes) => Queue.take(changes)));

/** Whether a raw `/api/event` frame is a catalog event for `directory`. Parses only frames that can be one. */
export const isOpenCode2CatalogFrame = (data: string, directory: string): boolean => {
  if (!data.includes('.updated"')) return false;
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return false;
  }
  if (typeof frame !== "object" || frame === null) return false;
  const { type, location } = frame as { type?: unknown; location?: { directory?: unknown } };
  return typeof type === "string" && CATALOG_EVENTS.has(type) && location?.directory === directory;
};

/**
 * The directory's catalog events from a configured server's `/api/event`.
 * Only frames that can be catalog events are parsed, so a long-lived watcher
 * costs next to nothing beside the sessions' own fully decoded streams.
 */
export const subscribeOpenCode2CatalogFrames = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly directory: string;
}) =>
  HttpClient.get(`${input.serverUrl.trim().replace(/\/+$/, "")}/api/event`, {
    headers: {
      accept: "text/event-stream",
      // OpenCode decodes Basic credentials as UTF-8.
      authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
    },
  }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.map((response) =>
      response.stream.pipe(
        Stream.timeoutOrElse({
          duration: SILENT_STREAM_TIMEOUT,
          orElse: () => Stream.fail(new OpenCode2Client.OpenCode2SilentStreamError()),
        }),
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.filter((frame) => isOpenCode2CatalogFrame(frame.data, input.directory)),
        Stream.map((): void => undefined),
      ),
    ),
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
  );

/**
 * Runs `onChange` once per burst of catalog notices, and once after every
 * subscription, since a notice may have gone by before it or while the stream
 * was down. Lives until its scope closes.
 */
export const followOpenCode2CatalogChanges = <E1, E2, E3>(input: {
  readonly subscribe: Effect.Effect<Stream.Stream<void, E2>, E1>;
  readonly onChange: Effect.Effect<unknown, E3>;
}) =>
  Effect.gen(function* () {
    const pending = yield* Queue.sliding<void>(1);
    yield* Effect.forever(
      Queue.take(pending).pipe(
        Effect.andThen(Effect.sleep(CHANGE_COALESCE)),
        Effect.andThen(Queue.clear(pending)),
        Effect.andThen(input.onChange.pipe(Effect.ignoreCause({ log: true }))),
      ),
    ).pipe(Effect.forkScoped);
    // Backs off while the server refuses (down, or not a 2.x server) or drops
    // the stream right away; resets once a stream has stayed open a while.
    let failures = 0;
    yield* Effect.forever(
      Effect.gen(function* () {
        const notices = yield* input.subscribe.pipe(
          Effect.timeoutOption(WATCH_SUBSCRIBE_TIMEOUT),
          Effect.flatMap((subscribed) =>
            subscribed._tag === "Some" ? Effect.succeed(subscribed.value) : Effect.fail("timeout"),
          ),
        );
        const opened = yield* Clock.currentTimeMillis;
        yield* Queue.offer(pending, undefined);
        yield* Stream.runForEach(notices, () => Queue.offer(pending, undefined)).pipe(
          Effect.ignoreCause({ log: false }),
        );
        if ((yield* Clock.currentTimeMillis) - opened >= STABLE_STREAM_MS) failures = 0;
      }).pipe(
        Effect.ignoreCause({ log: false }),
        Effect.andThen(
          Effect.suspend(() =>
            Effect.sleep(
              Math.min(
                RESUBSCRIBE_DELAY_MS * 2 ** Math.min(failures++, 10),
                RESUBSCRIBE_DELAY_MAX_MS,
              ),
            ),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);
  });
