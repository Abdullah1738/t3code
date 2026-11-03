import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { OpenCodeHttpError } from "../opencode-import/OpenCodeHttp.ts";
import { fetchSource } from "./SourceFetch.ts";

const SESSION = "ses_busy_or_idle";
const CONNECTION = { baseUrl: "http://127.0.0.1:49374", authorization: "Basic dGVzdDp0ZXN0" };
const T = 1_793_000_000_000;

const context = [
  {
    id: "msg_u1",
    type: "user",
    text: "hello",
    files: [],
    time: { created: T },
  },
];

interface Routes {
  readonly context?: unknown;
  readonly inbox?: unknown;
  readonly form?: unknown;
  readonly active?: unknown;
  readonly children?: unknown;
  readonly childPages?: Readonly<
    Record<string, { readonly body: unknown; readonly status?: number }>
  >;
  readonly contextStatus?: number;
}

const fakeLayer = (routes: Routes) => {
  const seen: Array<string> = [];
  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    seen.push(`${url.pathname}${url.search}`);
    const respond = (body: unknown, status = 200) =>
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }));
    if (path.endsWith("/context")) {
      return Effect.succeed(
        respond(
          routes.contextStatus === undefined ? { data: routes.context ?? context } : {},
          routes.contextStatus ?? 200,
        ),
      );
    }
    if (path.endsWith("/inbox")) return Effect.succeed(respond({ data: routes.inbox ?? [] }));
    if (path.endsWith("/form")) return Effect.succeed(respond({ data: routes.form ?? [] }));
    if (path === "/api/session/active")
      return Effect.succeed(respond({ data: routes.active ?? {} }));
    if (path === "/api/session") {
      const page = routes.childPages?.[url.searchParams.get("cursor") ?? ""];
      if (page !== undefined) return Effect.succeed(respond(page.body, page.status));
      if (routes.childPages !== undefined) return Effect.succeed(respond({}, 404));
      return Effect.succeed(respond({ data: routes.children ?? [], cursor: {} }));
    }
    return Effect.succeed(respond({}, 404));
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), seen };
};

const run = (routes: Routes) => {
  const { layer, seen } = fakeLayer(routes);
  return {
    seen,
    program: fetchSource(CONNECTION, SESSION).pipe(Effect.provide(layer)),
  };
};

it.effect("an idle session with nothing pending has no blockers and a snapshot", () => {
  const { program } = run({});
  return program.pipe(
    Effect.map((result) => {
      assert.deepStrictEqual(result.blockers, []);
      assert.strictEqual(result.records.length, 1);
      assert.strictEqual(result.snapshot.turns.length, 1);
    }),
  );
});

it.effect("a session listed as active is busy", () => {
  const { program } = run({ active: { [SESSION]: { status: "running" } } });
  return program.pipe(
    Effect.map((result) => assert.deepStrictEqual(result.blockers, ["opencode session busy"])),
  );
});

it.effect("pending inbox work blocks the migration", () => {
  const { program } = run({ inbox: [{ id: "msg_pending" }] });
  return program.pipe(
    Effect.map((result) => assert.deepStrictEqual(result.blockers, ["inbox not empty"])),
  );
});

it.effect("a pending form blocks the migration", () => {
  const { program } = run({ form: [{ id: "form_1" }] });
  return program.pipe(
    Effect.map((result) => assert.deepStrictEqual(result.blockers, ["form pending"])),
  );
});

it.effect("a child that is still active blocks, and a finished child does not", () => {
  const { program } = run({
    children: [{ id: "ses_child_live" }, { id: "ses_child_done" }],
    active: { ses_child_live: { status: "running" } },
  });
  return program.pipe(
    Effect.map((result) => assert.deepStrictEqual(result.blockers, ["live child ses_child_live"])),
  );
});

