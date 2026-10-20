import { useEffect, useSyncExternalStore } from "react";

import { usePrimaryEnvironment } from "../../state/environments";

const LABEL = {
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  offline: "Offline",
  error: "Offline",
} as const;

// When the live connection last dropped, shared so every Missions surface
// shows the same "Last update" time. Null while connected or before the
// first connection.
let droppedAt: number | null = null;
let wasConnected = false;
const listeners = new Set<() => void>();

function setDroppedAt(next: number | null) {
  if (droppedAt === next) return;
  droppedAt = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The server connection as Missions shows it: a label while it is down and
 * when the data last updated. `label` is null while connected.
 */
export function useMissionsConnection(): { label: string | null; lastUpdateAt: number | null } {
  const phase = usePrimaryEnvironment()?.connection.phase ?? null;
  const label = phase !== null && phase in LABEL ? LABEL[phase as keyof typeof LABEL] : null;
  const lastUpdateAt = useSyncExternalStore(subscribe, () => droppedAt);
  useEffect(() => {
    if (phase === "connected") {
      wasConnected = true;
      setDroppedAt(null);
    } else if (label !== null && wasConnected && droppedAt === null) {
      setDroppedAt(Date.now());
    }
  }, [phase, label]);
  return { label, lastUpdateAt: label === null ? null : lastUpdateAt };
}
