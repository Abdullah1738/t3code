import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  optionalMcpRegistration,
  mcpStartupTimeoutMs,
  type McpRegistrationStatus,
} from "./optionalRegistration.ts";

describe("optional MCP registration", () => {
  it.effect("recall failure preserves a healthy sibling and retries with caller config", () =>
    Effect.gen(function* () {
      const statuses: McpRegistrationStatus[] = [];
      let calls = 0;
      const registration = optionalMcpRegistration({
        servers: ["recall", "t3-code"],
        timeoutMs: 5000,
        register: async () => {
          calls++;
          return { errors: { recall: "secret must not escape" } };
        },
        reconnect: async (servers) => {
          assert.deepEqual(servers, ["recall"]);
          calls++;
          return { errors: {} };
        },
        report: (status) =>
          Effect.sync(() => {
            statuses.push(status);
          }),
      });
      yield* registration.attempt;
      assert.deepEqual(
        statuses.map((s) => [s.server, s.status, s.reason]),
        [
          ["recall", "unavailable", "connection_failed"],
          ["t3-code", "available", "connected"],
        ],
      );
      yield* registration.attempt;
      assert.equal(calls, 1);
      yield* TestClock.adjust(1000);
      yield* registration.attempt;
      assert.equal(calls, 2);
      assert.isTrue(statuses.slice(2).every((s) => s.status === "available"));
      assert.notInclude(JSON.stringify(statuses), "secret");
    }),
  );
  it.effect("control rejection marks every supplied server unavailable without failing", () =>
    Effect.gen(function* () {
      const statuses: McpRegistrationStatus[] = [];
      yield* optionalMcpRegistration({
        servers: ["recall", "t3-code"],
        timeoutMs: 5000,
        register: () => Promise.reject(new Error("Bearer secret")),
        report: (status) =>
          Effect.sync(() => {
            statuses.push(status);
          }),
      }).attempt;
      assert.equal(statuses.length, 2);
      assert.isTrue(
        statuses.every((s) => s.status === "unavailable" && s.reason === "control_rejected"),
      );
    }),
  );
  it.effect(
    "hung control is bounded; no overlapping replacement; late result cannot change status",
    () =>
      Effect.gen(function* () {
        let resolve!: (result: { errors: Record<string, unknown> }) => void;
        let calls = 0;
        const statuses: McpRegistrationStatus[] = [];
        const registration = optionalMcpRegistration({
          servers: ["recall"],
          timeoutMs: 5000,
          register: () => {
            calls++;
            return new Promise((done) => {
              resolve = done;
            });
          },
          report: (status) =>
            Effect.sync(() => {
              statuses.push(status);
            }),
        });
        const fiber = yield* registration.attempt.pipe(Effect.forkChild);
        yield* TestClock.adjust(5000);
        yield* Fiber.join(fiber);
        assert.equal(statuses[0]?.reason, "timeout");
        yield* TestClock.adjust(1000);
        yield* registration.attempt;
        assert.equal(calls, 1);
        resolve({ errors: {} });
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(statuses.length, 1);
        yield* registration.close;
        yield* registration.attempt;
        assert.equal(calls, 1);
      }),
  );
  it.effect("re-registers after rejection before trying to reconnect missing configs", () =>
    Effect.gen(function* () {
      let calls = 0;
      const statuses: McpRegistrationStatus[] = [];
      const registration = optionalMcpRegistration({
        servers: ["recall"],
        timeoutMs: 5000,
        register: async () => {
          if (++calls === 1) throw new Error("not installed");
          return { errors: {} };
        },
        reconnect: async () => {
          throw new Error("should register missing configs first");
        },
        report: (status) =>
          Effect.sync(() => {
            statuses.push(status);
          }),
      });
      yield* registration.attempt;
      yield* TestClock.adjust(1000);
      yield* registration.attempt;
      assert.equal(calls, 2);
      assert.equal(statuses.at(-1)?.status, "available");
    }),
  );
  it("bounds the configurable deadline", () => {
    assert.equal(mcpStartupTimeoutMs({}), 5000);
    assert.equal(mcpStartupTimeoutMs({ ROBOB_MCP_STARTUP_TIMEOUT_MS: "9000" }), 9000);
    assert.equal(mcpStartupTimeoutMs({ ROBOB_MCP_STARTUP_TIMEOUT_MS: "900000" }), 10000);
  });
});
