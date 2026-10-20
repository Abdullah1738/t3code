/**
 * Which prompts count as a person's turn. The guard stamps a bearer's prompt
 * `system` (a token is not the owner typing), but a person still sent it:
 * the iMessage bridge relaying the owner, the CLI, a paired browser that is
 * not the owner's app. History paging and title generation treat those like
 * the owner's own prompts. Prompts the server makes itself (startup notices,
 * usage-limit retries, imports, mission briefs) stay out: they are
 * `creationSource: "server"` with ids of their own.
 */

/** Message ids the control API mints (`commandIdFor` in control/http.ts). */
export const CONTROL_MESSAGE_PREFIX = "ardud-control:";

/** Creation sources a bearer's WS session stamps on what it sends. */
export const BEARER_SOURCES: ReadonlyArray<string> = ["web", "mobile"];

/** Whether a prompt came from a person, owner or bearer. */
export const countsAsUserTurn = (item: {
  readonly createdBy?: string | undefined;
  readonly creationSource?: string | undefined;
  readonly messageId?: string | undefined;
}): boolean =>
  item.createdBy === "user" ||
  (item.createdBy === "system" &&
    ((item.messageId?.startsWith(CONTROL_MESSAGE_PREFIX) ?? false) ||
      (item.creationSource !== undefined && BEARER_SOURCES.includes(item.creationSource))));
