import "../../index.css";
import "./missions.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { DraftId, MissionId, type Draft } from "@t3tools/contracts";

vi.mock("./DiscussPanel", () => ({
  useCardDiscussion: () => ({ action: null, panel: null, symbol: null }),
  ConditionNote: () => null,
}));
vi.mock("./operationCommands", () => ({ rerouteRecord: async () => true }));
vi.mock("./cards/TemplatedCard", () => ({ useTemplatedCard: () => null }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children: unknown }) => props.children,
}));

import { DraftCard } from "./InboxCards";
import type { InboxActions } from "./useInboxScreen";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const QUOTE = [
  "Does the retry fix cover the webhook path too?",
  "We saw drops on Thursday night.",
  "Also the queue consumer restarted twice.",
  "Can you confirm before we close the ticket?",
].join("\n");

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  id: DraftId.make("draft-1"),
  missionId: MissionId.make("m1"),
  audience: "Sami",
  channel: "github",
  target: { kind: "pull-request", label: "acme/api#42", url: null, ref: "acme/api#42" },
  text: "Yes, webhooks too. Merged in #42.",
  approvedText: null,
  writerRoleId: null,
  source: { kind: "lane", ref: null },
  appliedNoteIds: [],
  status: "pending",
  rewriteNote: null,
  decidedBy: null,
  decidedAt: null,
  sentAt: null,
  createdAt: "2026-10-24T11:00:00.000Z",
  ...overrides,
});

let host: HTMLDivElement;
let root: Root;

const render = (record: Draft) =>
  act(() =>
    root.render(
      <DraftCard
        draft={record}
        editing={false}
        onEdit={() => {}}
        notes={[]}
        masterRoleId={null}
        actions={{ decideDraft: async () => true } as unknown as InboxActions}
        selected={false}
        onSelect={() => {}}
        nowMs={NOW}
        list={undefined}
      />,
    ),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  host.style.width = "390px";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows what the draft replies to above the draft text", () => {
  render(
    draft({
      inReplyTo: {
        summary: "Sami asks whether the retry fix covers webhooks before closing the ticket.",
        quote: QUOTE,
        author: "Sami",
        at: "2026-10-24T09:00:00.000Z",
        link: {
          kind: "pull-request",
          label: "Comment on #42",
          url: "https://github.com/acme/api/pull/42#issuecomment-1",
          ref: null,
        },
      },
    }),
  );
  const block = host.querySelector<HTMLElement>('[role="group"][aria-label="Replying to"]');
  expect(block).not.toBeNull();
  expect(block!.textContent).toContain("Sami");
  expect(block!.querySelector("time")?.textContent).toBe("3h ago");
  expect(block!.querySelector("blockquote")?.textContent).toBe(QUOTE);
  expect(block!.textContent).toContain("Sami asks whether the retry fix covers webhooks");
  expect(block!.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/acme/api/pull/42#issuecomment-1",
  );

  // Above the draft text.
  const text = [...host.querySelectorAll("p")].find(
    (node) => node.textContent === "Yes, webhooks too. Merged in #42.",
  );
  expect(text).toBeDefined();
  expect(block!.compareDocumentPosition(text!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // A long quote is clamped and opens with Show all.
  const quote = block!.querySelector("blockquote")!;
  expect(quote.className).toContain("line-clamp-3");
  const toggle = [...block!.querySelectorAll("button")].find(
    (button) => button.textContent === "Show all",
  );
  expect(toggle).toBeDefined();
  act(() => toggle!.click());
  expect(quote.className).not.toContain("line-clamp-3");
  expect(toggle!.textContent).toBe("Show less");
  expect(toggle!.getAttribute("aria-expanded")).toBe("true");
});

it("labels a situation summary alone as About and shows nothing without a context", () => {
  render(draft({ inReplyTo: { summary: "Dev was down for an hour this morning." } }));
  const about = host.querySelector<HTMLElement>('[role="group"][aria-label="About"]');
  expect(about?.textContent).toContain("Dev was down for an hour this morning.");
  expect(about?.querySelector("blockquote")).toBeNull();
  expect([...about!.querySelectorAll("button")].map((button) => button.textContent)).toEqual([]);

  render(draft());
  expect(host.querySelector('[role="group"][aria-label="Replying to"]')).toBeNull();
  expect(host.querySelector('[role="group"][aria-label="About"]')).toBeNull();
});
