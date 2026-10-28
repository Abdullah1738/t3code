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
              id: "idle2",
              type: "idle",
              outcome: "succeeded",
              time: { created: SINCE + 61_500 },
            },
            {
              id: "m2",
              type: "assistant",
              finish: "stop",
              time: { created: SINCE + 60_000, completed: SINCE + 61_000 },
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

  it("finishes a child when the newest idle message reports a successful outcome", async () => {
    // Recorded REST shape: the message list ends with an idle entry carrying the outcome.
    const server = await serve((req, res) => {
      if (req.url === "/api/session/active") return json(res, 200, { data: {} });
      if (req.url?.startsWith("/api/session/ses_j/message"))
        return json(
          res,
          200,
          messages([
            {
              id: "idle1",
              type: "idle",
              outcome: "succeeded",
              time: { created: SINCE + 9_500 },
            },
            {
              id: "m5",
              type: "assistant",
              finish: "stop",
              time: { created: SINCE + 2_000, completed: SINCE + 9_000 },
              content: [{ type: "text", text: "Idle then answer: 3 findings." }],
            },
            {
              id: "m6",
              type: "user",
              time: { created: SINCE + 1_000 },
              content: [{ type: "text", text: "review this" }],
            },
          ]),
        );
      json(res, 500, {});
    });
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_j", since: SINCE }]),
      );
      expect(result.get("ses_j")).toEqual({
        state: "finished",
        result: "Idle then answer: 3 findings.",
      });
    } finally {
      server.close();
    }
  });

  it("finishes a child whose completed answer follows the active list draining", async () => {
    // Protocol shape: the session leaves the active list once it is idle, and
    // the answer it left behind is complete with a finish and a completion time.
    const server = await serve((req, res) => {
      if (req.url === "/api/session/active") return json(res, 200, { data: {} });
      if (req.url?.startsWith("/api/session/ses_h/message"))
        return json(
          res,
          200,
          // OpenCode lists messages newest first.
          messages([
            {
              id: "idle3",
              type: "idle",
              outcome: "succeeded",
              time: { created: SINCE + 9_500 },
            },
            {
              id: "m2",
              type: "assistant",
              finish: "stop",
              time: { created: SINCE + 2_000, completed: SINCE + 9_000 },
              content: [{ type: "text", text: "Done: 2 findings." }],
            },
            {
              id: "m1",
              type: "user",
              time: { created: SINCE + 1_000 },
              content: [{ type: "text", text: "review this" }],
            },
          ]),
        );
      json(res, 500, {});
    });
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_h", since: SINCE }]),
      );
      expect(result.get("ses_h")).toEqual({ state: "finished", result: "Done: 2 findings." });
    } finally {
      server.close();
    }
  });

  it("does not quote an answer that never recorded completion", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/api/session/active") return json(res, 200, { data: {} });
      if (req.url?.startsWith("/api/session/ses_i/message"))
        return json(
          res,
          200,
          messages([
            {
              id: "m4",
              type: "assistant",
              finish: "stop",
              time: { created: SINCE + 60_000 },
              content: [{ type: "text", text: "half written" }],
            },
          ]),
        );
      json(res, 500, {});
    });
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_i", since: SINCE }]),
      );
      expect(result.get("ses_i")?.result).toBeUndefined();
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

describe("checkChildren idle outcome", () => {
  // A list newest first, the way OpenCode returns it.
  const listing = (path: string, rows: ReadonlyArray<Record<string, unknown>>) =>
    (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => {
      if (req.url === "/api/session/active") return json(res, 200, { data: {} });
      if (req.url?.startsWith(`/api/session/${path}/message`)) return json(res, 200, messages(rows));
      json(res, 500, {});
    };

  it("stops a child whose successful idle is older than newer messages with no idle", async () => {
    // A success from before the child started, then a new answer and no idle after it.
    const server = await serve(
      listing("ses_stale", [
        {
          id: "new-answer",
          type: "assistant",
          finish: "stop",
          time: { created: SINCE + 30_000, completed: SINCE + 31_000 },
          content: [{ type: "text", text: "new execution answer" }],
        },
        {
          id: "old-idle",
          type: "idle",
          outcome: "succeeded",
          time: { created: SINCE - 3_600_000 },
        },
      ]),
    );
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_stale", since: SINCE }]),
      );
      expect(result.get("ses_stale")).toEqual({ state: "stopped" });
    } finally {
      server.close();
    }
  });

  it("stops a child whose newest execution failed after an earlier successful idle", async () => {
    const server = await serve(
      listing("ses_failed", [
        {
          id: "failed-idle",
          type: "idle",
          outcome: "failed",
          time: { created: SINCE + 40_000 },
        },
        {
          id: "earlier-answer",
          type: "assistant",
          finish: "stop",
          time: { created: SINCE + 2_000, completed: SINCE + 3_000 },
          content: [{ type: "text", text: "earlier execution" }],
        },
      ]),
    );
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_failed", since: SINCE }]),
      );
      expect(result.get("ses_failed")).toEqual({ state: "stopped" });
    } finally {
      server.close();
    }
  });

  it("finishes a child whose successful idle has no quotable answer, without a result", async () => {
    const server = await serve(
      listing("ses_noquote", [
        {
          id: "ok-idle",
          type: "idle",
          outcome: "succeeded",
          time: { created: SINCE + 9_500 },
        },
      ]),
    );
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_noquote", since: SINCE }]),
      );
      expect(result.get("ses_noquote")).toEqual({ state: "finished" });
    } finally {
      server.close();
    }
  });

  it("finishes a child whose successful idle answer has empty text", async () => {
    const server = await serve(
      listing("ses_empty", [
        {
          id: "ok-idle2",
          type: "idle",
          outcome: "succeeded",
          time: { created: SINCE + 9_500 },
        },
        {
          id: "blank",
          type: "assistant",
          finish: "stop",
          time: { created: SINCE + 2_000, completed: SINCE + 9_000 },
          content: [{ type: "text", text: "   " }],
        },
      ]),
    );
    try {
      const result = await Effect.runPromise(
        checkChildren(settingsFor(server.url), [{ sessionId: "ses_empty", since: SINCE }]),
      );
      expect(result.get("ses_empty")).toEqual({ state: "finished" });
    } finally {
      server.close();
    }
  });
});
