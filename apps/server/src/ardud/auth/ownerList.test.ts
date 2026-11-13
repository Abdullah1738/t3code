/** The sessions list says which sessions are the owner's, so Settings > Connections can show the ones that are not. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isDeviceNotPairedAsOwner } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const DESKTOP_TOKEN = "desktop-bootstrap-token";

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      desktopBootstrapToken: DESKTOP_TOKEN,
      port: 13_777,
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-owner-list-" })));

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(layerConfig),
);

const client = { deviceType: "mobile" as const, os: "iOS", browser: "Safari" };

it.layer(Layer.provideMerge(layerAuth, NodeServices.layer))("owner standing in the sessions list", (it) => {
  it.effect(
    "marks the desktop app and a Settings-paired device as the owner's, and a Mac-link device as not",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const idOf = (sessionToken: string) =>
          auth
            .authenticateHttpRequest({
              cookies: { [sessions.cookieName]: sessionToken },
              headers: {},
            } as never)
            .pipe(Effect.map((session) => session.sessionId));

        // The desktop app, and a phone paired from a link it made in Settings > Connections.
        const desktopToken = (yield* auth.createBrowserSession(DESKTOP_TOKEN, client)).sessionToken;
        const desktop = yield* idOf(desktopToken);
        const settingsPaired = yield* idOf(
          (yield* auth.createBrowserSession(
            (yield* auth.issuePairingCredential({ label: "iPhone" }, { sessionId: desktop }))
              .credential,
            client,
          )).sessionToken,
        );
        // A phone paired from a link made on the Mac (`t3 pair`).
        const macLinkToken = (yield* auth.createBrowserSession(
          (yield* auth.createPairingLink({ subject: "one-time-token", label: "t3 pair" }))
            .credential,
          client,
        )).sessionToken;
        const macLink = yield* idOf(macLinkToken);
        // A hand-issued token (`t3 auth session issue`, the old control token).
        const token = yield* auth.issueSession({ label: "bridges" });

        const listed = yield* auth.listClientSessions(desktop);
        const row = (sessionId: string) => listed.find((entry) => entry.sessionId === sessionId)!;
        expect(row(desktop)).toMatchObject({ owner: true, current: true });
        expect(row(settingsPaired)).toMatchObject({ owner: true, current: false });
        expect(row(macLink)).toMatchObject({ owner: false, subject: "one-time-token" });
        expect(row(token.sessionId)).toMatchObject({ owner: false });

        // The session reply the app loads at startup says the same about the session asking.
        const stateOf = (sessionToken: string | null) =>
          auth.getSessionState({
            cookies: sessionToken === null ? {} : { [sessions.cookieName]: sessionToken },
            headers: {},
          } as never);
        expect(yield* stateOf(desktopToken)).toMatchObject({ authenticated: true, owner: true });
        expect(yield* stateOf(macLinkToken)).toMatchObject({ authenticated: true, owner: false });
        const signedOut = yield* stateOf(null);
        expect(signedOut.authenticated).toBe(false);
        expect("owner" in signedOut).toBe(false);

        // Only the Mac-link phone is a paired device that is not his: the token row is not flagged.
        expect(listed.filter(isDeviceNotPairedAsOwner).map((entry) => entry.sessionId)).toEqual([
          macLink,
        ]);
      }),
  );
});
