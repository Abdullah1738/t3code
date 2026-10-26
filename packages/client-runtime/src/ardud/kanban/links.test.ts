import { describe, expect, it } from "vite-plus/test";

import { kanbanLink, kanbanLinkOf, linkLabels, parseKanbanLink } from "./links.ts";

describe("board links", () => {
  it("writes a link the composer and agents can both read", () => {
    const link = kanbanLink("kanban-card", "card-1f2e", "#12 Fix [the] login");
    expect(link).toBe("[#12 Fix the login](t3-context://v1/kanban-card/card-1f2e)");
    expect(parseKanbanLink("t3-context://v1/kanban-card/card-1f2e")).toEqual({
      kind: "kanban-card",
      id: "card-1f2e",
    });
  });

  it("leaves other context kinds and plain links alone", () => {
    expect(parseKanbanLink("t3-context://v1/thread/thread_abc")).toBeNull();
    expect(parseKanbanLink("https://example.com")).toBeNull();
    expect(kanbanLinkOf("kanban-discussion", "disc-1")).toEqual({
      kind: "kanban-discussion",
      id: "disc-1",
    });
    expect(kanbanLinkOf("kanban-thread", "0f9e")).toBeNull();
    expect(kanbanLinkOf("file", "x")).toBeNull();
  });

  it("reduces links to their labels for previews", () => {
    const text = `See ${kanbanLink("kanban-discussion", "disc-9", "Release plan")} first`;
    expect(linkLabels(text)).toBe("See Release plan first");
    expect(linkLabels("Ask [Worker](t3-thread://v1/thread:project:p1:0f9e) why")).toBe(
      "Ask Worker why",
    );
    expect(linkLabels("no links")).toBe("no links");
  });
});
