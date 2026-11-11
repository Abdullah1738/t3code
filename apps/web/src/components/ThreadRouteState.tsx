import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

export type ByIdRouteState =
  | "loading"
  | "ready"
  | "archived"
  | "deleted"
  | "not-found"
  | "no-access"
  | "unavailable";

export function resolveByIdRouteState(input: {
  status: string;
  error: boolean;
  exists: boolean;
  deleted: boolean;
  archived: boolean;
  timedOut: boolean;
}): ByIdRouteState {
  if (input.status === "no-access") return "no-access";
  if (input.deleted || input.status === "deleted") return "deleted";
  if (input.exists) return input.archived ? "archived" : "ready";
  // An HTTP miss after the grace window. Not a confirmed delete.
  if (input.status === "not-found") return "not-found";
  if (input.error || input.timedOut) return "unavailable";
  return "loading";
}

export function ThreadRouteState({
  state,
  retry,
  back,
}: {
  state: ByIdRouteState;
  retry: () => void;
  back: () => void;
}) {
  const title = {
    loading: "Loading thread",
    ready: "Thread",
    archived: "Archived",
    deleted: "Thread deleted",
    "not-found": "Thread not found",
    "no-access": "No access to this thread",
    unavailable: "Thread unavailable",
  }[state];
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6"
      role="status"
      aria-live="polite"
    >
      <h1 className="text-base font-medium">{title}</h1>
      {state === "loading" ? (
        <div className="w-full max-w-md space-y-3" aria-hidden="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : null}
      <div className="flex gap-2">
        {state === "loading" ||
        state === "unavailable" ||
        state === "not-found" ||
        state === "deleted" ? (
          <Button variant="outline" onClick={retry}>
            Retry
          </Button>
        ) : null}
        <Button variant="ghost" onClick={back}>
          Back
        </Button>
      </div>
    </div>
  );
}
