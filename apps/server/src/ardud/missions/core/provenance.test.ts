import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../../auth/SessionStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import { ownerAppProvenance } from "./provenance.ts";

const layerServerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return { ...config, port: 13_774 } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-missions-owner-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerServerConfig),
);

type AuthRequest = Parameters<
  EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
>[0];

const cookieRequest = (cookieName: string, token: string) =>
  ({ cookies: { [cookieName]: token }, headers: {} }) as unknown as AuthRequest;

const bearerRequest = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as AuthRequest;

const client = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

it.layer(NodeServices.layer)("missions owner proof", (it) => {
  it.effect("a session made by pairing a Robob client is the owner; issued tokens never are", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      // Web or desktop renderer: a pairing credential exchanged for a browser cookie.
      const browserPairing = yield* auth.issuePairingCredential();
      const browser = yield* auth.createBrowserSession(browserPairing.credential, client);
      const browserSession = yield* auth.authenticateHttpRequest(
        cookieRequest(sessions.cookieName, browser.sessionToken),
      );
      expect(ownerAppProvenance({ surface: "web", session: browserSession })).toEqual({
        _tag: "owner-app",
        surface: "web",
        sessionId: browserSession.sessionId,
      });
      // The surface still has to name a client UI.
      expect(ownerAppProvenance({ surface: "cli", session: browserSession })).toBeNull();
      expect(ownerAppProvenance({ surface: undefined, session: browserSession })).toBeNull();

      // Mobile: a pairing credential exchanged for a bearer token.
      const mobilePairing = yield* auth.issuePairingCredential();
      const mobile = yield* auth.exchangeBootstrapCredentialForAccessToken(
        mobilePairing.credential,
        undefined,
        { ...client, deviceType: "mobile" },
      );
      const mobileSession = yield* auth.authenticateHttpRequest(bearerRequest(mobile.access_token));
      expect(ownerAppProvenance({ surface: "mobile", session: mobileSession })?._tag).toBe(
        "owner-app",
      );

      // MCP OAuth bearer claiming to be the web app: not the owner.
      const mcp = yield* auth.issueMcpClientSession({
        label: "Claude Code",
        access: "full-access",
        client,
      });
      const mcpSession = yield* sessions.verify(mcp.token);
      expect(mcpSession.subject).toBe("mcp-client");
      expect(ownerAppProvenance({ surface: "web", session: mcpSession })).toBeNull();

      // CLI-issued bearer (`t3 auth session issue`, the control token): not the owner.
      const issued = yield* auth.issueSession({ label: "bridges" });
      const issuedSession = yield* auth.authenticateHttpRequest(bearerRequest(issued.token));
      expect(issuedSession.subject).toBe("cli-issued-session");
      expect(ownerAppProvenance({ surface: "web", session: issuedSession })).toBeNull();
      expect(ownerAppProvenance({ surface: "desktop", session: issuedSession })).toBeNull();

      // A custom subject is never the owner either.
      const custom = yield* auth.issueSession({ subject: "my-script" });
      const customSession = yield* auth.authenticateHttpRequest(bearerRequest(custom.token));
      expect(ownerAppProvenance({ surface: "web", session: customSession })).toBeNull();
    }).pipe(Effect.provide(layerEnvironmentAuth)),
  );
});
