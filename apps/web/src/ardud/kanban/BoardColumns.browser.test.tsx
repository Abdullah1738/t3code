import "../../index.css";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";

import {
  boardStateFromSnapshot,
  createBoardView,
  EMPTY_FILTER_PREFS,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanCard, KanbanBoardSnapshot } from "@t3tools/contracts";

import { BoardColumns } from "./BoardColumns";
import { BoardColumnsMenu } from "./BoardColumnsMenu";
import { BoardFilterMenu } from "./BoardFilterMenu";
import "./tokens.css";
import "./kanban.css";
import { boardColumnsStorageKey } from "./useBoardColumnPrefs";

// The board links to the Needs you page; a plain anchor stands in for the router's link.
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { children?: unknown; className?: string; "aria-label"?: string }) =>
      createElement(
        "a",
        { href: "/needs-you", className: props.className, "aria-label": props["aria-label"] },
        props.children as never,
      ),
  };
});

const BOARD_ID = "board-test";
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const model = { instanceId: "opencode", model: "opus/claude-opus-5-5" } as never;

function card(
  number: number,
  stage: KanbanCard["stage"],
  patch: Partial<KanbanCard> = {},
): KanbanCard {
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
    ...patch,
  } as unknown as KanbanCard;
}

function boardState(): KanbanBoardState {
  const snapshot = {
    board: { id: BOARD_ID, name: "Test", stateSeq: 1 },
    cards: [
      card(1, "todo"),
      card(2, "working"),
      card(3, "shipped" as never),
      card(4, "needs_owner"),
    ],
    goals: [],
    pools: [],
    groups: [],
    threads: [],
    unread: [],
  } as unknown as KanbanBoardSnapshot;
  return boardStateFromSnapshot(snapshot);
}

const TITLES = [
  "Board: wider busy columns, folded Shipped, iPad touch sizes",
  "Fix OTP field focus on the login sheet",
  "Morning brief card shows WHOOP numbers once they are scored",
  "Retry the checkout when the delivery slot goes stale",
  "Deduplicate watcher wakes that arrive within a minute of each other",
];

const prLink = (number: number): KanbanCard["links"][number] => ({
  kind: "pr",
  url: `https://github.com/pingdotgg/t3code/pull/${number}`,
  label: "fix(web): the board keeps long pull request labels inside the card at every width",
  state: "open",
  checkedAt: null,
});

const subtasks = (done: number, total: number): KanbanCard["subtasks"] =>
  Array.from({ length: total }, (_, index) => ({
    id: `s${index + 1}`,
    step: 1,
    text: `Step ${index + 1}`,
    owner: "work" as const,
    state: index < done ? ("done" as const) : ("open" as const),
    note: null,
    doneBy: null,
    doneAt: null,
  }));

/** A busy board like the real one: a long To-Do, a few in flight, one question. */
function toyState(): KanbanBoardState {
  let number = 100;
  const make = (
    stage: KanbanCard["stage"],
    count: number,
    patch: (index: number) => Partial<KanbanCard> = () => ({}),
  ) =>
    Array.from({ length: count }, (_, index) => {
      number += 1;
      return card(number, stage, {
        title: TITLES[number % TITLES.length]!,
        priority: (number % 4) + 1,
        movedAt: new Date(NOW - (number - 100) * 3_600_000).toISOString(),
        ...patch(index),
      });
    });
  const snapshot = {
    board: { id: BOARD_ID, name: "Toy", stateSeq: 1 },
    cards: [
      ...make("todo", 30, (index) => (index % 4 === 0 ? { links: [prLink(1200 + index)] } : {})),
      ...make("working", 6, (index) => ({
        links: [prLink(1300 + index)],
        subtasks: subtasks(index, 5),
        goalId: "goal-ipad" as KanbanCard["goalId"],
      })),
      ...make("needs_review", 1, () => ({ links: [prLink(1400)] })),
      ...make("in_review", 2, (index) => ({ links: [prLink(1410 + index)] })),
      ...make("completed", 5),
      ...make("deployed", 2),
      ...make("needs_owner", 1, () => ({
        question: "Should the iPad board fold Shipped by default below 1400px?",
      })),
    ],
    goals: [
      {
        id: "goal-ipad",
        boardId: BOARD_ID,
        name: "iPad board",
        status: "active",
        now: null,
        story: [],
        createdAt: "2026-10-20T00:00:00.000Z",
      },
    ],
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
        model={createBoardView().model(state, NOW, { filter: {}, group: "stage" })}
        group="stage"
        lens="all"
        onGroup={() => {}}
        onLens={() => {}}
        filter={{}}
        selectedCardId={undefined}
        onOpenCard={() => {}}
        onOpenGoal={() => {}}
        onClearFilters={() => {}}
      />,
    ),
  );
}

