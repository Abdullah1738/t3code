import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peerCwd = path.join(import.meta.dirname, "..");
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: peerCwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const layerClient = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerClient, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const path = yield* Path.Path;
        const peerCwd = path.join(import.meta.dirname, "..");
        const skills = yield* client.request("skills/list", { cwds: [peerCwd] });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, peerCwd);

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          isBlocking: true,
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );
  it.effect("drains child stderr so large diagnostics cannot block protocol responses", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STDERR_BYTES: String(512 * 1024),
      });
      const scope = yield* Scope.make();
      const layerClient = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerClient, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );
  const initializeParams = {
    clientInfo: {
      name: "effect-codex-app-server-test",
      title: "Effect Codex App Server Test",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: null,
    },
  } as const;

  const exitDuringResume = (env: Record<string, string>) =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_EXIT_ON_METHOD: "thread/resume",
        ...env,
      });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(CodexClient.layerChildProcess(handle), scope);
      return yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        yield* client.request("initialize", initializeParams);
        const failure = yield* client.raw
          .request("thread/resume", { threadId: "thread-1" })
          .pipe(Effect.asVoid, Effect.flip);
        const terminated = yield* client.awaitTermination;
        return { failure, terminated, pid: handle.pid };
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );
    }).pipe(Effect.orDie);

  it.effect("names the last stderr line when the App Server exits during a request", () =>
    Effect.gen(function* () {
      const { failure, terminated, pid } = yield* exitDuringResume({
        CODEX_APP_SERVER_TEST_EXIT_STDERR:
          "starting\n\u001b[31mError: failed to open state db: database is locked\u001b[0m\n\n",
      });
      assert.equal(failure._tag, "CodexAppServerProcessExitedError");
      assert.strictEqual(terminated, failure);
      if (failure._tag !== "CodexAppServerProcessExitedError") return;
      assert.equal(failure.code, 0);
      assert.include(failure.stderrTail ?? "", "starting");
      assert.equal(
        failure.message,
        `Codex App Server process ${pid} exited with code 0: Error: failed to open state db: database is locked`,
      );
    }),
  );

  it.effect("says when an exited App Server printed nothing to stderr", () =>
    Effect.gen(function* () {
      const { failure, pid } = yield* exitDuringResume({});
      assert.equal(
        failure.message,
        `Codex App Server process ${pid} exited with code 0 (no stderr output)`,
      );
    }),
  );

  it.effect("keeps only a bounded, redacted stderr tail from a flooding App Server", () =>
    Effect.gen(function* () {
      const { failure } = yield* exitDuringResume({
        CODEX_APP_SERVER_TEST_EXIT_STDERR_FLOOD_BYTES: String(512 * 1024),
        CODEX_APP_SERVER_TEST_EXIT_STDERR:
          "\nrequest failed: Authorization: Bearer abc.def-123\nfatal: upstream returned 401 for sk-proj1234567890\n",
      });
      if (failure._tag !== "CodexAppServerProcessExitedError") {
        return assert.fail(`unexpected ${failure._tag}`);
      }
      const tail = failure.stderrTail ?? "";
      assert.isAtMost(tail.length, 8_192);
      assert.notInclude(tail, "abc.def-123");
      assert.notInclude(tail, "sk-proj1234567890");
      assert.match(
        failure.message,
        /exited with code 0: fatal: upstream returned 401 for \[redacted\]$/,
      );
    }),
  );
});
