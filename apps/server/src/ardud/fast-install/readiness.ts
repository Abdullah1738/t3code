/** Upgrades carry commands even though the HTTP handshake is a GET. */
export function canServeBeforeRecovery(method: string, upgrade?: string): boolean {
  return (
    (method === "GET" && upgrade?.toLowerCase() !== "websocket") ||
    method === "HEAD" ||
    method === "OPTIONS"
  );
}
