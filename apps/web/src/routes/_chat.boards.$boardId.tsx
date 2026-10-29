import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { BoardPage } from "../ardud/kanban/BoardPage";
import { parseBoardSearch, type BoardSearch } from "../ardud/kanban/search";

function BoardRouteView() {
  const { boardId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const onSearch = (next: BoardSearch, options?: { readonly replace?: boolean }) => {
    void navigate({
      to: "/boards/$boardId",
      params: { boardId },
      search: next,
      replace: options?.replace === true,
    });
  };
  return <BoardPage key={boardId} boardId={boardId} search={search} onSearch={onSearch} />;
}

export const Route = createFileRoute("/_chat/boards/$boardId")({
  validateSearch: parseBoardSearch,
  component: BoardRouteView,
});
