import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import {
  antigravityGatewayModelsUrl,
  fetchAntigravityGatewayModels,
  selectAntigravityGatewayModels,
} from "./antigravityGateway.ts";

// Shape of 9router's GET /v1/models: no display names, extra fields, other providers mixed in.
const neonCarbon = [
  "ag/gemini-4-neon-xhigh",
  "ag/gemini-4-neon-high",
  "ag/gemini-4-neon-medium",
  "ag/gemini-4-neon-low",
  "ag/gemini-4-carbon-high",
  "ag/gemini-4-carbon-medium",
  "ag/gemini-4-carbon-low",
];
const fixture = {
  object: "list",
  data: [
    ...neonCarbon.map((id) => ({
      id,
      object: "model",
      owned_by: "ag",
      capabilities: { tools: true, contextWindow: 1_048_576 },
    })),
    { id: "ag/gemini-4-argon-high", object: "model", owned_by: "ag" },
    { id: "ag/claude-sonnet-5-5-high", object: "model", owned_by: "ag", name: " Sonnet " },
    { id: "cx/gpt-6.1-terra", object: "model", owned_by: "cx" },
    { id: "surplus/ag/gemini-3.8-flash-high", object: "model" },
    { id: "ag/gemini-4-neon-high", object: "model", owned_by: "ag" },
    { id: "ag/bad,id", object: "model" },
  ],
};

const run = (respond: (request: { url: string; authorization?: string }) => Response) => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const seen = {
        url: request.url,
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      };
      requests.push(seen);
      return HttpClientResponse.fromWeb(request, respond(seen));
    }),
  );
  return (input: { baseUrl: string; apiKey: string }) =>
    fetchAntigravityGatewayModels(input).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.result,
      Effect.map((result) => ({ result, requests })),
    );
};

describe("Antigravity gateway models", () => {
  it("builds the models URL from the gateway root", () => {
    expect(antigravityGatewayModelsUrl("http://127.0.0.1:20128")).toBe(
      "http://127.0.0.1:20128/v1/models",
    );
    expect(antigravityGatewayModelsUrl("http://127.0.0.1:20128//")).toBe(
      "http://127.0.0.1:20128/v1/models",
    );
  });

  it("keeps only ag/* models in gateway order, deduplicated, named by id when unnamed", () => {
    const models = selectAntigravityGatewayModels(fixture.data);
    expect(models.map((model) => model.id)).toEqual([
      ...neonCarbon,
      "ag/gemini-4-argon-high",
      "ag/claude-sonnet-5-5-high",
    ]);
    expect(models[0]).toEqual({ id: "ag/gemini-4-neon-xhigh", name: "ag/gemini-4-neon-xhigh" });
    expect(models.find((model) => model.id === "ag/claude-sonnet-5-5-high")?.name).toBe("Sonnet");
  });

  it.effect(
    "reads the list with the key as a bearer token and includes all Neon and Carbon ids",
    () =>
      Effect.gen(function* () {
        const { result, requests } = yield* run(() => Response.json(fixture))({
          baseUrl: "http://127.0.0.1:20128/",
          apiKey: "router-secret",
        });
        expect(requests).toEqual([
          { url: "http://127.0.0.1:20128/v1/models", authorization: "Bearer router-secret" },
        ]);
        expect(Result.isSuccess(result)).toBe(true);
        const ids = Result.isSuccess(result) ? result.success.map((model) => model.id) : [];
        for (const id of neonCarbon) expect(ids).toContain(id);
      }),
  );

  it.effect("sends no authorization header without a key", () =>
    Effect.gen(function* () {
      const { requests } = yield* run(() => Response.json(fixture))({
        baseUrl: "http://127.0.0.1:20128",
        apiKey: "",
      });
      expect(requests[0]?.authorization).toBeUndefined();
    }),
  );

  it.effect("explains an unreachable gateway without exposing the key", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new TypeError("fetch failed: ECONNREFUSED"),
            }),
          }),
        ),
      );
      const result = yield* fetchAntigravityGatewayModels({
        baseUrl: "http://127.0.0.1:20128",
        apiKey: "router-secret",
      }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      const detail = Result.isFailure(result) ? result.failure.detail : "";
      expect(detail).toContain("http://127.0.0.1:20128 is unreachable (connection failed)");
      expect(detail).not.toContain("router-secret");
    }),
  );

  it.effect("maps status codes and empty lists to clear gateway errors", () =>
    Effect.gen(function* () {
      const cases: Array<[Response, string]> = [
        [new Response("no", { status: 401 }), "rejected the gateway key (HTTP 401)"],
        [new Response("down", { status: 502 }), "unreachable (HTTP 502)"],
        [new Response("not json", { status: 200 }), "model list could not be read"],
        [Response.json({ data: [{ id: "cx/gpt-6.1-terra" }] }), "lists no ag/* models"],
      ];
      for (const [response, expected] of cases) {
        const { result } = yield* run(() => response.clone())({
          baseUrl: "http://127.0.0.1:20128",
          apiKey: "router-secret",
        });
        expect(Result.isFailure(result)).toBe(true);
        const detail = Result.isFailure(result) ? result.failure.detail : "";
        expect(detail).toContain(expected);
        expect(detail).toContain("http://127.0.0.1:20128");
        expect(detail).not.toContain("router-secret");
      }
    }),
  );
});
