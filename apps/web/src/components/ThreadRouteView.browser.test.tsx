import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  refresh: vi.fn(),
  unarchive: vi.fn(),
  shell: null as any,
  draftSession: null as any,
  draftThread: null as any,
  promotedDraftId: null as any,
  mounts: 0,
  started: false,
  finalize: vi.fn(),
  state: { status: "empty", data: null, error: null } as any,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("./ChatView", async () => {
  const React = await import("react");
  return {
    default: (props: any) => {
      const [instance] = React.useState(() => ++mocks.mounts);
      return (
        <div data-chat data-instance={instance} data-read-only={String(props.readOnly)}>
          Transcript
        </div>
      );
    },
  };
});
vi.mock("./ChatView.logic", () => ({
  resolveDraftPromotionNavigationTarget: () => null,
  threadHasStarted: () => mocks.started,
}));
vi.mock("./ui/sidebar", () => ({ SidebarInset: (props: any) => <div>{props.children}</div> }));
vi.mock("../state/entities", () => ({
  useThreadRefs: () => [],
  useQuietThreadShell: () => mocks.shell,
}));
vi.mock("../state/threads", () => ({
  useEnvironmentThread: () => mocks.state,
  environmentThreads: { stateAtom: () => "thread-detail" },
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: mocks.refresh } }));
vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({ unarchiveThread: mocks.unarchive }),
}));
vi.mock("../composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: (select: any) =>
      select({
        getDraftSession: () => mocks.draftSession,
        getDraftThreadByRef: () => mocks.draftThread,
        getDraftIdByRef: () => mocks.promotedDraftId,
      }),
    useBackgroundDraftSubmissionPending: () => false,
    finalizePromotedDraftThreadByRef: mocks.finalize,
    markPromotedDraftThreadByRef: vi.fn(),
  };
});
vi.mock("@t3tools/client-runtime/state/threads", () => ({
  threadDetailToShell: (_env: unknown, projection: any) => projection.thread,
}));
import { ThreadRouteView } from "./ThreadRouteView";
import type { ThreadRouteTarget } from "../threadRoutes";

const target: ThreadRouteTarget = {
  kind: "server",
  threadRef: { environmentId: "env" as never, threadId: "linked-card-thread" as never },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.shell = null;
  mocks.started = false;
  mocks.finalize.mockReset();
  mocks.draftSession = null;
  mocks.draftThread = null;
  mocks.promotedDraftId = null;
  mocks.mounts = 0;
  mocks.state = { status: "empty", data: Option.none(), error: Option.none() };
  mocks.navigate.mockReset();
  mocks.refresh.mockReset();
  mocks.unarchive.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe("linked thread route", () => {
  it.each([
    ["empty", false, "Loading thread"],
    ["deleted", false, "Thread deleted"],
    ["no-access", false, "No access to this thread"],
    ["empty", true, "Thread unavailable"],
  ])("shows %s without redirecting from an empty shell", async (status, error, title) => {
    mocks.state = { ...mocks.state, status, error: error ? Option.some("Offline") : Option.none() };
    await act(() => root.render(<ThreadRouteView target={target} />));
    expect(container.textContent).toContain(title);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("opens a by-id thread even when the loaded shell is empty", async () => {
    mocks.state.data = Option.some({ thread: { archivedAt: null, deletedAt: null } });
    await act(() => root.render(<ThreadRouteView target={target} />));
    expect(container.textContent).toContain("Transcript");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("renders archived content read-only and restores without leaving the route", async () => {
    mocks.shell = { archivedAt: null, deletedAt: null };
    mocks.state.data = Option.some({ thread: { archivedAt: "2026-11-08", deletedAt: null } });
    await act(() => root.render(<ThreadRouteView target={target} />));
    expect(container.querySelector("[data-chat]")?.getAttribute("data-read-only")).toBe("true");
    await act(() =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Restore")!.click(),
    );
    expect(mocks.unarchive).toHaveBeenCalledWith(target.threadRef, { navigate: false });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("offers recovery when detail stalls despite a shell row", async () => {
    vi.useFakeTimers();
    mocks.shell = { archivedAt: null, deletedAt: null };
    try {
      await act(() => root.render(<ThreadRouteView target={target} />));
      expect(container.textContent).toContain("Loading thread");
      await act(() => vi.advanceTimersByTime(15_000));
      expect(container.textContent).toContain("Thread unavailable");
      expect(mocks.navigate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps deleted detail authoritative over an existing shell", async () => {
    mocks.shell = { archivedAt: null, deletedAt: null };
    mocks.state.status = "deleted";
    await act(() => root.render(<ThreadRouteView target={target} />));
    expect(container.textContent).toContain("Thread deleted");
  });
  it("preserves the optimistic chat instance during draft promotion while detail catches up", async () => {
    const draftId = "draft-1" as never;
    mocks.draftSession = { ...target.threadRef, promotedTo: null };
    await act(() => root.render(<ThreadRouteView target={{ kind: "draft", draftId }} />));
    const instance = container.querySelector("[data-chat]")?.getAttribute("data-instance");
    expect(instance).toBeTruthy();
    mocks.draftSession = null;
    mocks.draftThread = { ...target.threadRef };
    mocks.promotedDraftId = draftId;
    await act(() => root.render(<ThreadRouteView target={target} />));
    expect(container.querySelector("[data-chat]")?.getAttribute("data-instance")).toBe(instance);
    expect(mocks.mounts).toBe(1);
  });
  it("keeps a promoted draft until detail arrives even when the shell has started", async () => {
    const draftId = "draft-started" as never;
    mocks.draftSession = { ...target.threadRef, promotedTo: null };
    await act(() => root.render(<ThreadRouteView target={{ kind: "draft", draftId }} />));
    const instance = container.querySelector("[data-chat]")?.getAttribute("data-instance");
    mocks.draftSession = null;
    mocks.draftThread = { ...target.threadRef };
    mocks.promotedDraftId = draftId;
    mocks.shell = { archivedAt: null, deletedAt: null };
    mocks.started = true;
    await act(() => root.render(<ThreadRouteView target={target} />));
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(container.querySelector("[data-chat]")?.getAttribute("data-instance")).toBe(instance);
    mocks.state.data = Option.some({ thread: { archivedAt: null, deletedAt: null } });
    await act(() => root.render(<ThreadRouteView target={target} />));
    expect(mocks.finalize).toHaveBeenCalledWith(target.threadRef);
    mocks.draftThread = null;
    mocks.promotedDraftId = null;
    await act(() => root.render(<ThreadRouteView target={target} />));
    expect(container.querySelector("[data-chat]")?.getAttribute("data-instance")).toBe(instance);
    expect(mocks.mounts).toBe(1);
  });
  it("retries the by-id detail subscription", async () => {
    await act(() => root.render(<ThreadRouteView target={target} />));
    await act(() =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click(),
    );
    expect(mocks.refresh).toHaveBeenCalledWith("thread-detail");
  });
});