/** The phone layout's column switcher: one column at a time. */
const columnSwitcher = () =>
  container.querySelector<HTMLElement>('[role="group"][aria-label="Column"]');

const isStageGrid = () => columnSwitcher() === null;

beforeEach(async () => {
  // The stage grid needs a wide viewport; a narrow one picks the phone's column switcher.
  await page.viewport(1400, 900);
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A wide board, so the stage grid is picked over the phone layout.
  container = document.createElement("div");
  container.style.width = "1400px";
  container.style.height = "800px";
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
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
    const column = separator!.parentElement as HTMLElement;
    const before = column.getBoundingClientRect().width;

    await act(() => {
      separator!.focus();
      separator!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    // The keyboard step starts from the rendered width and saves that + 16px.
    const saved = readStored(boardColumnsStorageKey(BOARD_ID)).widths.todo;
    expect(saved).toBeCloseTo(before + 16, 0);
  });

  it("resets a column width on double-click and saves the reset", async () => {
    await act(() => {
      handle("To-Do")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
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

    // The stage grid, not the phone layout, must be the layout under test.
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
  // Synthetic pointers have no browser-side pointer to capture; stub capture as
  // useResizableWidth.browser.test does, or the drag aborts before it starts.
  let captured = false;
  element.setPointerCapture = () => {
    captured = true;
  };
  element.hasPointerCapture = () => captured;
  element.releasePointerCapture = () => {
    captured = false;
  };
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
    expect(
      writes.mock.calls.filter(([key]) => key === boardColumnsStorageKey(BOARD_ID)),
    ).toHaveLength(0);

    await act(() => pointer(separator, "pointerup", 160));

    expect(readStored(boardColumnsStorageKey(BOARD_ID)).widths.todo).toBeCloseTo(
      startWidth + 60,
      0,
    );
    expect(
      writes.mock.calls.filter(([key]) => key === boardColumnsStorageKey(BOARD_ID)),
    ).toHaveLength(1);
  });

  it("narrows a column below the layout's min width live and keeps it on release", async () => {
    const separator = handle("To-Do")!;
    const column = separator.parentElement as HTMLElement;
    const startWidth = column.getBoundingClientRect().width;
    const target = 160;

    await act(() => pointer(separator, "pointerdown", 400));
    await act(() => pointer(separator, "pointermove", 400 - (startWidth - target)));
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    expect(column.getBoundingClientRect().width).toBeCloseTo(target, 0);

    await act(() => pointer(separator, "pointerup", 400 - (startWidth - target)));
    expect(readStored(boardColumnsStorageKey(BOARD_ID)).widths.todo).toBeCloseTo(target, 0);
    expect(column.getBoundingClientRect().width).toBeCloseTo(target, 0);
  });
});

describe("group columns", () => {
  it("moves every group column together while dragging one handle", async () => {
    // Two project groups, so there are two columns that must resize together.
    const withProjects = {
      ...boardState(),
      cards: new Map([
        ["card-1", { ...card(1, "todo"), projects: ["Alpha"] }],
        ["card-2", { ...card(2, "working"), projects: ["Beta"] }],
      ]),
    } as unknown as KanbanBoardState;
    await act(() => root.unmount());
    container.replaceChildren();
    root = createRoot(container);
    await act(() =>
      root.render(
        <BoardColumns
          boardId={BOARD_ID}
          model={createBoardView().model(withProjects, NOW, { filter: {}, group: "project" })}
          group="project"
          lens="all"
          onGroup={() => {}}
          onLens={() => {}}
          filter={{}}
          selectedCardId={undefined}
          onOpenCard={() => {}}
          onOpenGoal={() => {}}
          onClearFilters={() => {}}
        />,
      ),
    );

    const groups = [...container.querySelectorAll<HTMLElement>("section[aria-label]")].filter(
      (section) => section.querySelector('[role="separator"]'),
    );
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const [first, second] = groups as [HTMLElement, HTMLElement];
    const separator = first.querySelector<HTMLElement>('[role="separator"]')!;
    const secondStart = second.getBoundingClientRect().width;

    await act(() => pointer(separator, "pointerdown", 100));
    await act(() => pointer(separator, "pointermove", 160));
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

    // Live: the second group follows the shared width before anything is saved.
    expect(second.getBoundingClientRect().width).toBeGreaterThan(secondStart + 40);
    await act(() => pointer(separator, "pointerup", 160));
    expect(readStored(boardColumnsStorageKey(BOARD_ID)).groupWidth).toBeGreaterThan(256);
  });
});

const SHIPPED_KEY = "t3code:kanban:board:shipped";

/** Remount the toy board in a viewport of this size, with a touch or mouse pointer. */
async function mountAt(width: number, height: number, pointerKind: "coarse" | "fine") {
  await act(() => root.unmount());
  container.replaceChildren();
  await page.viewport(width, height);
  // Headless Chromium ignores a `pointer` media feature override; touch emulation is
  // what flips `(pointer: coarse)`.
  await cdp().send("Emulation.setTouchEmulationEnabled", {
    enabled: pointerKind === "coarse",
    maxTouchPoints: 5,
  });
  // Like the board's <main>: a flex column with its start and top padding.
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    width: `${width}px`,
    height: `${height}px`,
    paddingLeft: "20px",
    paddingTop: "18px",
  });
  root = createRoot(container);
  await render(toyState());
  // The board picks its layout from its own measured width, a frame after mount.
  await act(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );
}

