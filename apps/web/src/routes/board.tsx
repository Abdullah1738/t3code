import { createFileRoute } from "@tanstack/react-router";

// ardud fork: session board
import { BoardPage } from "../ardud/board/BoardPage";

export const Route = createFileRoute("/board")({
  component: BoardPage,
});
