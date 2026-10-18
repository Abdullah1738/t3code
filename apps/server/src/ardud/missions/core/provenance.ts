import type {
  ClientSurface,
  MissionActor,
  MissionProvenance,
  OwnerSurface,
} from "@t3tools/contracts";

import type { SessionOrigin } from "../../auth/SessionOrigins.ts";

/**
 * Provenance is decided by the transport, never read from a request body or a
 * request header:
 *
 * - WS from a session minted from an owner-issued pairing grant is the owner
 *   (`owner-app`, with the auth session id). The proof is the session's origin
 *   claim (ardud/auth/SessionOrigins.ts), written when the session was minted
 *   and never changed. The subject string is not proof.
 * - iMessage answers are `owner-imessage` once the asks track verified the
 *   inbound id.
 * - MCP tools are `agent`, bound to the calling thread.
 * - The control API (HTTP) is `system`: the named component its credential was
 *   minted for (`componentProvenance`), or the shared control token. It never
 *   claims a thread or the owner.
 */
const OWNER_SURFACES: ReadonlySet<ClientSurface> = new Set<OwnerSurface>([
  "web",
  "desktop",
  "mobile",
]);

const isOwnerSurface = (surface: ClientSurface): surface is OwnerSurface =>
  OWNER_SURFACES.has(surface);

export interface OriginSession {
  readonly sessionId: string;
  readonly origin?: SessionOrigin | undefined;
}

/** True when the session was minted from an owner-issued pairing grant. */
export const isOwnerSession = (session: OriginSession) => session.origin?._tag === "owner";

/**
 * The owner, when the session carries the owner origin claim and the
 * connection says it is a client UI. The surface only labels which UI; the
 * origin claim is the proof. `null` otherwise (the CLI, an MCP or CLI-issued
 * token, a client paired by a nonowner issuer, a session from before origin
 * claims existed).
 */
export const ownerAppProvenance = (input: {
  readonly surface: ClientSurface | undefined;
  readonly session: OriginSession;
}): MissionProvenance | null =>
  input.surface !== undefined && isOwnerSurface(input.surface) && isOwnerSession(input.session)
    ? { _tag: "owner-app", surface: input.surface, sessionId: input.session.sessionId }
    : null;

/** The named component a session was minted for, as system provenance. */
export const componentProvenance = (session: OriginSession): MissionProvenance | null =>
  session.origin?._tag === "component"
    ? { _tag: "system", component: session.origin.component }
    : null;

/** Why an owner action was refused, and what to do about it. */
export const OWNER_SESSION_REQUIRED =
  "Owner actions need a Robob web, desktop or mobile session paired by the owner. A device paired before this check, or from a link the owner did not make, is not the owner: pair it again from an owner device (Settings > Connections).";

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
