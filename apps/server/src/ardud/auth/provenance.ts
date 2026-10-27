import type { ClientSurface } from "@t3tools/contracts";

import type { SessionOrigin } from "./SessionOrigins.ts";

/**
 * The owner is decided by the transport, never read from a request body or
 * header: a WS session minted from an owner-issued pairing grant, on a client
 * UI surface. The proof is the session's origin claim (`SessionOrigins.ts`),
 * written when the session was minted and never changed.
 */
export type OwnerSurface = Exclude<ClientSurface, "cli">;

export interface OwnerProvenance {
  readonly _tag: "owner-app";
  readonly surface: OwnerSurface;
  readonly sessionId: string;
}

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
 * connection says it is a client UI. `null` otherwise (the CLI, an MCP or
 * CLI-issued token, a client paired by a nonowner issuer, a session from
 * before origin claims existed).
 */
export const ownerAppProvenance = (input: {
  readonly surface: ClientSurface | undefined;
  readonly session: OriginSession;
}): OwnerProvenance | null =>
  input.surface !== undefined && isOwnerSurface(input.surface) && isOwnerSession(input.session)
    ? { _tag: "owner-app", surface: input.surface, sessionId: input.session.sessionId }
    : null;

/** How a write from a session is stamped: `user` for the owner's app, `system` otherwise. */
export const sessionActor = (owner: OwnerProvenance | null): "user" | "system" =>
  owner === null ? "system" : "user";

/** Why an owner action was refused, and what to do about it. */
export const OWNER_SESSION_REQUIRED =
  "Owner actions need a Robob web, desktop or mobile session paired by the owner. A device paired before this check, or from a link the owner did not make, is not the owner: pair it again from an owner device (Settings > Connections).";
