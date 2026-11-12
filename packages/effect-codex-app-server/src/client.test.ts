import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
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
import * as CodexError from "./errors.ts";
import { boundStderrTail } from "./_internal/stdio.ts";

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
  it.effect("redacts credentials Codex prints as JSON or key=value before keeping them", () =>
    Effect.gen(function* () {
      const { failure } = yield* exitDuringResume({
        CODEX_APP_SERVER_TEST_EXIT_STDERR: [
          'request body {"api_key":"dummy-api-key","access_token":"dummy-access-token"}',
          "retrying with refresh_token=dummy-refresh password: dummy-password",
          "GET https://user:dummy-pass@example.test/v1?token=dummy-query-token failed",
          `{"password":"dummy'password-suffix"}`,
          String.raw`{"api_key":"dummy\"escaped-suffix"}`,
          "retrying with password=dummy'unquoted-suffix and refresh_token=dummy-token'refresh-suffix",
          'fatal: {"client_secret": "dummy-client-secret"}',
          "",
        ].join("\n"),
      });
      const rendered = `${failure.message}\n${JSON.stringify(failure)}\n${Cause.pretty(Cause.fail(failure))}`;
      for (const secret of [
        "dummy-api-key",
        "dummy-access-token",
        "dummy-refresh",
        "dummy-password",
        "dummy-pass",
        "dummy-query-token",
        "dummy-client-secret",
        "password-suffix",
        "escaped-suffix",
        "unquoted-suffix",
        "refresh-suffix",
      ]) {
        assert.notInclude(rendered, secret);
      }
      assert.include(failure.message, '{"client_secret": "[redacted]"}');
    }),
  );

  it.effect("recognises a usage-limit exit only from Codex's last stderr line", () =>
    Effect.gen(function* () {
      const limited = yield* exitDuringResume({
        CODEX_APP_SERVER_TEST_EXIT_STDERR:
          "starting\nYou've hit your usage limit. Upgrade to Pro or try again at Nov 16th, 2026 9:47 AM.\n",
      });
      if (limited.failure._tag !== "CodexAppServerProcessExitedError") {
        return assert.fail(`unexpected ${limited.failure._tag}`);
      }
      assert.deepEqual(limited.failure.providerUsageLimit, {
        resetAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-11-16T09:47:00"))),
      });

      const earlier = yield* exitDuringResume({
        CODEX_APP_SERVER_TEST_EXIT_STDERR:
          "You've hit your usage limit. Try again later.\nfatal: state db is locked\n",
      });
      if (earlier.failure._tag !== "CodexAppServerProcessExitedError") {
        return assert.fail(`unexpected ${earlier.failure._tag}`);
      }
      assert.isUndefined(earlier.failure.providerUsageLimit);
    }),
  );
});

it.each([
  ['{"api_key":"S1"}', '{"api_key":"[redacted]"}'],
  ["{'password': 'S1'}", "{'password': '[redacted]'}"],
  ['{"refresh_token" : "S1"}', '{"refresh_token" : "[redacted]"}'],
  ["access_token=S1&x=1", "access_token=[redacted]&x=1"],
  ["client_secret: S1", "client_secret: [redacted]"],
  ["Authorization: Bearer S1", "Authorization: [redacted] [redacted]"],
  ["x-api-key: S1", "x-api-key: [redacted]"],
  ["token='S1'", "token=[redacted]"],
  ["see https://u:S1@host.test/p", "see https://host.test/p"],
  ["GET https://host.test/p?key=S1#frag", "GET https://host.test/p#frag"],
  ["key sk-S1abcdefghij", "key [redacted]"],
  ["fatal: database is locked", "fatal: database is locked"],
  [`{"password":"S1'password-suffix"}`, '{"password":"[redacted]"}'],
  [String.raw`{"api_key":"S1\"escaped-suffix"}`, '{"api_key":"[redacted]"}'],
  [`{'secret': 'S1"quote-suffix'}`, "{'secret': '[redacted]'}"],
  [String.raw`{'token': 'S1\'escaped-suffix'}`, "{'token': '[redacted]'}"],
  ['{"token": 12345, "id": 7}', '{"token": [redacted], "id": 7}'],
  ['{"password":"S1-unterminated-suffix', '{"password":"[redacted]"'],
  [`password="S1'pw-suffix" next`, "password=[redacted] next"],
  [String.raw`secret="S1\"escaped-suffix" next`, "secret=[redacted] next"],
  [String.raw`token='S1\'escaped-suffix' next`, "token=[redacted] next"],
  ["refresh_token=S1-unterminated'suffix", "refresh_token=[redacted]"],
  ["password=S1'password-suffix", "password=[redacted]"],
  ["refresh_token=S1-token'suffix next", "refresh_token=[redacted] next"],
  [`api_key: S1"dq-suffix; next`, "api_key: [redacted]; next"],
  [`{"token": S1'x-suffix, "id": 7}`, '{"token": [redacted], "id": 7}'],
])("redacts %s from the stderr tail", (line, expected) => {
  assert.equal(boundStderrTail(line), expected);
});

