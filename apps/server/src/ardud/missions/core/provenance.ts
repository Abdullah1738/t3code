import type {
  ClientSurface,
  MissionActor,
  MissionProvenance,
  OwnerSurface,
} from "@t3tools/contracts";

/**
 * Provenance is decided by the transport, never read from a request body:
 *
 * - WS from a session that was created by pairing a Robob client is the owner
 *   (`owner-app`, with the auth session id). See `isPairedClientSession`.
 * - iMessage answers are `owner-imessage` once the asks track verified the
 *   inbound id.
 * - MCP tools are `agent`, bound to the calling thread.
 * - The control API (HTTP) is `system` for named components (crw), and the
 *   iMessage answer path above. It never claims a thread or the owner.
 */
const OWNER_SURFACES: ReadonlySet<ClientSurface> = new Set<OwnerSurface>([
  "web",
  "desktop",
  "mobile",
]);

const isOwnerSurface = (surface: ClientSurface): surface is OwnerSurface =>
  OWNER_SURFACES.has(surface);

/**
 * Auth session subjects that only come from consuming a pairing grant (a
 * browser cookie session for web and the desktop renderer, or the bearer/DPoP
 * session a mobile or desktop client exchanges its pairing credential for).
 * See `createBrowserSession` and `exchangeBootstrapCredentialForAccessToken`
 * in auth/EnvironmentAuth.ts; the subject is the grant's.
 *
 * Never the owner: `cli-issued-session` (`t3 auth session issue`, the control
 * token, project and import CLIs), `cloud-cli`, `mcp-client` (MCP OAuth), and
 * any custom subject.
 */
const PAIRED_CLIENT_SUBJECTS: ReadonlySet<string> = new Set([
  // createPairingLink / issuePairingCredential: `t3 pair`, Settings > Connections.
  "one-time-token",
  // The startup pairing URL the server prints.
  "administrative-bootstrap",
  // The desktop app pairing its own renderer.
  "desktop-bootstrap",
  // A T3 Connect client paired through the tunnel.
  "cloud-connect",
  // Dev mode's reusable browser credential and its exchanged sessions.
  "reusable-dev-token",
  "reusable-dev-token-child",
]);

export const isPairedClientSession = (session: { readonly subject: string }) =>
  PAIRED_CLIENT_SUBJECTS.has(session.subject);

/**
 * The owner, when the WS session was created by pairing a Robob client and the
 * connection says it is a client UI. The surface only labels which UI; the
 * session subject is the proof. `null` otherwise (the CLI, an MCP or
 * CLI-issued token, a client claiming to be web).
 */
export const ownerAppProvenance = (input: {
  readonly surface: ClientSurface | undefined;
  readonly session: { readonly sessionId: string; readonly subject: string };
}): MissionProvenance | null =>
  input.surface !== undefined &&
  isOwnerSurface(input.surface) &&
  isPairedClientSession(input.session)
    ? { _tag: "owner-app", surface: input.surface, sessionId: input.session.sessionId }
    : null;

/** The timeline actor for a write. */
export const actorOf = (provenance: MissionProvenance): MissionActor => {
  switch (provenance._tag) {
    case "owner-app":
    case "owner-imessage":
      return { _tag: "owner" };
    case "agent":
      return provenance.roleId === null
        ? { _tag: "thread", threadId: provenance.threadId }
        : { _tag: "role", roleId: provenance.roleId };
    case "system":
      return { _tag: "system", component: provenance.component };
    case "import":
      return { _tag: "system", component: `import:${provenance.source}` };
  }
};
