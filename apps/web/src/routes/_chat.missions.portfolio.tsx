import { createFileRoute } from "@tanstack/react-router";

import { PortfolioPage } from "../ardud/missions/PortfolioPage";

export const Route = createFileRoute("/_chat/missions/portfolio")({
  component: PortfolioPage,
});