it.each([
  ["You've hit your usage limit. Try again at Nov 16th, 2026 9:47 AM.", "2026-11-16T09:47:00"],
  [
    "You’ve hit your usage limit. try again after November 3rd, 2026 10:05 PM",
    "2026-11-03T22:05:00",
  ],
  ["error: Usage limit reached", null],
  ["stream error: usageLimitExceeded", null],
  ["You've hit your usage limit. Try again at someday.", null],
])("reads %s as a usage-limit exit", (line, localReset) => {
  const error = new CodexError.CodexAppServerProcessExitedError({
    code: 1,
    stderrTail: `boot\n${line}\n`,
  });
  assert.deepEqual(error.providerUsageLimit, {
    resetAt:
      localReset === null ? null : DateTime.formatIso(DateTime.makeUnsafe(Date.parse(localReset))),
  });
});

it.each(["usage limit is 80% used", "fatal: database is locked", ""])(
  "does not read %j as a usage-limit exit",
  (line) => {
    const error = new CodexError.CodexAppServerProcessExitedError({ code: 0, stderrTail: line });
    assert.isUndefined(error.providerUsageLimit);
  },
);

const DUBAI = DateTime.zoneMakeNamedUnsafe("Asia/Dubai");
it.each([
  ["Nov 16th, 2026 9:47 AM", "2026-11-12T07:30:00.000Z", "2026-11-16T05:47:00.000Z"],
  ["Nov 16th 9:47 AM", "2026-11-12T07:30:00.000Z", "2026-11-16T05:47:00.000Z"],
  ["November 16 9:47 am", "2026-11-12T07:30:00.000Z", "2026-11-16T05:47:00.000Z"],
  ["Jan 2nd 9:00 AM", "2026-12-30T10:00:00.000Z", "2027-01-02T05:00:00.000Z"],
  ["Nov 12th 11:00 AM", "2026-11-12T07:30:00.000Z", "2026-11-12T07:00:00.000Z"],
  ["3:05 PM", "2026-11-12T07:30:00.000Z", "2026-11-12T11:05:00.000Z"],
  ["9:00 AM", "2026-11-12T07:30:00.000Z", "2026-11-13T05:00:00.000Z"],
  ["21:15", "2026-11-12T07:30:00.000Z", "2026-11-12T17:15:00.000Z"],
  ["Nov 16th, 2026 9:47 AM", undefined, "2026-11-16T05:47:00.000Z"],
  ["Nov 16th 9:47 AM", undefined, null],
  ["9:47 AM", undefined, null],
  ["Feb 31st, 2026 9:00 AM", "2026-11-12T07:30:00.000Z", null],
  ["Foo 3rd 9:00 AM", "2026-11-12T07:30:00.000Z", null],
  ["13:05 PM", "2026-11-12T07:30:00.000Z", null],
  ["someday", "2026-11-12T07:30:00.000Z", null],
])("reads the reset in 'try again at %s' (exited %s) as %s", (when, exitedAt, expected) => {
  assert.equal(
    CodexError.codexUsageLimitResetAt(
      `You've hit your usage limit. Upgrade to Pro or try again at ${when}.`,
      exitedAt,
      DUBAI,
    ),
    expected,
  );
});

const NEW_YORK = DateTime.zoneMakeNamedUnsafe("America/New_York");
it.each([
  // Fall back: Sun 1 Nov 2026 02:00 EDT -> 01:00 EST; 9:00 AM next day is EST.
  ["9:00 AM", "2026-10-31T22:00:00.000Z", "2026-11-01T14:00:00.000Z"],
  // Spring forward: Sun 8 Mar 2026 02:00 EST -> 03:00 EDT; 9:00 AM next day is EDT.
  ["9:00 AM", "2026-03-07T23:00:00.000Z", "2026-03-08T13:00:00.000Z"],
  // Same day, before the change, stays on today's offset.
  ["11:00 PM", "2026-10-31T22:00:00.000Z", "2026-11-01T03:00:00.000Z"],
])(
  "rolls 'try again at %s' (exited %s) to the next local day across DST as %s",
  (when, exitedAt, expected) => {
    assert.equal(
      CodexError.codexUsageLimitResetAt(
        `You've hit your usage limit. Try again at ${when}.`,
        exitedAt,
        NEW_YORK,
      ),
      expected,
    );
  },
);

it("anchors a yearless reset notice on the exit time, not an invented year", () => {
  const stderrTail = "You've hit your usage limit. Try again at Nov 16th 9:47 AM.";
  const anchored = new CodexError.CodexAppServerProcessExitedError({
    code: 1,
    stderrTail,
    exitedAt: "2026-11-12T07:30:00.000Z",
  });
  assert.equal(
    anchored.providerUsageLimit?.resetAt,
    DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-11-16T09:47:00"))),
  );
  const unanchored = new CodexError.CodexAppServerProcessExitedError({ code: 1, stderrTail });
  assert.deepEqual(unanchored.providerUsageLimit, { resetAt: null });
});
