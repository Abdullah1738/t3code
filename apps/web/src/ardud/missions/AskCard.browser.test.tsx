import "../../index.css";
import "./missions.css";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { AskId, MissionId, type Ask } from "@t3tools/contracts";

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

import { AskCard } from "./InboxCards";
import type { InboxActions } from "./useInboxScreen";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const LONG = [
  "Built and pushed in the Robob fork (0e4270427f, tests green).",
  "(1) Every draft card can show what it replies to.",
  "(2) The editor digest leaves out notes already marked handled.",
  "It is not live: the server ships inside Robob.app, so it needs a signed build plus a restart.",
  "A restart interrupts every running lane turn and background helper.",
  "Until then lanes keep the interim format.",
].join("\n");

const ask = (context: string): Ask => ({
  id: AskId.make("ask-1"),
  missionId: MissionId.make("m1"),
  subMissionId: null,
  askedBy: { _tag: "owner" },
  question: "Install the Robob update?",
  context,
  options: [
    { id: "now", label: "Install now", detail: "" },
    { id: "later", label: "Not today", detail: "" },
  ],
  recommendation: null,
  blocks: [],
  costOfWaiting: "",
  urgency: "normal",
  status: "open",
  answer: null,
  createdAt: "2026-10-24T11:00:00.000Z",
  updatedAt: "2026-10-24T11:00:00.000Z",
});

let host: HTMLDivElement;
let root: Root;

const render = (record: Ask) =>
  act(() =>
    root.render(
      <AskCard
        ask={record}
        picked={null}
        onPick={() => {}}
        masterRoleId={null}
        actions={{} as InboxActions}
        selected={false}
        onSelect={() => {}}
        nowMs={NOW}
        list={undefined}
      />,
    ),
  );

const showAll = () =>
  [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Show all" || button.textContent === "Show less",
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

it("folds a long decision context to four lines and opens it in place with Show all", () => {
  render(ask(LONG));
  const context = [...host.querySelectorAll("p")].find((node) => node.textContent === LONG);
  expect(context).toBeDefined();
  expect(context!.className).toContain("line-clamp-4");
  expect(context!.scrollHeight).toBeGreaterThan(context!.clientHeight);

  const toggle = showAll();
  expect(toggle?.textContent).toBe("Show all");
  expect(toggle!.getAttribute("aria-expanded")).toBe("false");
  expect(toggle!.getAttribute("aria-controls")).toBe(context!.id);

  act(() => toggle!.click());
  expect(context!.className).not.toContain("line-clamp-4");
  expect(context!.scrollHeight).toBeLessThanOrEqual(context!.clientHeight + 1);
  expect(toggle!.textContent).toBe("Show less");
  expect(toggle!.getAttribute("aria-expanded")).toBe("true");

  act(() => toggle!.click());
  expect(context!.className).toContain("line-clamp-4");
  expect(showAll()?.textContent).toBe("Show all");
});

it("shows no Show all when the context fits", () => {
  render(ask("Needs a Robob restart."));
  expect(
    [...host.querySelectorAll("p")].some((node) => node.textContent === "Needs a Robob restart."),
  ).toBe(true);
  expect(showAll()).toBeUndefined();
});

it("offers Show all once longer context arrives on the same card", () => {
  render(ask("Needs a Robob restart."));
  expect(showAll()).toBeUndefined();
  render(ask(LONG));
  expect(showAll()?.textContent).toBe("Show all");
});
