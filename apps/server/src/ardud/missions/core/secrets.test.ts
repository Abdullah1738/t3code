/**
 * N7: a secret card is answered only by the paired owner. The answering
 * principal comes from the real auth session, as the WS handler derives it.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../../auth/SessionStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { issueComponentSession } from "../../auth/components.ts";
import { ownerAppProvenance } from "./provenance.ts";
import { SECRET_ANSWER_OWNER_REQUIRED } from "./secrets.ts";

const DESKTOP_TOKEN = "desktop-bootstrap-token";
const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");

const dispatched: Array<OrchestrationV2ServerCommand> = [];
let secretStatus = "pending";

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-missions-secrets-" });

const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadRecords: () =>
    Effect.succeed({
      thread: { projectId: ProjectId.make("project-1") },
      runs: [{ id: "run-1", status: "running" }],
      turnItems: [
        {
          id: turnItemId,
          threadId,
          runId: "run-1",
          nodeId: "node-root",
          type: "secret_request",
          label: "GitHub token",
          reason: "Used as GH_TOKEN.",
          secretStatus,
        },
      ],
    } as never),
  dispatch: (command) =>
    Effect.sync(() => {
      dispatched.push(command);
      if (command.type === "secret_request.record") secretStatus = command.secretStatus;
      return {} as never;
    }),
});

const layer = Layer.mergeAll(
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerEnvironment.layerIdentity),
  ),
  SecretRequests.layer.pipe(Layer.provide(layerThreads)),
).pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(
    Layer.effect(
      ServerConfig.ServerConfig,
      Effect.map(ServerConfig.ServerConfig, (config) => ({
        ...config,
        desktopBootstrapToken: DESKTOP_TOKEN,
        port: 13_775,
      })),
    ).pipe(Layer.provide(layerConfig)),
  ),
);

type AuthRequest = Parameters<
  EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
>[0];
const bearer = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as AuthRequest;
const cookie = (name: string, token: string) =>
  ({ cookies: { [name]: token }, headers: {} }) as unknown as AuthRequest;
const client = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

it.layer(Layer.provideMerge(layer, NodeServices.layer))("missions secret answers", (it) => {
  it.effect("N7: an operate bearer cannot answer a secret card; the owner's session can", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const secrets = yield* SecretRequests.SecretRequests;
      const answer = (session: EnvironmentAuth.AuthenticatedSession, secret: string) =>
        secrets.answer(
          { threadId, turnItemId, answer: { type: "save", secret } },
          // What ws.ts passes for this connection, even when it says it is the web UI.
          ownerAppProvenance({ surface: "web", session }),
        );

      // The shared control token and a component credential both carry orchestration:operate.
      const control = yield* auth.issueSession({ label: "bridges" });
      const controlSession = yield* auth.authenticateHttpRequest(bearer(control.token));
      expect(controlSession.scopes).toContain("orchestration:operate");
      const component = yield* issueComponentSession({ component: "crw" });
      const componentSession = yield* auth.authenticateHttpRequest(bearer(component.token));
      for (const session of [controlSession, componentSession]) {
        const refused = yield* answer(session, "planted-value").pipe(Effect.flip);
        expect(refused._tag).toBe("EnvironmentAuthorizationError");
        expect(refused.message).toBe(SECRET_ANSWER_OWNER_REQUIRED);
        const declined = yield* secrets
          .answer(
            { threadId, turnItemId, answer: { type: "decline" } },
            ownerAppProvenance({ surface: "web", session }),
          )
          .pipe(Effect.flip);
        expect(declined._tag).toBe("EnvironmentAuthorizationError");
      }
      // Nothing was stored for the card and nothing recorded on the thread.
      expect(dispatched).toEqual([]);
      expect(Option.isNone(yield* secrets.savedRef({ threadId, turnItemId }))).toBe(true);

      // The desktop app's renderer session is the owner and saves the value.
      const desktop = yield* auth.createBrowserSession(DESKTOP_TOKEN, client);
      const ownerSession = yield* auth.authenticateHttpRequest(
        cookie(sessions.cookieName, desktop.sessionToken),
      );
      yield* answer(ownerSession, "ghp_owner");
      expect(dispatched.map((command) => command.type)).toEqual(["secret_request.record"]);
      const ref = Option.getOrThrow(yield* secrets.savedRef({ threadId, turnItemId }));
      expect(yield* secrets.consume({ ref, projectId: ProjectId.make("project-1") })).toBe(
        "ghp_owner",
      );
    }),
  );
});
