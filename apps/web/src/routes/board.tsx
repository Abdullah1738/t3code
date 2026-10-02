import { createFileRoute, redirect } from "@tanstack/react-router";

// ardud fork: the board is the home page now; keep old /board links working.
export const Route = createFileRoute("/board")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
