import { AuthSessionId, type AuthEnvironmentScope, MissionError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import type { SessionOrigin } from "../../auth/SessionOrigins.ts";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import type { ScribeBatchInput } from "./batch.ts";
import { scribeRouteLayer, SCRIBE_CREDENTIAL_REQUIRED, SCRIBE_ROUTE_PREFIX } from "./http.ts";
import { ScribeService } from "./ScribeService.ts";

const READ_OPERATE: ReadonlyArray<AuthEnvironmentScope> = [
  "orchestration:read",
  "orchestration:operate",
];

const TOKENS: Record<
  string,
  { readonly scopes: ReadonlyArray<AuthEnvironmentScope>; readonly origin?: SessionOrigin }
> = {
  "Bearer reader": { scopes: ["orchestration:read"] },
  // The shared control token: operate scope, but no component identity.
  "Bearer operator": { scopes: READ_OPERATE },
  "Bearer crw": { scopes: READ_OPERATE, origin: { _tag: "component", component: "crw" } },
  "Bearer scribe": { scopes: READ_OPERATE, origin: { _tag: "component", component: "scribe" } },
  "Bearer owner": { scopes: READ_OPERATE, origin: { _tag: "owner", source: "desktop" } },
};

const batch: ScribeBatchInput = {
  missionId: "mission-crpko",
  laneId: "lane-money",
  subMissionId: null,
  threadId: "thread-lane-money",
  fromEvent: 1,
  toEvent: 4,
  notes: [
    {
      type: "risk",
      summary: "Store tests still fail.",
      quote: "Three store tests still fail.",
      event: 3,
      fromEvent: 3,
      toEvent: 3,
      basis: "claimed",
      severity: "medium",
      confidence: 0.6,
      replaces: null,
    },
  ],
  candidates: [],
  droppedCount: 0,
  usage: { input: 100, output: 20 },
  model: "cc/claude-haiku-5-5",
};

const handlerWith = (ingested: Array<ScribeBatchInput>, writes: Array<string> = []) =>
  HttpRouter.toWebHandler(
    scribeRouteLayer.pipe(
      Layer.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: (request) => {
            const token = TOKENS[request.headers.authorization ?? ""];
            return token === undefined
              ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test-session"),
                  subject: "test",
                  method: "bearer-access-token" as const,
                  scopes: token.scopes,
                  ...(token.origin ? { origin: token.origin } : {}),
                });
          },
        }),
      ),
      Layer.provide(
        Layer.mock(ScribeService)({
          lanes: (missionId) =>
            missionId === "mission-crpko"
              ? Effect.succeed([])
              : Effect.fail(new MissionError({ code: "not-found", detail: "No such mission." })),
          ingest: (input) =>
            Effect.sync(() => {
              ingested.push(input);
              return {
                duplicate: false,
                accepted: 1,
                failed: 0,
                cursor: input.toEvent,
                stats: null,
              };
            }),
          applyEditor: (input) =>
            Effect.sync(() => {
              writes.push(`editor:${input.missionId}`);
              return { bottomLine: null, fyi: 0, feed: 0, opened: [], dropped: 0, rejected: [] };
            }),
          report: (input) =>
            Effect.sync(() => {
              writes.push(`report:${input.kind}:${input.save ? "saved" : "built"}`);
              return {
                kind: input.kind,
                coversFrom: "2026-10-18T08:00:00.000Z",
                coversTo: "2026-10-18T12:00:00.000Z",
                text: "Nothing new.",
                open: [],
              };
            }),
        }),
      ),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    ),
    { disableLogger: true },
  );

const request = (path: string, init: { token?: string; body?: unknown } = {}) => {
  const url = `http://env.local${SCRIBE_ROUTE_PREFIX}${path}`;
  const headers: Record<string, string> = init.token ? { authorization: init.token } : {};
  if (init.body === undefined) return new Request(url, { headers });
  headers["content-type"] = "application/json";
  return new Request(url, { method: "POST", headers, body: JSON.stringify(init.body) });
};

