/**
 * The id agents pass as `--session` for bridge sends. With a context-resetting
 * backend `/new` keeps the same thread, so the bare thread id no longer tells
 * one conversation from the next. The marker adds the route generation, which
 * `/new` bumps: a turn from before `/new` holds a stale marker and is refused.
 */
export const sessionMarker = (route: { id: string; generation: number }): string => `${route.id}@${route.generation}`;

/**
 * True when `sessionId` names the current route: its marker, or the bare id,
 * which robob-watch and wacli-guard read straight from the stored route.
 */
export function sessionMatches(route: { id: string; generation: number } | null | undefined, sessionId: string): route is { id: string; generation: number } {
  if (!route || !Number.isSafeInteger(route.generation) || route.generation < 0) return false;
  return sessionId === route.id || sessionId === sessionMarker(route);
}
