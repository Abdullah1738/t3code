import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as AuthHttp from "../../auth/http.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const DESKTOP_TOKEN = "desktop-bootstrap-token";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      desktopBootstrapToken: DESKTOP_TOKEN,
      port: 13_776,
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-missions-revoke-" })));

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(layerConfig),
);

type AuthRequest = Parameters<
  EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
>[0];

const client = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// The real auth routes, served over the same auth state the test mints sessions in.
const makeServer = Effect.gen(function* () {
  const context = yield* Effect.context<
    EnvironmentAuth.EnvironmentAuth | SessionStore.SessionStore | ServerConfig.ServerConfig
  >();
  const crypto = yield* Crypto.Crypto;
  const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
    Context.add(
      ServerSecretStore.ServerSecretStore,
      ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedNone,
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.die("Not used by these routes."),
        remove: () => Effect.void,
      }),
    ),
  );
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(AuthTestApi).pipe(
          Layer.provide(AuthHttp.layer),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
          Layer.provide(Layer.succeedContext(context)),
          Layer.provideMerge(
            HttpPlatform.layer.pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(Etag.layerWeak),
            ),
          ),
          Layer.provide(NodeServices.layer),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );
  return (path: string, headers: Readonly<Record<string, string>>, body: unknown = {}) =>
    Effect.promise(async () => {
      const response = await web.handler(
        new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: encodeJson(body),
        }),
        requestContext,
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    });
});

it.layer(Layer.provideMerge(layerAuth, NodeServices.layer))("missions owner sessions", (it) => {
  it.effect(
    "a session that is not the owner's cannot revoke an owner session; the owner can revoke anyone",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const sessions = yield* SessionStore.SessionStore;
          const post = yield* makeServer;
          const cookie = (token: string) => ({ cookie: `${sessions.cookieName}=${token}` });
          const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
          const alive = (request: AuthRequest) =>
            auth.authenticateHttpRequest(request).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
          const cookieAlive = (token: string) =>
            alive({ cookies: { [sessions.cookieName]: token }, headers: {} } as never);
          const bearerAlive = (token: string) =>
            alive({ cookies: {}, headers: bearer(token) } as never);

          // The desktop app is the owner; a link it issues pairs a second owner device.
          const desktop = yield* auth.createBrowserSession(DESKTOP_TOKEN, client);
          const desktopId = (yield* auth.authenticateHttpRequest({
            cookies: { [sessions.cookieName]: desktop.sessionToken },
            headers: {},
          } as never)).sessionId;
          const phone = yield* auth.createBrowserSession(
            (yield* auth.issuePairingCredential(undefined, { sessionId: desktopId })).credential,
            client,
          );
          const phoneSession = yield* auth.authenticateHttpRequest({
            cookies: { [sessions.cookieName]: phone.sessionToken },
            headers: {},
          } as never);
          expect(phoneSession.origin).toEqual({ _tag: "owner", source: "paired-client" });

          // The shared control token has access:write but is not the owner.
          const control = yield* auth.issueSession({ label: "bridges" });
          const laptop = yield* auth.createBrowserSession(
            (yield* auth.createPairingLink()).credential,
            client,
          );
          const laptopId = (yield* auth.authenticateHttpRequest({
            cookies: { [sessions.cookieName]: laptop.sessionToken },
            headers: {},
          } as never)).sessionId;

          // It cannot revoke either owner session.
          for (const target of [desktopId, phoneSession.sessionId]) {
            const refused = yield* post("/api/auth/clients/revoke", bearer(control.token), {
              sessionId: target,
            });
            expect(refused.status).toBe(403);
            expect(refused.body).toMatchObject({
              code: "operation_forbidden",
              reason: "owner_session_revoke_not_allowed",
            });
          }
          expect(yield* cookieAlive(desktop.sessionToken)).toBe(true);
          expect(yield* cookieAlive(phone.sessionToken)).toBe(true);
          // It still cannot revoke itself, and may still revoke a device that is not the owner.
          expect(
            (yield* post("/api/auth/clients/revoke", bearer(control.token), {
              sessionId: control.sessionId,
            })).body,
          ).toMatchObject({ reason: "current_session_revoke_not_allowed" });

          // "Revoke all others" from it spares the owner sessions.
          const others = yield* post("/api/auth/clients/revoke-others", bearer(control.token));
          expect(others).toEqual({ status: 200, body: { revokedCount: 1 } });
          expect(yield* cookieAlive(laptop.sessionToken)).toBe(false);
          expect(yield* cookieAlive(desktop.sessionToken)).toBe(true);
          expect(yield* cookieAlive(phone.sessionToken)).toBe(true);
          expect(yield* bearerAlive(control.token)).toBe(true);
          expect(laptopId).not.toBe(desktopId);

          // The owner revokes anyone, another owner device included.
          expect(
            yield* post("/api/auth/clients/revoke", cookie(desktop.sessionToken), {
              sessionId: control.sessionId,
            }),
          ).toEqual({ status: 200, body: { revoked: true } });
          expect(yield* bearerAlive(control.token)).toBe(false);
          expect(
            yield* post("/api/auth/clients/revoke", cookie(desktop.sessionToken), {
              sessionId: phoneSession.sessionId,
            }),
          ).toEqual({ status: 200, body: { revoked: true } });
          expect(yield* cookieAlive(phone.sessionToken)).toBe(false);
        }),
      ),
  );

  it.effect("the owner's revoke-all-others still revokes every other session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const post = yield* makeServer;

        const desktop = yield* auth.createBrowserSession(DESKTOP_TOKEN, client);
        const desktopId = (yield* auth.authenticateHttpRequest({
          cookies: { [sessions.cookieName]: desktop.sessionToken },
          headers: {},
        } as never)).sessionId;
        yield* auth.createBrowserSession(
          (yield* auth.issuePairingCredential(undefined, { sessionId: desktopId })).credential,
          client,
        );
        yield* auth.issueSession({ label: "bridges" });
        yield* auth.createBrowserSession((yield* auth.createPairingLink()).credential, client);

        const before = (yield* auth.listSessions()).length;
        const others = yield* post("/api/auth/clients/revoke-others", {
          cookie: `${sessions.cookieName}=${desktop.sessionToken}`,
        });
        expect(others).toEqual({ status: 200, body: { revokedCount: before - 1 } });
        expect((yield* auth.listSessions()).map((session) => session.sessionId)).toEqual([
          desktopId,
        ]);
      }),
    ),
  );
});
