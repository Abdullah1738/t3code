import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../../auth/SessionStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as SessionOrigins from "../../auth/SessionOrigins.ts";
import { issueComponentSession, listComponentSessions } from "../../auth/components.ts";
import { componentProvenance, ownerAppProvenance } from "./provenance.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
const DESKTOP_TOKEN = "desktop-bootstrap-token";

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
        port: 13_774,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-missions-owner-test-" })),
  );

const layerEnvironmentAuth = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );

type AuthRequest = Parameters<
  EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
>[0];

const cookieRequest = (cookieName: string, token: string) =>
  ({ cookies: { [cookieName]: token }, headers: {} }) as unknown as AuthRequest;

const bearerRequest = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as AuthRequest;

const client = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

const isOwner = (session: EnvironmentAuth.AuthenticatedSession) =>
  ownerAppProvenance({ surface: "web", session })?._tag === "owner-app";

it.layer(NodeServices.layer)("missions owner proof", (it) => {
  it.effect(
    "a session paired from an owner-issued link is the owner; the surface only labels it",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;

        // The desktop app's own bootstrap, exchanged for its renderer's cookie.
        const desktop = yield* auth.createBrowserSession(DESKTOP_TOKEN, client);
        const desktopSession = yield* auth.authenticateHttpRequest(
          cookieRequest(sessions.cookieName, desktop.sessionToken),
        );
        expect(desktopSession.origin).toEqual({ _tag: "owner", source: "desktop" });

        // Settings > Connections on the desktop app, opened in a browser.
        const fromDesktop = yield* auth.issuePairingCredential(undefined, {
          sessionId: desktopSession.sessionId,
        });
        const browser = yield* auth.createBrowserSession(fromDesktop.credential, client);
        const browserSession = yield* auth.authenticateHttpRequest(
          cookieRequest(sessions.cookieName, browser.sessionToken),
        );
        expect(browserSession.origin).toEqual({ _tag: "owner", source: "paired-client" });
        expect(ownerAppProvenance({ surface: "web", session: browserSession })).toEqual({
          _tag: "owner-app",
          surface: "web",
          sessionId: browserSession.sessionId,
        });
        expect(ownerAppProvenance({ surface: "cli", session: browserSession })).toBeNull();
        expect(ownerAppProvenance({ surface: undefined, session: browserSession })).toBeNull();

        // That browser making a link for the phone.
        const fromBrowser = yield* auth.issuePairingCredential(undefined, {
          sessionId: browserSession.sessionId,
        });
        const phone = yield* auth.exchangeBootstrapCredentialForAccessToken(
          fromBrowser.credential,
          undefined,
          { ...client, deviceType: "mobile" },
        );
        const phoneSession = yield* auth.authenticateHttpRequest(bearerRequest(phone.access_token));
        expect(phoneSession.origin).toEqual({ _tag: "owner", source: "paired-client" });

        // The WS ticket path carries the same claim.
        const ticket = yield* auth.issueWebSocketTicket(browserSession);
        const socket = yield* auth.authenticateWebSocketUpgrade({
          url: `/ws?wsTicket=${encodeURIComponent(ticket.ticket)}`,
          cookies: {},
          headers: {},
        } as never);
        expect(socket.origin).toEqual({ _tag: "owner", source: "paired-client" });
      }).pipe(Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: DESKTOP_TOKEN }))),
  );

  it.effect("N1: links made on the Mac never pair the owner, not even the first device", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pair = (credential: string) =>
        auth
          .createBrowserSession(credential, client)
          .pipe(
            Effect.flatMap((paired) =>
              auth.authenticateHttpRequest(cookieRequest(sessions.cookieName, paired.sessionToken)),
            ),
          );
      const bearer = (credential: string) =>
        auth
          .exchangeBootstrapCredentialForAccessToken(credential, undefined, {
            ...client,
            deviceType: "mobile",
          })
          .pipe(
            Effect.flatMap((token) =>
              auth.authenticateHttpRequest(bearerRequest(token.access_token)),
            ),
          );

      // No owner yet. `t3 pair`, `t3 auth pairing create` and the startup URL are
      // all things an agent shell can run, so none of them is an owner root.
      const cliLink = yield* auth.createPairingLink({ subject: "one-time-token" });
      const cliCookie = yield* pair(cliLink.credential);
      expect(cliCookie.origin).toBeUndefined();
      expect(isOwner(cliCookie)).toBe(false);
      const cliBearer = yield* bearer((yield* auth.createPairingLink()).credential);
      expect(isOwner(cliBearer)).toBe(false);
      const startup = yield* bearer((yield* auth.issueStartupPairingCredential()).credential);
      expect(startup.scopes).toContain("access:write");
      expect(startup.origin).toBeUndefined();
      expect(ownerAppProvenance({ surface: "mobile", session: startup })).toBeNull();

      // A device paired that way cannot pass an owner mark on either.
      const relayed = yield* pair(
        (yield* auth.issuePairingCredential(undefined, { sessionId: startup.sessionId }))
          .credential,
      );
      expect(isOwner(relayed)).toBe(false);

      // The desktop app is still the owner root.
      const desktop = yield* pair(DESKTOP_TOKEN);
      expect(desktop.origin).toEqual({ _tag: "owner", source: "desktop" });

      // The owner's browser opening a plain Mac link over its own cookie stays the owner.
      const ownerBrowser = yield* auth.createBrowserSession(
        (yield* auth.issuePairingCredential(undefined, { sessionId: desktop.sessionId }))
          .credential,
        client,
      );
      const repaired = yield* auth.createBrowserSession(
        (yield* auth.createPairingLink()).credential,
        client,
        ownerBrowser.sessionToken,
      );
      expect(
        isOwner(
          yield* auth.authenticateHttpRequest(
            cookieRequest(sessions.cookieName, repaired.sessionToken),
          ),
        ),
      ).toBe(true);
      // ...but a plain cookie re-pairing over a Mac link gains nothing.
      const plainRepair = yield* auth.createBrowserSession(
        (yield* auth.createPairingLink()).credential,
        client,
        (yield* auth.createBrowserSession((yield* auth.createPairingLink()).credential, client))
          .sessionToken,
      );
      expect(
        isOwner(
          yield* auth.authenticateHttpRequest(
            cookieRequest(sessions.cookieName, plainRepair.sessionToken),
          ),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: DESKTOP_TOKEN }))),
  );

  it.effect("N1: the first owner session claims the server once, atomically", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const origins = yield* SessionOrigins.SessionOrigins;
      expect(yield* origins.ownerClaimed()).toBe(false);
      // Mac links never claim it.
      yield* auth.exchangeBootstrapCredentialForAccessToken(
        (yield* auth.issueStartupPairingCredential()).credential,
        undefined,
        client,
      );
      expect(yield* origins.ownerClaimed()).toBe(false);
      const launches = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          auth.exchangeBootstrapCredentialForAccessToken(DESKTOP_TOKEN, undefined, client),
        ),
        { concurrency: "unbounded" },
      );
      expect(launches).toHaveLength(4);
      expect(yield* origins.ownerClaimed()).toBe(true);
      expect(yield* origins.claimOwner("desktop")).toBe(false);
    }).pipe(Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: DESKTOP_TOKEN }))),
  );

  it.effect("N1: of four claims at once, exactly one is the first", () =>
    Effect.gen(function* () {
      const origins = yield* SessionOrigins.SessionOrigins;
      const claims = yield* Effect.all(
        Array.from({ length: 4 }, () => origins.claimOwner("desktop")),
        { concurrency: "unbounded" },
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
    }).pipe(Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: DESKTOP_TOKEN }))),
  );

  it.effect(
    "N1: the owner claim is a record, so failing to write it never locks the owner out",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE ardud_mission_owner_claim`;

        const desktop = yield* auth.createBrowserSession(DESKTOP_TOKEN, client);
        expect(
          isOwner(
            yield* auth.authenticateHttpRequest(
              cookieRequest(sessions.cookieName, desktop.sessionToken),
            ),
          ),
        ).toBe(true);
        const launch = yield* auth.exchangeBootstrapCredentialForAccessToken(
          DESKTOP_TOKEN,
          undefined,
          client,
        );
        expect(
          isOwner(yield* auth.authenticateHttpRequest(bearerRequest(launch.access_token))),
        ).toBe(true);
      }).pipe(Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: DESKTOP_TOKEN }))),
  );

  it.effect("H1: a control token cannot mint an owner session through a pairing link", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;

      // The shared control token has access:write, so it may still create a link.
      const control = yield* auth.issueSession({ label: "bridges" });
      const controlSession = yield* auth.authenticateHttpRequest(bearerRequest(control.token));
      expect(controlSession.scopes).toContain("access:write");
      expect(isOwner(controlSession)).toBe(false);

      const link = yield* auth.issuePairingCredential(undefined, {
        sessionId: controlSession.sessionId,
      });
      // Cookie or bearer makes no difference: neither session is the owner.
      const cookie = yield* auth.createBrowserSession(link.credential, client);
      const cookieSession = yield* auth.authenticateHttpRequest(
        cookieRequest(sessions.cookieName, cookie.sessionToken),
      );
      expect(cookieSession.subject).toBe("one-time-token");
      expect(cookieSession.origin).toBeUndefined();
      expect(isOwner(cookieSession)).toBe(false);

      const bearerLink = yield* auth.issuePairingCredential(undefined, {
        sessionId: controlSession.sessionId,
      });
      const bearer = yield* auth.exchangeBootstrapCredentialForAccessToken(
        bearerLink.credential,
        undefined,
        { ...client, deviceType: "mobile" },
      );
      const bearerSession = yield* auth.authenticateHttpRequest(bearerRequest(bearer.access_token));
      expect(isOwner(bearerSession)).toBe(false);

      // A session paired by the control token cannot launder the mark either.
      const relayed = yield* auth.issuePairingCredential(undefined, {
        sessionId: cookieSession.sessionId,
      });
      const relayedCookie = yield* auth.createBrowserSession(relayed.credential, client);
      const relayedSession = yield* auth.authenticateHttpRequest(
        cookieRequest(sessions.cookieName, relayedCookie.sessionToken),
      );
      expect(isOwner(relayedSession)).toBe(false);

      // A link with no issuer at all (MCP, T3 Connect, anything programmatic) is not owner-issued.
      const anonymous = yield* auth.issuePairingCredential();
      const anonymousCookie = yield* auth.createBrowserSession(anonymous.credential, client);
      const anonymousSession = yield* auth.authenticateHttpRequest(
        cookieRequest(sessions.cookieName, anonymousCookie.sessionToken),
      );
      expect(isOwner(anonymousSession)).toBe(false);
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect(
    "H1: a hand-issued session with a reserved subject is refused and never the owner",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;

        // `t3 auth session issue --subject ...` refuses the server's own subjects.
        for (const subject of [
          "one-time-token",
          "administrative-bootstrap",
          "desktop-bootstrap",
          "cloud-connect",
          "reusable-dev-token-child",
          "mcp-client",
          " one-time-token ",
          "component:crw",
        ]) {
          expect(SessionOrigins.isReservedSessionSubject(subject), subject).toBe(true);
        }
        expect(SessionOrigins.isReservedSessionSubject("bridges")).toBe(false);

        // Even minted programmatically, the subject proves nothing.
        for (const subject of ["one-time-token", "desktop-bootstrap", "administrative-bootstrap"]) {
          const issued = yield* auth.issueSession({ subject });
          const session = yield* auth.authenticateHttpRequest(bearerRequest(issued.token));
          expect(session.subject).toBe(subject);
          expect(isOwner(session)).toBe(false);
        }
        const forged = yield* sessions.issue({
          subject: "one-time-token",
          method: "browser-session-cookie",
        });
        const forgedSession = yield* auth.authenticateHttpRequest(
          cookieRequest(sessions.cookieName, forged.token),
        );
        expect(isOwner(forgedSession)).toBe(false);

        // MCP OAuth and the default CLI-issued token are not the owner either.
        const mcp = yield* auth.issueMcpClientSession({
          label: "Claude Code",
          access: "full-access",
          client,
        });
        const mcpSession = yield* sessions.verify(mcp.token);
        expect(mcpSession.subject).toBe("mcp-client");
        expect(ownerAppProvenance({ surface: "web", session: mcpSession })).toBeNull();
        const issued = yield* auth.issueSession({ label: "bridges" });
        const issuedSession = yield* auth.authenticateHttpRequest(bearerRequest(issued.token));
        expect(ownerAppProvenance({ surface: "desktop", session: issuedSession })).toBeNull();
        expect(componentProvenance(issuedSession)).toBeNull();
      }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("a component credential names its component and nothing more", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* issueComponentSession({ component: "crw" });
      const session = yield* auth.authenticateHttpRequest(bearerRequest(issued.token));
      expect(session.subject).toBe("component:crw");
      expect(session.origin).toEqual({ _tag: "component", component: "crw" });
      expect(componentProvenance(session)).toEqual({ _tag: "system", component: "crw" });
      expect(ownerAppProvenance({ surface: "web", session })).toBeNull();
      // Read and operate only: no pairing links, no sessions, no settings.
      expect([...session.scopes].toSorted()).toEqual([
        "orchestration:operate",
        "orchestration:read",
      ]);

      const listed = yield* listComponentSessions;
      expect(listed.map((row) => [row.component, row.sessionId])).toEqual([
        ["crw", issued.sessionId],
      ]);
      yield* auth.revokeSession(issued.sessionId);
      expect(yield* listComponentSessions).toEqual([]);

      const unknown = yield* Effect.flip(issueComponentSession({ component: "someone" }));
      expect(unknown._tag).toBe("UnknownComponentError");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("the desktop app's own bootstrap is the owner, every launch", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const launch = () =>
        auth
          .createBrowserSession(DESKTOP_TOKEN, client)
          .pipe(
            Effect.flatMap((renderer) =>
              auth.authenticateHttpRequest(
                cookieRequest(sessions.cookieName, renderer.sessionToken),
              ),
            ),
          );
      const session = yield* launch();
      expect(session.origin).toEqual({ _tag: "owner", source: "desktop" });
      expect(ownerAppProvenance({ surface: "desktop", session })?._tag).toBe("owner-app");

      // The desktop app recovers the owner however many times it relaunches.
      for (const active of yield* auth.listSessions()) {
        yield* auth.revokeSession(active.sessionId);
      }
      expect((yield* launch()).origin).toEqual({ _tag: "owner", source: "desktop" });
    }).pipe(Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: DESKTOP_TOKEN }))),
  );

  it.effect("dev mode's reusable credential and its exchanged sessions are the owner", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const dev = yield* auth.authenticateHttpRequest(bearerRequest(DEV_TOKEN));
      expect(dev.origin).toEqual({ _tag: "owner", source: "dev-token" });
      const child = yield* auth.exchangeBootstrapCredentialForAccessToken(DEV_TOKEN, undefined, {
        ...client,
        deviceType: "mobile",
      });
      const childSession = yield* auth.authenticateHttpRequest(bearerRequest(child.access_token));
      expect(childSession.origin).toEqual({ _tag: "owner", source: "dev-token" });
      expect(childSession.sessionId).not.toBe(dev.sessionId);
      // In dev the `.env` credential is the owner; a Mac link never is.
      const fromMac = yield* auth.createPairingLink();
      const plain = yield* auth.exchangeBootstrapCredentialForAccessToken(
        fromMac.credential,
        undefined,
        client,
      );
      expect(
        (yield* auth.authenticateHttpRequest(bearerRequest(plain.access_token))).origin,
      ).toBeUndefined();
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make(DEV_TOKEN),
        }),
      ),
    ),
  );
});
