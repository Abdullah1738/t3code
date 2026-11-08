import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

export type ByIdRouteState =
  | "loading"
  | "ready"
  | "archived"
  | "deleted"
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
        {state === "loading" || state === "unavailable" ? (
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
