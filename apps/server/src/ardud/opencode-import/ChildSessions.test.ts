// @effect-diagnostics nodeBuiltinImport:off - the fake OpenCode server is plain Node http.
import * as NodeHttp from "node:http";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkChildren } from "./ChildSessions.ts";

const serve = (handler: NodeHttp.RequestListener) =>
  new Promise<{ readonly url: string; readonly close: () => void }>((resolve) => {
    const server = NodeHttp.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });

const json = (res: NodeHttp.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const settingsFor = (serverUrl: string | undefined) => ({
  getSettings: Effect.succeed({
    providerInstances: serverUrl === undefined
      ? {}
      : {
          opencode: {
            driver: "opencode",
            config: { serverUrl, serverPassword: "pw" },
          },
        },
  }),
}) as never;

const messages = (rows: ReadonlyArray<Record<string, unknown>>) => ({
  data: rows,
  cursor: null,
});

const SINCE = Date.UTC(2026, 9, 28, 10, 0, 0);

describe("checkChildren", () => {
  it("reports a child that is still in the active list as running", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/api/session/active") return json(res, 200, { data: { ses_a: {} } });
      json(res, 500, {});
    });
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_a", since: SINCE }]),
      );
      expect(result.get("ses_a")).toEqual({ state: "running" });
    } finally {
      server.close();
    }
  });

  it("reports a finished child with its last answer", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/api/session/active") return json(res, 200, { data: {} });
      if (req.url?.startsWith("/api/session/ses_b/message"))
        return json(
          res,
          200,
          messages([
            {
              id: "m2",
              type: "assistant",
              finish: "stop",
              time: { created: SINCE + 60_000 },
              content: [{ type: "text", text: "Review done: no findings." }],
            },
          ]),
        );
      json(res, 500, {});
    });
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_b", since: SINCE }]),
      );
      expect(result.get("ses_b")).toEqual({
        state: "finished",
        result: "Review done: no findings.",
      });
    } finally {
      server.close();
    }
  });

  it("treats a stale success from before the child started as stopped", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/api/session/active") return json(res, 200, { data: {} });
      if (req.url?.startsWith("/api/session/ses_c/message"))
        return json(
          res,
          200,
          messages([
            {
              id: "m1",
              type: "assistant",
              finish: "stop",
              time: { created: SINCE - 3_600_000 },
              content: [{ type: "text", text: "old answer" }],
            },
          ]),
        );
      json(res, 500, {});
    });
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_c", since: SINCE }]),
      );
      expect(result.get("ses_c")).toEqual({ state: "stopped" });
    } finally {
      server.close();
    }
  });

  it("gives no result for an assistant turn that errored", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/api/session/active") return json(res, 200, { data: {} });
      if (req.url?.startsWith("/api/session/ses_d/message"))
        return json(
          res,
          200,
          messages([
            {
              id: "m3",
              type: "assistant",
              finish: "stop",
              error: { message: "boom" },
              time: { created: SINCE + 60_000 },
              content: [{ type: "text", text: "partial" }],
            },
          ]),
        );
      json(res, 500, {});
    });
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_d", since: SINCE }]),
      );
      expect(result.get("ses_d")?.result).toBeUndefined();
      expect(result.get("ses_d")?.state).not.toBe("finished");
    } finally {
      server.close();
    }
  });

  it("reports a session OpenCode does not know as stopped", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/api/session/active") return json(res, 200, { data: {} });
      json(res, 404, { error: "not found" });
    });
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_e", since: SINCE }]),
      );
      expect(result.get("ses_e")).toEqual({ state: "stopped" });
    } finally {
      server.close();
    }
  });

  it("reports a failed read as unknown, never as stopped", async () => {
    const server = await serve((_req, res) => json(res, 503, { error: "busy" }));
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_f", since: SINCE }]),
      );
      expect(result.get("ses_f")).toEqual({ state: "unknown" });
    } finally {
      server.close();
    }
  });

  it("reports every child as stopped when no external OpenCode server is configured", async () => {
    const result = await Effect.runPromise(
      checkChildren(settingsFor(undefined), [{ sessionId: "ses_g", since: SINCE }]),
    );
    expect(result.get("ses_g")).toEqual({ state: "stopped" });
  });
});