it.effect("checks active children on every page using the opaque cursor", () => {
  const cursor = "next+/= page";
  const { program, seen } = run({
    childPages: {
      "": { body: { data: [{ id: "ses_child_done" }], cursor: { next: cursor } } },
      [cursor]: { body: { data: [{ id: "ses_child_live" }], cursor: {} } },
    },
    active: { ses_child_live: { status: "running" } },
  });
  return program.pipe(
    Effect.map((result) => {
      assert.deepStrictEqual(result.blockers, ["live child ses_child_live"]);
      assert.deepStrictEqual(
        seen.filter((path) => path.startsWith("/api/session?")),
        [
          `/api/session?parentID=${SESSION}&limit=100`,
          `/api/session?limit=100&cursor=${encodeURIComponent(cursor)}`,
        ],
      );
    }),
  );
});

it.effect.each([
  { name: "missing cursor", body: { data: [] } },
  { name: "null cursor", body: { data: [], cursor: null } },
  { name: "non-string next", body: { data: [], cursor: { next: 1 } } },
  { name: "null next", body: { data: [], cursor: { next: null } } },
  { name: "empty next", body: { data: [{ id: "child" }], cursor: { next: "" } } },
  { name: "empty page with next", body: { data: [], cursor: { next: "more" } } },
])("fails closed on a $name", ({ body }) => {
  const { program } = run({ childPages: { "": { body } } });
  return program.pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.isTrue(Schema.is(OpenCodeHttpError)(error));
      assert.include(error.operation, "read child sessions");
    }),
  );
});

it.effect("fails closed when a later child page cannot be read", () => {
  const { program } = run({
    childPages: {
      "": { body: { data: [{ id: "child" }], cursor: { next: "more" } } },
      more: { body: {}, status: 503 },
    },
  });
  return program.pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.isTrue(Schema.is(OpenCodeHttpError)(error));
      assert.strictEqual(error.operation, "read child sessions");
      assert.strictEqual(error.status, 503);
    }),
  );
});

it.effect("fails closed on a cyclic child cursor", () => {
  const { program, seen } = run({
    childPages: {
      "": { body: { data: [{ id: "child_1" }], cursor: { next: "one" } } },
      one: { body: { data: [{ id: "child_2" }], cursor: { next: "two" } } },
      two: { body: { data: [{ id: "child_3" }], cursor: { next: "one" } } },
    },
  });
  return program.pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.isTrue(Schema.is(OpenCodeHttpError)(error));
      assert.include(error.operation, "invalid cursor");
      assert.strictEqual(seen.filter((path) => path.startsWith("/api/session?")).length, 3);
    }),
  );
});

it.effect.each(["transport", "body"] as const)(
  "times out a stalled context $0 after 60 seconds",
  (stall) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const client = HttpClient.make((request) => {
        if (stall === "transport") {
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        }
        const stream = new ReadableStream<Uint8Array>({
          pull() {
            Deferred.doneUnsafe(started, Effect.void);
            return new Promise<void>(() => {});
          },
        });
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(stream)));
      });
      const fiber = yield* Effect.forkChild(
        fetchSource(CONNECTION, SESSION).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.flip,
        ),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("59 seconds");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      assert.isTrue(Schema.is(OpenCodeHttpError)(error));
      assert.strictEqual(error.operation, "read session context (timed out)");
    }),
);

it.effect("a failed context read is a typed error, never an empty snapshot", () => {
  const { program } = run({ contextStatus: 500 });
  return program.pipe(
    Effect.match({
      onFailure: (error) => {
        assert.isTrue(Schema.is(OpenCodeHttpError)(error));
        assert.strictEqual(error.status, 500);
      },
      onSuccess: () => {
        throw new Error("a 500 on /context must not produce a snapshot");
      },
    }),
  );
});

it.effect("reads the child list with the session id encoded in the query", () => {
  const { program, seen } = run({});
  return program.pipe(
    Effect.map(() => {
      assert.isTrue(seen.some((path) => path === `/api/session?parentID=${SESSION}&limit=100`));
    }),
  );
});
