import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import { OpenCodeDriver } from "../driver.ts";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";

const directory = process.cwd();

const modelJson = (slug: string) => {
  const [providerID, ...rest] = slug.split("/");
  const id = rest.join("/");
  return {
    id,
    modelID: id,
    providerID,
    name: slug,
    compatibility: { reasoningField: "reasoning_content" },
    package: "@opencode/ai/providers/openai-compatible",
    settings: { apiKey: "public", baseURL: "http://127.0.0.1:1/v1", provider: providerID },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 1789516800000 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 1000, input: 1000, output: 100 },
  };
};

const FREE = ["opencode/big-pickle", "opencode/beam-free", "ollama/qwen2.5-coder:3b"];
const OPUS = ["opus/claude-opus-5-5", "opus/cx/gpt-6.1-sol", "opus/gpt-6-astra"];
const FULL = [...FREE, ...OPUS];

/**
 * A configured OpenCode 2 server whose catalog the test scripts: `queued`
 * listings are served first, one per read, then `catalog` on every read.
 * `emit` sends a frame to every open `/api/event` stream.
 */
const makeServer = () => {
  const state = {
    catalog: FULL,
    queued: [] as Array<ReadonlyArray<string>>,
    modelReads: 0,
    onDrained: undefined as (() => void) | undefined,
  };
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      switch (path) {
        case "/api/info":
          return json(request, { version: "2.0.22", pid: 1, urls: [], paths: { tmp: "/tmp" } });
        case "/api/model": {
          state.modelReads++;
          const listed = state.queued.shift() ?? state.catalog;
          if (state.queued.length === 0 && state.onDrained) {
            const drained = state.onDrained;
            state.onDrained = undefined;
            drained();
          }
          return json(request, { location: { directory }, data: listed.map(modelJson) });
        }
        case "/api/provider":
          return json(request, { location: { directory }, data: [] });
        case "/api/event": {
          let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
          const body = new ReadableStream<Uint8Array>({
            start: (c) => {
              controller = c;
              streams.add(c);
              c.enqueue(
                encoder.encode('data: {"id":"evt_0","type":"server.connected","data":{}}\n\n'),
              );
            },
            cancel: () => {
              if (controller) streams.delete(controller);
            },
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, { headers: { "content-type": "text/event-stream" } }),
          );
        }
        default:
          return HttpClientResponse.fromWeb(request, new Response("", { status: 404 }));
      }
    }),
  );
  let sent = 0;
  const emit = (type: string) => {
    sent++;
    const frame = {
      id: `evt_${sent}`,
      created: 1792400000000 + sent,
      type,
      location: { directory },
      data: {},
    };
    for (const c of streams) c.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
  };
  return { state, http, emit };
};

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, {
    runOpenCodeCommand: () => Effect.die("a configured server is never run"),
  } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
).pipe(Layer.provideMerge(NodeServices.layer));

const create = (http: HttpClient.HttpClient) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode"),
    displayName: undefined,
    environment: [],
    enabled: true,
    config: {
      ...OpenCodeDriver.defaultConfig(),
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "secret",
    },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

const slugsOf = (snapshot: { readonly models: ReadonlyArray<{ readonly slug: string }> }) =>
  snapshot.models.map((model) => model.slug).toSorted();

const eventually = <A>(read: Effect.Effect<A>, until: (a: A) => boolean) =>
  read.pipe(
    Effect.repeat({ until, schedule: Schedule.spaced("50 millis") }),
    Effect.timeout(Duration.seconds(20)),
  );

/** Waits until the server has seen no model read for `quietMillis`. */
const quiet = (server: ReturnType<typeof makeServer>, quietMillis = 2000) =>
  Effect.gen(function* () {
    let seen = -1;
    while (seen !== server.state.modelReads) {
      seen = server.state.modelReads;
      yield* Effect.sleep(Duration.millis(quietMillis));
    }
  }).pipe(Effect.timeout(Duration.seconds(30)));

describe("OpenCode 2 catalog settling in the driver", () => {
  it.live("a partial first listing does not become the catalog", () =>
    Effect.gen(function* () {
      const server = makeServer();
      server.state.queued = [[], FREE];
      // The plugins settle once the partial listing has been read.
      server.state.onDrained = () => {
        server.emit("provider.updated");
        server.emit("model.updated");
      };
      const instance = yield* create(server.http);
      const snapshot = yield* eventually(
        instance.snapshot.getSnapshot,
        (s) => s.status === "ready" && s.models.length > 0,
      );
      assert.deepStrictEqual(slugsOf(snapshot), FULL.toSorted());
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("an explicit refresh returns the settled catalog", () =>
    Effect.gen(function* () {
      const server = makeServer();
      const instance = yield* create(server.http);
      yield* eventually(instance.snapshot.getSnapshot, (s) => s.status === "ready");
      yield* quiet(server);
      // The location is cold again: a partial listing, then the whole catalog.
      server.state.queued = [FREE];
      const refreshed = yield* instance.snapshot.refresh;
      assert.deepStrictEqual(slugsOf(refreshed), FULL.toSorted());
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("a later catalog update reaches the snapshot without a refresh", () =>
    Effect.gen(function* () {
      const server = makeServer();
      const instance = yield* create(server.http);
      yield* eventually(instance.snapshot.getSnapshot, (s) => s.status === "ready");
      server.state.catalog = [...FULL, "opus/cc/claude-haiku-5-5"];
      server.emit("provider.updated");
      server.emit("model.updated");
      const snapshot = yield* eventually(instance.snapshot.getSnapshot, (s) =>
        s.models.some((model) => model.slug === "opus/cc/claude-haiku-5-5"),
      );
      assert.include(slugsOf(snapshot), "opus/claude-opus-5-5");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("an unchanged catalog event does not re-probe", () =>
    Effect.gen(function* () {
      const server = makeServer();
      const instance = yield* create(server.http);
      const settled = yield* eventually(instance.snapshot.getSnapshot, (s) => s.status === "ready");
      yield* quiet(server);
      const before = server.state.modelReads;
      server.emit("model.updated");
      yield* eventually(
        Effect.sync(() => server.state.modelReads),
        (reads) => reads > before,
      );
      yield* quiet(server);
      // One comparison read, and no health check behind it.
      assert.strictEqual(server.state.modelReads - before, 1);
      assert.strictEqual((yield* instance.snapshot.getSnapshot).checkedAt, settled.checkedAt);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