describe("scribe routes", () => {
  it("needs a token, and the scribe's credential to post a batch", async () => {
    const ingested: Array<ScribeBatchInput> = [];
    const { handler, dispose } = handlerWith(ingested);
    try {
      const anonymous = await handler(request("/lanes?missionId=mission-crpko"));
      expect(anonymous.status).toBe(401);
      const reader = await handler(request("/batches", { token: "Bearer reader", body: batch }));
      expect(reader.status).toBe(403);
      expect(ingested).toHaveLength(0);
      const scribe = await handler(request("/batches", { token: "Bearer scribe", body: batch }));
      expect(scribe.status).toBe(200);
      expect(await scribe.json()).toEqual({
        ok: true,
        result: { duplicate: false, accepted: 1, failed: 0, cursor: 4, stats: null },
      });
      expect(ingested[0]?.notes[0]?.quote).toBe("Three store tests still fail.");
    } finally {
      await dispose();
    }
  });

  it("N4: only the scribe's own credential writes; anyone with read can still read", async () => {
    const ingested: Array<ScribeBatchInput> = [];
    const writes: Array<string> = [];
    const { handler, dispose } = handlerWith(ingested, writes);
    const editor = {
      missionId: "mission-crpko",
      since: "2026-10-18T08:00:00.000Z",
      reply: { bottomLine: "All good." },
      model: null,
      usage: { input: 1, output: 1 },
    };
    const saveReport = { missionId: "mission-crpko", kind: "update", save: true };
    try {
      for (const token of ["Bearer operator", "Bearer crw", "Bearer owner"]) {
        for (const [path, body] of [
          ["/batches", batch],
          ["/editor", editor],
          ["/reports", saveReport],
        ] as const) {
          const response = await handler(request(path, { token, body }));
          expect(response.status, `${token} ${path}`).toBe(403);
          const { error } = (await response.json()) as { error: { message: string } };
          expect(error.message).toBe(
            token === "Bearer crw"
              ? "This credential is crw; it cannot write as the scribe."
              : SCRIBE_CREDENTIAL_REQUIRED,
          );
        }
      }
      expect(ingested).toHaveLength(0);
      expect(writes).toEqual([]);

      for (const [path, body] of [
        ["/batches", batch],
        ["/editor", editor],
        ["/reports", saveReport],
      ] as const) {
        const response = await handler(request(path, { token: "Bearer scribe", body }));
        expect(response.status, path).toBe(200);
      }
      expect(ingested).toHaveLength(1);
      expect(writes).toEqual(["editor:mission-crpko", "report:update:saved"]);

      // Building a report without keeping it, and the lane list, stay reads.
      const built = await handler(
        request("/reports", {
          token: "Bearer reader",
          body: { missionId: "mission-crpko", kind: "update" },
        }),
      );
      expect(built.status).toBe(200);
      expect(writes.at(-1)).toBe("report:update:built");
      const lanes = await handler(
        request("/lanes?missionId=mission-crpko", { token: "Bearer operator" }),
      );
      expect(lanes.status).toBe(200);
    } finally {
      await dispose();
    }
  });

  it("rejects malformed batches and maps mission errors", async () => {
    const ingested: Array<ScribeBatchInput> = [];
    const { handler, dispose } = handlerWith(ingested);
    try {
      const bad = await handler(
        request("/batches", {
          token: "Bearer scribe",
          body: { ...batch, notes: [{ ...batch.notes[0], type: "gossip" }] },
        }),
      );
      expect(bad.status).toBe(400);
      expect(ingested).toHaveLength(0);
      const missing = await handler(request("/lanes", { token: "Bearer reader" }));
      expect(missing.status).toBe(400);
      const unknown = await handler(request("/lanes?missionId=nope", { token: "Bearer reader" }));
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({
        ok: false,
        error: { code: "not_found", message: "No such mission." },
      });
      const lanes = await handler(
        request("/lanes?missionId=mission-crpko", { token: "Bearer reader" }),
      );
      expect(await lanes.json()).toEqual({ ok: true, lanes: [] });
    } finally {
      await dispose();
    }
  });
});
