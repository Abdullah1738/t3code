import type {
  ClientSurface,
  MissionActor,
  MissionProvenance,
  OwnerSurface,
} from "@t3tools/contracts";

/**
 * Provenance is decided by the transport, never read from a request body:
 *
 * - WS from an authenticated Robob client (web, desktop, mobile) is the owner
 *   (`owner-app`, with the auth session id).
 * - iMessage answers are `owner-imessage` once the asks track verified the
 *   inbound id.
 * - MCP tools and the HTTP API are `agent`, bound to the calling thread.
 */
const OWNER_SURFACES: ReadonlySet<ClientSurface> = new Set<OwnerSurface>([
  "web",
  "desktop",
  "mobile",
]);

const isOwnerSurface = (surface: ClientSurface): surface is OwnerSurface =>
  OWNER_SURFACES.has(surface);

/** `null` when the connection is not a Robob client UI (for example the CLI). */
export const ownerAppProvenance = (input: {
  readonly surface: ClientSurface | undefined;
  readonly sessionId: string;
}): MissionProvenance | null =>
  input.surface !== undefined && isOwnerSurface(input.surface)
    ? { _tag: "owner-app", surface: input.surface, sessionId: input.sessionId }
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
