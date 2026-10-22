import { createDelayedStatus, type ShownStatus } from "@t3tools/client-runtime/delayed-status";
import { useEffect, useState } from "react";

/** `showDelayMs` is read once, when the hook mounts. */
export function useDelayedStatus<A>(key: string, value: A | null, showDelayMs?: number): A | null {
  const [shown, setShown] = useState<ShownStatus<A> | null>(null);
  const [status] = useState(() => createDelayedStatus<A>(setShown, showDelayMs));
  useEffect(() => () => status.dispose(), [status]);
  useEffect(() => {
    status.update(key, value);
  }, [status, key, value]);
  return shown?.key === key ? shown.value : null;
}
