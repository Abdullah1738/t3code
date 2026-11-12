import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { NeedsYouPage } from "../ardud/kanban/needsYou/NeedsYouPage";
import { parseNeedsYouSearch, type NeedsYouSearch } from "../ardud/kanban/needsYou/search";

function NeedsYouRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const onSearch = (next: NeedsYouSearch, options?: { readonly replace?: boolean }) => {
    void navigate({ to: "/needs-you", search: next, replace: options?.replace === true });
  };
  return <NeedsYouPage search={search} onSearch={onSearch} />;
}

export const Route = createFileRoute("/_chat/needs-you")({
  validateSearch: parseNeedsYouSearch,
  component: NeedsYouRouteView,
});