const rect = (element: Element) => element.getBoundingClientRect();

// The lens switch keeps a 36 px pill on touch and fills its 44 px track with the hit
// area, so its buttons are measured by the track.
const shortButtons = () =>
  [...container.querySelectorAll("button")]
    .filter((button) => button.closest('[role="group"][aria-label="Lens"]') === null)
    .filter((button) => rect(button).height < 44)
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);

const STATE_LABELS = ["To-Do", "Working", "Reviewing", "In review, waiting"] as const;

describe("iPad layout", () => {
  it("lays a landscape touch board out as columns that scroll sideways, Shipped folded", async () => {
    await mountAt(1084, 900, "coarse");

    expect(isStageGrid()).toBe(true);
    for (const label of [...STATE_LABELS, "Needs you"]) {
      expect(column(label), label).not.toBeNull();
    }
    expect(column("Shipped")).toBeNull();

    // Every state has its own column at a readable width, side by side.
    const top = rect(column("To-Do")!).top;
    for (const label of STATE_LABELS) {
      expect(rect(column(label)!).width, label).toBeGreaterThanOrEqual(248);
      expect(rect(column(label)!).top, label).toBeCloseTo(top, 0);
    }

    // Too narrow for all of them: the strip scrolls sideways and takes Needs you with it.
    const strip = column("To-Do")!.parentElement!;
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    expect(column("Needs you")!.parentElement).toBe(strip);
    // No column's own list scrolls sideways.
    for (const list of container.querySelectorAll<HTMLElement>(
      "section[data-column] > div:last-child",
    )) {
      expect(list.scrollWidth, list.parentElement!.ariaLabel ?? "").toBeLessThanOrEqual(
        list.clientWidth,
      );
    }

    const folded = container.querySelector('button[aria-label="Show shipped cards"]');
    expect(folded?.getAttribute("aria-expanded")).toBe("false");
    expect(shortButtons()).toEqual([]);
    const lens = container.querySelector('[role="group"][aria-label="Lens"]')!;
    expect(rect(lens).height).toBeGreaterThanOrEqual(44);
  });

  it("keeps Needs you beside the strip on a board wide enough for every column", async () => {
    await mountAt(1400, 900, "fine");

    const strip = column("To-Do")!.parentElement!;
    expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
    expect(column("Needs you")!.parentElement).not.toBe(strip);
  });

  it("opens folded Shipped on click and keeps it open after a reload", async () => {
    await mountAt(1340, 1000, "coarse");
    const folded = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show shipped cards"]',
    );
    expect(folded).not.toBeNull();

    await act(() => folded!.click());

    const fold = container.querySelector('button[aria-label="Fold shipped cards"]');
    expect(fold?.getAttribute("aria-expanded")).toBe("true");
    const shipped = column("Shipped")!;
    expect(shipped.textContent).toContain("Completed");
    const rows = [...shipped.querySelectorAll("button")].filter((button) => button !== fold);
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(rect(row).height).toBeGreaterThanOrEqual(44);

    await mountAt(1340, 1000, "coarse");
    expect(column("Shipped")).not.toBeNull();
    expect(readStored(SHIPPED_KEY)).toBe("open");
  });

  it("opens Shipped by default on a wide mouse board and keeps desktop sizes", async () => {
    // Shipped opens by itself from a 1500 px board; the container pads 20.
    await mountAt(1600, 900, "fine");

    expect(column("Shipped")).not.toBeNull();
    expect(
      container
        .querySelector('button[aria-label="Fold shipped cards"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    const header = column("To-Do")!.querySelector(":scope > div:not([role='separator'])")!;
    expect(getComputedStyle(header).fontSize).toBe("12px");
  });

  it("shows one column at a time under a column switcher on a phone-width board", async () => {
    await mountAt(390, 844, "coarse");

    const switcher = columnSwitcher();
    expect(switcher).not.toBeNull();
    expect(column("Working")).toBeNull();
    // The first column with cards is picked, and only one is pressed.
    const pressed = [...switcher!.querySelectorAll('button[aria-pressed="true"]')];
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.textContent).toContain("To-Do");

    const working = [...switcher!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Working"),
    )!;
    await act(() => working.click());
    expect(working.getAttribute("aria-pressed")).toBe("true");
    expect(switcher!.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
    expect(shortButtons()).toEqual([]);
  });
});

describe("header triggers", () => {
  /** The board header's Columns and Filter menus, as BoardControls mounts them. */
  async function mountHeader(pointerKind: "coarse" | "fine") {
    await mountAt(1084, 900, pointerKind);
    await act(() =>
      root.render(
        <div>
          <BoardColumnsMenu boardId={BOARD_ID} />
          <BoardFilterMenu
            state={toyState()}
            prefs={EMPTY_FILTER_PREFS}
            narrow={false}
            onChange={() => {}}
          />
        </div>,
      ),
    );
    const trigger = (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    return [trigger("Columns"), trigger("Filter")] as const;
  }

  it("gives Columns and Filter touch height under a coarse pointer", async () => {
    for (const trigger of await mountHeader("coarse")) {
      expect(rect(trigger).height, trigger.ariaLabel ?? "").toBeGreaterThanOrEqual(44);
    }
  });

  it("keeps Columns and Filter at desktop height under a fine pointer", async () => {
    for (const trigger of await mountHeader("fine")) {
      expect(rect(trigger).height, trigger.ariaLabel ?? "").toBeCloseTo(32, 0);
    }
  });
});

describe("review columns", () => {
  it.each([
    ["needs_review", "Reviewing", "In review, waiting"],
    ["in_review", "In review, waiting", "Reviewing"],
  ] as const)(
    "hides %s as a rail and keeps the other review column whole",
    async (hiddenStage, hiddenLabel, shownLabel) => {
      localStorage.setItem(
        boardColumnsStorageKey(BOARD_ID),
        JSON.stringify({ widths: {}, hidden: [hiddenStage], groupWidth: null }),
      );
      await mountAt(1400, 900, "fine");

      expect(isStageGrid()).toBe(true);
      expect(column(hiddenLabel)).toBeNull();
      const restore = container.querySelector<HTMLElement>(
        `button[aria-label^="Show ${hiddenLabel}"]`,
      );
      expect(restore).not.toBeNull();
      // The rail stands where the column stood, in the strip beside its neighbour.
      const shown = column(shownLabel)!;
      expect(restore!.parentElement).toBe(shown.parentElement);
      expect(rect(restore!).top).toBeCloseTo(rect(shown).top, 0);
      expect(rect(shown).width).toBeGreaterThanOrEqual(184);
      expect(rect(shown).bottom).toBeLessThanOrEqual(900);
      expect(shown.querySelectorAll("button").length).toBeGreaterThan(0);

      await act(() => restore!.click());
      expect(column(hiddenLabel)).not.toBeNull();
    },
  );

  it("fits the board without sideways scroll at the iPad width with both hidden", async () => {
    localStorage.setItem(
      boardColumnsStorageKey(BOARD_ID),
      JSON.stringify({ widths: {}, hidden: ["needs_review", "in_review"], groupWidth: null }),
    );
    await mountAt(1084, 900, "coarse");

    expect(isStageGrid()).toBe(true);
    expect(container.querySelector('button[aria-label^="Show Reviewing"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label^="Show In review, waiting"]')).not.toBeNull();
    const strip = column("To-Do")!.parentElement as HTMLElement;
    expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  });
});

describe("saved widths", () => {
  const saveWidths = (widths: Record<string, number>) =>
    localStorage.setItem(
      boardColumnsStorageKey(BOARD_ID),
      JSON.stringify({ widths, hidden: [], groupWidth: null }),
    );

  it("keeps saved work widths below the layout default after a reload", async () => {
    saveWidths({ todo: 160, working: 150 });
    await mountAt(1500, 900, "fine");

    expect(rect(column("To-Do")!).width).toBeCloseTo(160, 0);
    expect(rect(column("Working")!).width).toBeCloseTo(150, 0);
  });

  it("keeps saved review widths after a reload", async () => {
    saveWidths({ needs_review: 480, in_review: 360 });
    await mountAt(1500, 900, "fine");

    expect(rect(column("Reviewing")!).width).toBeCloseTo(480, 0);
    expect(rect(column("In review, waiting")!).width).toBeCloseTo(360, 0);
  });

  it("saves a Reviewing resize to that column alone and keeps it after a reload", async () => {
    await mountAt(1500, 900, "fine");
    const before = rect(column("Reviewing")!).width;

    await act(() => {
      handle("Reviewing")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });

    const { widths } = readStored(boardColumnsStorageKey(BOARD_ID));
    expect(widths.needs_review).toBeCloseTo(before + 16, 0);
    expect(widths.in_review).toBeUndefined();

    await mountAt(1500, 900, "fine");
    expect(rect(column("Reviewing")!).width).toBeCloseTo(before + 16, 0);
  });
});

describe("left-edge keyboard step", () => {
  it("widens Needs you from its rendered width on ArrowLeft", async () => {
    const separator = handle("Needs you")!;
    const column = separator.parentElement as HTMLElement;
    const before = column.getBoundingClientRect().width;

    await act(() => {
      separator.focus();
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });

    // The left edge widens when the handle moves left, so ArrowLeft adds 16px.
    expect(readStored(boardColumnsStorageKey(BOARD_ID)).widths.needs_owner).toBeCloseTo(
      before + 16,
      0,
    );
  });
});
