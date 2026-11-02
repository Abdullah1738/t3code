import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";

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
        respond(routes.contextStatus === undefined ? { data: routes.context ?? context } : {}, routes.contextStatus ?? 200),
      );
    }
    if (path.endsWith("/inbox")) return Effect.succeed(respond({ data: routes.inbox ?? [] }));
    if (path.endsWith("/form")) return Effect.succeed(respond({ data: routes.form ?? [] }));
    if (path === "/api/session/active") return Effect.succeed(respond({ data: routes.active ?? {} }));
    if (path === "/api/session") return Effect.succeed(respond({ data: routes.children ?? [] }));
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
  return program.pipe(Effect.map((result) => assert.deepStrictEqual(result.blockers, ["opencode session busy"])));
});

it.effect("pending inbox work blocks the migration", () => {
  const { program } = run({ inbox: [{ id: "msg_pending" }] });
  return program.pipe(Effect.map((result) => assert.deepStrictEqual(result.blockers, ["inbox not empty"])));
});

it.effect("a pending form blocks the migration", () => {
  const { program } = run({ form: [{ id: "form_1" }] });
  return program.pipe(Effect.map((result) => assert.deepStrictEqual(result.blockers, ["form pending"])));
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
