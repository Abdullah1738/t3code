// @effect-diagnostics nodeBuiltinImport:off - the fake OpenCode server is plain Node http.
import * as NodeHttp from "node:http";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../../serverSettings.ts";
import { layer, StaleOpenCodeSessions } from "./StaleRuns.ts";

const serve = (handler: NodeHttp.RequestListener) =>
  new Promise<{ readonly url: string; readonly close: () => void }>((resolve) => {
    const server = NodeHttp.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });

const settings = (config: unknown) =>
  Layer.succeed(ServerSettings.ServerSettingsService, {
    getSettings: Effect.succeed({ providerInstances: config }),
  } as never);

const external = (serverUrl: string) => ({
  opencode: { driver: "opencode", config: { serverUrl, serverPassword: "test-password" } },
});

const run = (
  config: unknown,
  sessions: ReadonlyArray<{
    sessionId: string;
    directory: string | null;
    providerInstanceId: string;
  }>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* StaleOpenCodeSessions;
      return yield* service.abort(sessions);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(settings(config))))),
  );

describe("StaleOpenCodeSessions", () => {
  it("interrupts each supplied root with the OpenCode 2 path and auth", async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      auth: string | undefined;
    }> = [];
    const server = await serve((req, res) => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.writeHead(req.url?.startsWith("/api/session/ses_gone/") ? 404 : 200);
      res.end();
    });
    try {
      expect(
        await run(external(server.url), [
          { sessionId: "ses_a/1", directory: "/tmp/a b&c", providerInstanceId: "opencode" },
          { sessionId: "ses_gone", directory: null, providerInstanceId: "opencode" },
        ]),
      ).toEqual({ aborted: 2, failed: 0 });
      expect(requests).toHaveLength(2);
      expect(requests).toContainEqual({
        method: "POST",
        url: "/api/session/ses_a%2F1/interrupt",
        auth: `Basic ${Buffer.from("opencode:test-password").toString("base64")}`,
      });
      expect(requests).toContainEqual({
        method: "POST",
        url: "/api/session/ses_gone/interrupt",
        auth: `Basic ${Buffer.from("opencode:test-password").toString("base64")}`,
      });
    } finally {
      server.close();
    }
  });

  it("counts a 500 and a timed-out request as failures without failing the effect", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/api/session/ses_hang/interrupt") return;
      res.writeHead(500);
      res.end();
    });
    try {
      expect(
        await run(external(server.url), [
          { sessionId: "ses_error", directory: null, providerInstanceId: "opencode" },
          { sessionId: "ses_hang", directory: null, providerInstanceId: "opencode" },
        ]),
      ).toEqual({ aborted: 0, failed: 2 });
    } finally {
      server.close();
    }
  }, 8_000);

  it("stops issuing requests on subsequent passes after a timeout", async () => {
    let requests = 0;
    const server = await serve(() => {
      requests++;
    });
    try {
      const sessions = [{ sessionId: "ses_hang", directory: null, providerInstanceId: "opencode" }];
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* StaleOpenCodeSessions;
          const first = yield* service.abort(sessions);
          const second = yield* service.abort(sessions).pipe(Effect.timeout("1 second"));
          return [first, second];
        }).pipe(Effect.provide(layer.pipe(Layer.provide(settings(external(server.url)))))),
      );
      expect(results).toEqual([
        { aborted: 0, failed: 1 },
        { aborted: 0, failed: 1 },
      ]);
      expect(requests).toBe(1);
    } finally {
      server.close();
    }
  }, 8_000);

  it("keeps trying after an HTTP failure", async () => {
    let requests = 0;
    const server = await serve((_req, res) => {
      requests++;
      res.writeHead(500);
      res.end();
    });
    try {
      const sessions = [
        { sessionId: "ses_error", directory: null, providerInstanceId: "opencode" },
      ];
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* StaleOpenCodeSessions;
          return [yield* service.abort(sessions), yield* service.abort(sessions)];
        }).pipe(Effect.provide(layer.pipe(Layer.provide(settings(external(server.url)))))),
      );
      expect(results).toEqual([
        { aborted: 0, failed: 1 },
        { aborted: 0, failed: 1 },
      ]);
      expect(requests).toBe(2);
    } finally {
      server.close();
    }
  });

  it("trips the breaker when the connection drops", async () => {
    let requests = 0;
    const server = await serve((req) => {
      requests++;
      req.socket.destroy();
    });
    try {
      const sessions = [
        { sessionId: "ses_reset", directory: null, providerInstanceId: "opencode" },
      ];
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* StaleOpenCodeSessions;
          return [yield* service.abort(sessions), yield* service.abort(sessions)];
        }).pipe(Effect.provide(layer.pipe(Layer.provide(settings(external(server.url)))))),
      );
      expect(results).toEqual([
        { aborted: 0, failed: 1 },
        { aborted: 0, failed: 1 },
      ]);
      expect(requests).toBe(1);
    } finally {
      server.close();
    }
  });

  it("makes no request for local or unknown configurations", async () => {
    let requests = 0;
    const server = await serve((_req, res) => {
      requests++;
      res.end();
    });
    try {
      const sessions = [{ sessionId: "ses_a", directory: null, providerInstanceId: "opencode" }];
      expect(await run({ opencode: { driver: "opencode", config: {} } }, sessions)).toEqual({
        aborted: 0,
        failed: 0,
      });
      expect(
        await run(
          { opencode: { driver: "opencode", config: { serverUrl: server.url } } },
          sessions,
        ),
      ).toEqual({ aborted: 0, failed: 0 });
      expect(requests).toBe(0);
    } finally {
      server.close();
    }
  });

  it("targets only the owning external provider instance", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const a = await serve((req, res) => {
      first.push(req.url!);
      res.end();
    });
    const b = await serve((req, res) => {
      second.push(req.url!);
      res.end();
    });
    try {
      const config = {
        ...external(a.url),
        other: { driver: "opencode", config: { serverUrl: b.url, serverPassword: "other" } },
        local: { driver: "opencode", config: {} },
      };
      expect(
        await run(config, [
          { sessionId: "ses_one", directory: null, providerInstanceId: "opencode" },
          { sessionId: "ses_two", directory: null, providerInstanceId: "other" },
          { sessionId: "ses_local", directory: null, providerInstanceId: "local" },
          { sessionId: "ses_missing", directory: null, providerInstanceId: "missing" },
        ]),
      ).toEqual({ aborted: 2, failed: 0 });
      expect(first).toEqual(["/api/session/ses_one/interrupt"]);
      expect(second).toEqual(["/api/session/ses_two/interrupt"]);
    } finally {
      a.close();
      b.close();
    }
  });
});
