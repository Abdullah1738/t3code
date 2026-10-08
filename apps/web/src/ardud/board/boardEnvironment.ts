import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";

/**
 * The environment whose session board this client shows. Normally that is the
 * local (primary) environment. A desktop running as a thin client (local
 * environment disabled) has no primary, so it falls back to the first paired
 * remote environment.
 */
export const boardEnvironmentIdAtom = Atom.make((get) => {
  let remote: EnvironmentId | null = null;
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") return environmentId;
    if (remote === null && entry.target._tag === "BearerConnectionTarget") remote = environmentId;
  }
  return remote;
}).pipe(Atom.withLabel("ardud-board-environment-id"));

export function useBoardEnvironmentId(): EnvironmentId | null {
  return useAtomValue(boardEnvironmentIdAtom);
}

export interface BoardEndpoint {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly credentials: RequestCredentials;
}

// Same-origin web relies on the session cookie. Desktop (custom-scheme origin)
// and remote environments authenticate with a bearer token; the server answers
// CORS with "*", which browsers reject for credentialed requests, so cookies
// must be omitted there.
function primaryCredentials(url: string): RequestCredentials {
  if (typeof window === "undefined" || window.desktopBridge !== undefined) return "omit";
  return new URL(url, window.location.href).origin === window.location.origin ? "include" : "omit";
}

export async function resolveBoardEndpoint(path: string): Promise<BoardEndpoint> {
  const environmentId = appAtomRegistry.get(boardEnvironmentIdAtom);
  const entry =
    environmentId === null
      ? undefined
      : appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  if (
    environmentId === null ||
    entry === undefined ||
    entry.target._tag === "PrimaryConnectionTarget"
  ) {
    const url = resolvePrimaryEnvironmentHttpUrl(path);
    const token = await readDesktopPrimaryBearerToken().catch(() => null);
    return {
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      credentials: primaryCredentials(url),
    };
  }
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("Connecting to the session board environment.");
  const auth = connection.httpAuthorization;
  return {
    url: new URL(path, connection.httpBaseUrl).toString(),
    headers: auth?._tag === "Bearer" ? { authorization: `Bearer ${auth.token}` } : {},
    credentials: "omit",
  };
}
