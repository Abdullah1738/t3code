import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { KanbanBoardListEntry, KanbanWatchEvent } from "@t3tools/contracts";

const feeds = vi.hoisted(() => ({
  list: null as ((value: ReadonlyArray<KanbanBoardListEntry>) => void) | null,
  board: null as ((value: KanbanWatchEvent) => void) | null,
}));
vi.mock("@t3tools/client-runtime/ardud/kanban", async (original) => ({
  ...(await original<object>()),
  createAtomKanbanTransport: () => ({
    stream: (tag: string, _input: unknown, push: (value: never) => void) => {
      if (tag === "kanban.boards") feeds.list = push as typeof feeds.list;
      else if (tag === "kanban.subscribe") feeds.board = push as typeof feeds.board;
      return () => {};
    },
    request: () => Promise.resolve([]),
  }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../common/environment", () => ({
  pairedEnvironmentIdAtom: {},
  usePairedEnvironmentId: () => "env",
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
function NativeView({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) {
  useEffect(() => {
    onLayout?.({ nativeEvent: { layout: { width: 390 } } });
  }, [onLayout]);
  return <div>{children}</div>;
}
vi.mock("react-native", () => ({ View: NativeView }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: NativeView,
  useKeyboardState: () => false,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => <div>Header</div> }));
vi.mock("../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../common/FeedError", () => ({
  FeedError: () => null,
  LoadingLine: () => <div>Loading</div>,
}));
vi.mock("../common/parts", () => ({
  EmptyLine: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("../common/hooks", () => ({
  useBoardAction: () => ({}),
  useHeaderInset: () => 0,
  useNowMs: () => 0,
}));
vi.mock("./BoardView", () => ({
  BoardView: () => <div>Live board</div>,
  PauseStrip: () => null,
  SetupStrip: () => null,
}));
vi.mock("./CardDetail", () => ({ CardDetail: () => <div>Live card</div> }));
vi.mock("./boardFilterStore", () => ({ useBoardFilter: () => ({}) }));
vi.mock("./copyLink", () => ({ copyLinkAction: () => ({}) }));
vi.mock("./Chat", () => ({ Chat: () => null }));
vi.mock("../../features/threads/CustomSnoozeSheet", () => ({ CustomSnoozeSheet: () => null }));
vi.mock("./discussionActions", () => ({
  discussionMenu: () => [],
  MENU_ICONS: {},
  runDiscussionMenu: vi.fn(),
  snoozeDiscussion: vi.fn(),
}));
vi.mock("./DiscussionList", () => ({ DiscussionList: () => null }));
vi.mock("./GoalView", () => ({ GoalView: () => null }));
vi.mock("./useHideCardDiscussions", () => ({ useHideCardDiscussions: () => false }));
vi.mock("./nav", () => ({ useKanbanNav: () => ({}) }));

import { useKanbanBoards } from "./kanbanStore";
import { KanbanBoardRouteScreen } from "./KanbanBoardRouteScreen";
import { KanbanRecordRouteScreen } from "./KanbanRecordRouteScreen";

function List() {
  const boards = useKanbanBoards();
  return <div data-list>{boards?.map((entry) => entry.board.name).join(",")}</div>;
}

it("mobile removes archived boards live, handles stale board/card links, and re-shows restored boards", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const board = { id: "board-mobile", name: "Mobile board", archivedAt: null };
  const show = (archivedAt: string | null) => {
    const changed = { ...board, archivedAt };
    feeds.list?.([
      { boardId: board.id, board: changed, threadIds: [], needsOwner: 0, running: 0, unread: 0 },
    ] as never);
    feeds.board?.({
      _tag: "snapshot",
      snapshot: {
        board: changed,
        cards: [{ id: "card-1" }],
        goals: [],
        pools: [],
        groups: [],
        threads: [],
        unread: [],
      },
    } as never);
  };
  try {
    await act(async () =>
      root.render(
        <>
          <List />
          <KanbanBoardRouteScreen route={{ params: { boardId: board.id } } as never} />
        </>,
      ),
    );
    await act(async () => show(null));
    expect(container.querySelector("[data-list]")?.textContent).toBe("Mobile board");
    expect(container.textContent).toContain("Live board");
    await act(async () => show("2026-11-14T12:00:00.000Z"));
    expect(container.querySelector("[data-list]")?.textContent).toBe("");
    expect(container.textContent).not.toContain("Live board");
    expect(container.textContent).toContain("This link does not open a board.");
    await act(async () =>
      root.render(
        <KanbanRecordRouteScreen
          route={{ params: { boardId: board.id, kind: "card", id: "card-1" } } as never}
        />,
      ),
    );
    expect(container.textContent).toContain("This link does not open anything.");
    await act(async () => root.unmount());
    const stale = createRoot(container);
    await act(async () =>
      stale.render(
        <>
          <List />
          <KanbanBoardRouteScreen route={{ params: { boardId: board.id } } as never} />
        </>,
      ),
    );
    expect(container.textContent).toContain("This link does not open a board.");
    await act(async () => show(null));
    expect(container.textContent).toContain("Live board");
    expect(container.querySelector("[data-list]")?.textContent).toBe("Mobile board");
    await act(async () => stale.unmount());
  } finally {
    container.remove();
  }
});
