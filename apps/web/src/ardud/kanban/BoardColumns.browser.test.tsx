import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import {
  boardStateFromSnapshot,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanCard, KanbanBoardSnapshot } from "@t3tools/contracts";

import { BoardColumns } from "./BoardColumns";
import { boardColumnsStorageKey } from "./useBoardColumnPrefs";

const BOARD_ID = "board-test";
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const model = { instanceId: "opencode", model: "opus/claude-opus-5-5" } as never;

function card(number: number, stage: KanbanCard["stage"]): KanbanCard {
  return {
    id: `card-${number}`,
    boardId: BOARD_ID,
    number,
    title: `Card ${number}`,
    description: "",
    prompt: "",
    stage,
    priority: 3,
    goalId: null,
    projects: [],
    model,
    models: [],
    subtasks: [],
    subtaskSeq: 0,
    projectId: null,
    links: [],
    blockedBy: [],
    stalled: null,
    question: null,
    asks: [],
    reviewChain: null,
    reviewStep: 0,
    reviewRound: 0,
    activeThreadId: null,
    activeRole: null,
    activePool: null,
    workThreadId: null,
    reviewThreadId: null,
    discussionId: null,
    wakeNote: null,
    nudgedAt: null,
    settledAt: null,
    createdBy: { _tag: "owner" },
    createdAt: "2026-10-27T09:00:00.000Z",
    updatedAt: "2026-10-27T09:00:00.000Z",
    movedAt: "2026-10-27T09:00:00.000Z",
  } as unknown as KanbanCard;
}

function boardState(): KanbanBoardState {
  const snapshot = {
    board: { id: BOARD_ID, name: "Test", stateSeq: 1 },
    cards: [card(1, "todo"), card(2, "working"), card(3, "shipped" as never), card(4, "needs_owner")],
    goals: [],
    pools: [],
    groups: [],
    threads: [],
    unread: [],
  } as unknown as KanbanBoardSnapshot;
  return boardStateFromSnapshot(snapshot);
}

let root: Root;
let container: HTMLDivElement;

const column = (label: string) =>
  container.querySelector<HTMLElement>(`section[aria-label="${label}"]`);

const handle = (label: string) =>
  container.querySelector<HTMLElement>(`[role="separator"][aria-label="Resize ${label}"]`);

const readStored = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null");

async function render(state = boardState()) {
  await act(() =>
    root.render(
      <BoardColumns
        boardId={BOARD_ID}
        state={state}
        nowMs={NOW}
        group="stage"
        filter={{}}
        selectedCardId={undefined}
        onOpenCard={() => {}}
        onOpenGoal={() => {}}
      />,
    ),
  );
}

const isStageGrid = () => container.querySelector('[role="tablist"]') === null;

beforeEach(async () => {
  // The stage grid needs a wide viewport; a narrow one picks the phone tabs.
  await page.viewport(1400, 900);
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A wide board, so the stage grid is picked over the phone tabs.
  container = document.createElement("div");
  // Wide enough that BoardColumns picks StageGrid over the phone tabs.
  container.style.width = "1400px";
  container.style.height = "800px";
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stage columns", () => {
  it("resizes a column with the keyboard and saves it under the board key", async () => {
    // aria-valuenow is read during render, before the first layout, so re-render once
    // to show the measured width the keyboard will step from.
    await render();
    const separator = handle("To-Do");
    expect(separator).not.toBeNull();
    const before = Number(separator!.getAttribute("aria-valuenow"));

    await act(() => {
      separator!.focus();
      separator!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    const after = Number(handle("To-Do")!.getAttribute("aria-valuenow"));
    expect(after).toBe(before + 16);
    expect(readStored(boardColumnsStorageKey(BOARD_ID))).toMatchObject({
      widths: { todo: before + 16 },
    });
  });

  it("resets a column width on double-click and saves the reset", async () => {
    await act(() => {
      handle("To-Do")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(readStored(boardColumnsStorageKey(BOARD_ID)).widths.todo).toBeDefined();

    await act(() => {
      handle("To-Do")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    expect(readStored(boardColumnsStorageKey(BOARD_ID)).widths.todo).toBeUndefined();
  });

  it("hides a column as a rail and shows it again on click", async () => {
    expect(column("Working")).not.toBeNull();

    // Hiding goes through the menu toggle; mount with the stored prefs, as a reload would.
    await act(() => root.unmount());
    container.replaceChildren();
    localStorage.setItem(
      boardColumnsStorageKey(BOARD_ID),
      JSON.stringify({ widths: {}, hidden: ["working"], groupWidth: null }),
    );
    root = createRoot(container);
    await render();

    // The stage grid, not the phone tabs, must be the layout under test.
    expect(isStageGrid()).toBe(true);
    expect(column("Working")).toBeNull();
    const rail = container.querySelector<HTMLButtonElement>('button[aria-label^="Show Working"]');
    expect(rail).not.toBeNull();

    await act(() => rail!.click());

    expect(column("Working")).not.toBeNull();
    expect(readStored(boardColumnsStorageKey(BOARD_ID)).hidden).toEqual([]);
  });
});

function pointer(
  element: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
) {
  element.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 7, clientX }),
  );
}

describe("pointer drag", () => {
  it("widens an unsaved column from its rendered width and saves once on release", async () => {
    const separator = handle("To-Do")!;
    const column = separator.parentElement as HTMLElement;
    const startWidth = column.getBoundingClientRect().width;
    const writes = vi.spyOn(Storage.prototype, "setItem");

    await act(() => pointer(separator, "pointerdown", 100));
    await act(() => pointer(separator, "pointermove", 160));
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    // Live: the rendered column follows the pointer, no save yet.
    expect(column.getBoundingClientRect().width).toBeCloseTo(startWidth + 60, 0);
    expect(writes.mock.calls.filter(([key]) => key === boardColumnsStorageKey(BOARD_ID))).toHaveLength(0);

    await act(() => pointer(separator, "pointerup", 160));

    expect(readStored(boardColumnsStorageKey(BOARD_ID)).widths.todo).toBeCloseTo(startWidth + 60, 0);
    expect(writes.mock.calls.filter(([key]) => key === boardColumnsStorageKey(BOARD_ID))).toHaveLength(1);
  });
});
