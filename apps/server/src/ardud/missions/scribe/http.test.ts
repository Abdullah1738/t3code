import { AuthSessionId, type AuthEnvironmentScope, MissionError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import type { ScribeBatchInput } from "./batch.ts";
import { scribeRouteLayer, SCRIBE_ROUTE_PREFIX } from "./http.ts";
import { ScribeService } from "./ScribeService.ts";

const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer reader": ["orchestration:read"],
  "Bearer operator": ["orchestration:read", "orchestration:operate"],
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

const handlerWith = (ingested: Array<ScribeBatchInput>) =>
  HttpRouter.toWebHandler(
    scribeRouteLayer.pipe(
      Layer.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateHttpRequest: (request) => {
            const scopes = TOKENS[request.headers.authorization ?? ""];
            return scopes === undefined
              ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test-session"),
                  subject: "test",
                  method: "bearer-access-token" as const,
                  scopes,
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
  it("needs a token, and the operate scope to post a batch", async () => {
    const ingested: Array<ScribeBatchInput> = [];
    const { handler, dispose } = handlerWith(ingested);
    try {
      const anonymous = await handler(request("/lanes?missionId=mission-crpko"));
      expect(anonymous.status).toBe(401);
      const reader = await handler(request("/batches", { token: "Bearer reader", body: batch }));
      expect(reader.status).toBe(403);
      expect(ingested).toHaveLength(0);
      const operator = await handler(
        request("/batches", { token: "Bearer operator", body: batch }),
      );
      expect(operator.status).toBe(200);
      expect(await operator.json()).toEqual({
        ok: true,
        result: { duplicate: false, accepted: 1, failed: 0, cursor: 4, stats: null },
      });
      expect(ingested[0]?.notes[0]?.quote).toBe("Three store tests still fail.");
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
          token: "Bearer operator",
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
