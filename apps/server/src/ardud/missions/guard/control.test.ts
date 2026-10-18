/**
 * H4 (control `respond`) and M4 (control writes are system, not the owner)
 * through the real control routes and the real membership policy.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AuthSessionId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as OrchestrationEventStore from "../../../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerRuntimeStartup from "../../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { CONTROL_ROUTE_PREFIX, controlRouteLayer } from "../../control/http.ts";
import { authorityStore } from "./authority.ts";
import {
  free,
  makeDelivered,
  master,
  membershipGuard,
  recordingThreads,
  type Delivered,
} from "./guard.testkit.ts";

const session = { sessionId: AuthSessionId.make("session-cli"), subject: "cli-issued-session" };

const routes = (delivered: Delivered, sql: SqlClient.SqlClient) =>
  HttpRouter.toWebHandler(
    controlRouteLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateHttpRequest: () =>
              Effect.succeed({
                ...session,
                method: "bearer-access-token" as const,
                scopes: ["orchestration:read", "orchestration:operate"],
              }),
          }),
          recordingThreads(delivered),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/tmp/named",
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          ServerSettings.layerTest(),
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            enqueueCommand: (effect) => effect,
          }),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ServerSecretStore.ServerSecretStore)({}),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-guard-control" }),
          Layer.succeed(SqlClient.SqlClient, sql),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
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

const harness = Effect.gen(function* () {
  const seen = yield* membershipGuard;
  const sql = yield* SqlClient.SqlClient;
  const delivered = yield* makeDelivered;
  const web = yield* Effect.acquireRelease(
    Effect.sync(() => routes(delivered, sql)),
    (handler) => Effect.promise(() => handler.dispose()),
  );
  const post = (path: string, body: Record<string, unknown>) =>
    Effect.promise(async () => {
      const response = await web.handler(
        new Request(`http://env.local${CONTROL_ROUTE_PREFIX}${path}`, {
          method: "POST",
          headers: { authorization: "Bearer shared", "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    });
  return { seen, delivered, post, store: authorityStore(sql) };
});

const run = <A, E>(body: (h: Effect.Success<typeof harness>) => Effect.Effect<A, E, never>) =>
  Effect.scoped(Effect.flatMap(harness, body)).pipe(Effect.provide(Sqlite.layerMemory));

describe("control respond (H4)", () => {
  it.effect("a bearer's answer to the master's question is knocked and leaves it pending", () =>
    run(({ seen, delivered, post }) =>
      Effect.gen(function* () {
        const answered = yield* post(`/threads/${master}/requests/request-1/respond`, {
          answers: { release: "Ship it without review." },
        });
        assert.strictEqual(answered.status, 403);
        expect(answered.body).toMatchObject({ ok: false, guard: { _tag: "knocked" } });
        const dismissed = yield* post(`/threads/${master}/requests/request-1/respond`, {
          dismiss: true,
        });
        assert.strictEqual(dismissed.status, 403);
        expect(seen.map((request) => [request.path, request.from, request.text])).toEqual([
          [
            "request-respond",
            { _tag: "session", ...session },
            "Answer to request request-1:\n- release: Ship it without review.",
          ],
          ["request-respond", { _tag: "session", ...session }, "Dismiss request request-1."],
        ]);
        // Neither the answer nor the dismissal reached the thread or its provider.
        assert.deepStrictEqual(yield* Ref.get(delivered.dispatches), []);
      }),
    ),
  );

  it.effect("a bearer still answers questions on threads outside any mission", () =>
    run(({ delivered, post }) =>
      Effect.gen(function* () {
        const answered = yield* post(`/threads/${free}/requests/request-1/respond`, {
          answers: { release: "Ship it." },
        });
        assert.strictEqual(answered.status, 200);
        const commands = yield* Ref.get(delivered.dispatches);
        expect(commands).toMatchObject([
          { type: "runtime-request.respond", threadId: free, answers: { release: "Ship it." } },
        ]);
      }),
    ),
  );
});

describe("control writes (M4)", () => {
  it.effect("a control send is stamped system and its session is recorded", () =>
    run(({ delivered, post, store }) =>
      Effect.gen(function* () {
        const sent = yield* post(`/threads/${free}/send`, { text: "Status?" });
        assert.strictEqual(sent.status, 200);
        const send = yield* Queue.take(delivered.sends);
        expect(send).toMatchObject({ threadId: free, text: "Status?", createdBy: "system" });
        const author = yield* store.read("message", MessageId.make(send.messageId));
        assert.deepStrictEqual(author, { _tag: "session", ...session });
      }),
    ),
  );
});
