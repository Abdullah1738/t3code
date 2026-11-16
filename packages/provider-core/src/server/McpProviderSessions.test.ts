import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "./McpProviderSessions.ts";

it.effect.each([
  { name: "own runtime", binding: "runtime:own", thread: "thread:own", accepted: true },
  {
    name: "replacement runtime",
    binding: "runtime:replacement",
    thread: "thread:own",
    accepted: false,
  },
  { name: "unbound record", binding: undefined, thread: "thread:own", accepted: false },
  { name: "other thread", binding: "runtime:own", thread: "thread:other", accepted: true },
] as const)(
  "reads credentials only for the owning runtime: $name",
  ({ binding, thread, accepted }) =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const credential = {
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread:own"),
        providerSessionId: "credential-uuid",
        ...(binding === undefined
          ? {}
          : { runtimeProviderSessionId: ProviderSessionId.make(binding) }),
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://localhost/mcp",
        authorizationHeader: "Bearer test-token",
        browserToolsAvailable: false,
      };
      yield* sessions.set(credential);
      const result = yield* McpProviderSessions.readForRuntime(
        sessions,
        ThreadId.make(thread),
        ProviderSessionId.make("runtime:own"),
        ProviderDriverKind.make("codex"),
      ).pipe(Effect.result);
      if (accepted) {
        assert.equal(result._tag, "Success");
        if (result._tag === "Success")
          assert.deepEqual(result.success, thread === "thread:own" ? credential : undefined);
      } else {
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.include(result.failure.detail, "not owned by this provider runtime");
          assert.notInclude(String(result.failure), credential.authorizationHeader);
        }
      }
    }).pipe(Effect.provide(McpProviderSessions.layer)),
);
