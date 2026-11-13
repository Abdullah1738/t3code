import { act, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createAskScopes, type AskScopes } from "./askScope";
import { askInViewport, type AskRect } from "./askViewport";

const ui = vi.hoisted(() => ({
  rects: new Map<string, { x: number; y: number; width: number; height: number }>(),
  handlers: new Map<
    string,
    { onScroll?: (event: unknown) => void; onLayout?: (event: unknown) => void }
  >(),
  frames: new Map<number, FrameRequestCallback>(),
  appListeners: new Set<() => void>(),
  sent: [] as Array<{ path: string; body: unknown }>,
  state: "active",
  focused: true,
  owner: true,
  scope: null as unknown,
}));

interface NativeProps {
  ref?: Ref<{
    measureInWindow: (read: (x: number, y: number, width: number, height: number) => void) => void;
  }>;
  testID?: string;
  children?: ReactNode;
  onScroll?: (event: unknown) => void;
  onLayout?: (event: unknown) => void;
}
function NativeView({ ref, testID, children, onScroll, onLayout }: NativeProps) {
  const element = useRef<HTMLDivElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      measureInWindow: (read) => {
        const key = testID ?? element.current?.closest<HTMLElement>("[data-row]")?.dataset.row;
        const rect = ui.rects.get(key ?? "") ?? { x: 0, y: 0, width: 0, height: 0 };
        read(rect.x, rect.y, rect.width, rect.height);
      },
    }),
    [testID],
  );
  if (testID)
    ui.handlers.set(testID, {
      ...(onScroll ? { onScroll } : {}),
      ...(onLayout ? { onLayout } : {}),
    });
  return <div ref={element}>{children}</div>;
}
vi.mock("react-native", () => ({
  View: (props: NativeProps) => <NativeView {...props} />,
  ScrollView: (props: NativeProps) => <NativeView {...props} />,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  AppState: {
    get currentState() {
      return ui.state;
    },
    addEventListener: (_event: string, run: () => void) => {
      ui.appListeners.add(run);
      return {
        remove: () => {
          ui.appListeners.delete(run);
        },
      };
    },
  },
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => ui.focused }));
vi.mock("./askStore", () => ({
  useAskScope: () => ui.scope,
  useOwnerStanding: () => ({ sends: ui.owner ? "owner" : "notOwner" }),
}));
import { AskTimingScrollView } from "./AskTimingScrollView";
import { AskTiming, useAskNotifications } from "./useAskTiming";

let root: Root;
let scopes: AskScopes;
let container: HTMLDivElement;
let frameId = 0;
const rect = (y: number, height = 100, x = 0, width = 300): AskRect => ({ x, y, width, height });
const row = (id: string) => (
  <div key={id} data-row={id}>
    <AskTiming cardId={id} askId="q1" />
  </div>
);
const flushFrame = () =>
  act(async () => {
    const frames = [...ui.frames.values()];
    ui.frames.clear();
    for (const run of frames) run(0);
  });
const scroll = async (id: string) => {
  await act(async () => {
    ui.handlers.get(id)?.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: 100 } } });
  });
  await flushFrame();
};

beforeEach(() => {
  ui.rects.clear();
  ui.handlers.clear();
  ui.frames.clear();
  ui.appListeners.clear();
  ui.sent.length = 0;
  ui.state = "active";
  ui.focused = true;
  ui.owner = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    ui.frames.set(++frameId, run);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => ui.frames.delete(id));
  scopes = createAskScopes({
    paired: () => "A",
    onPairedChange: () => () => {},
    target: () => ({ base: "https://a.test", headers: {}, cookies: true }),
    session: () => ({ state: "read", authenticated: true, owner: ui.owner }),
    onSessionChange: () => () => {},
    rereadSession: () => {},
    connection: () => "live",
    onConnectionChange: () => () => {},
    reconnect: () => {},
    sendSecrets: async () => ({ _tag: "sent" }),
    watch: {
      onBoardsChange: () => () => {},
      onForeground: () => () => {},
      isForeground: () => true,
    },
    defer: queueMicrotask,
    now: Date.now,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      ui.sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ recorded: true });
    }) as typeof fetch,
  });
  ui.scope = scopes.current();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  scopes.stop();
  vi.unstubAllGlobals();
});

describe("rendered mobile ask receipts through the real environment scope", () => {
  it("forwards badge receipts only after owner confirmation, without treating them as seen", async () => {
    function Badge() {
      useAskNotifications([{ cardId: "ask", ask: { id: "q1" } }]);
      return null;
    }
    ui.owner = false;
    await act(async () => root.render(<Badge />));
    expect(ui.sent).toHaveLength(0);
    ui.owner = true;
    await act(async () => root.render(<Badge />));
    expect(ui.sent).toEqual([
      { path: "/api/ardud/kanban/cards/ask/asks/q1/notified", body: { channel: "in_app" } },
    ]);
  });
  it.each(["board", "batch", "card-detail"])(
    "%s: an offscreen mounted row stays unseen until scrolled into view",
    async (surface) => {
      ui.rects.set(surface, rect(100, 250));
      ui.rects.set("first", rect(120));
      ui.rects.set("offscreen", rect(450));
      await act(async () =>
        root.render(
          <AskTimingScrollView testID={surface}>
            {row("first")}
            {row("offscreen")}
          </AskTimingScrollView>,
        ),
      );
      await flushFrame();
      expect(ui.sent.map((entry) => entry.path)).toEqual([
        "/api/ardud/kanban/cards/first/asks/q1/seen",
      ]);
      ui.rects.set("offscreen", rect(170));
      await scroll(surface);
      await scroll(surface);
      expect(ui.sent.map((entry) => entry.path)).toEqual([
        "/api/ardud/kanban/cards/first/asks/q1/seen",
        "/api/ardud/kanban/cards/offscreen/asks/q1/seen",
      ]);
      expect(
        ui.sent.every((entry) => (entry.body as { surface: string }).surface === "mobile"),
      ).toBe(true);
    },
  );

  it("clips nested columns against their horizontal ancestor and refreshes them on parent scroll", async () => {
    ui.rects.set("outer", rect(100, 400, 0, 250));
    ui.rects.set("column", rect(100, 400, 200, 250));
    ui.rects.set("ask", rect(120, 100, 300, 50));
    await act(async () =>
      root.render(
        <AskTimingScrollView testID="outer" horizontal>
          <AskTimingScrollView testID="column">{row("ask")}</AskTimingScrollView>
        </AskTimingScrollView>,
      ),
    );
    await flushFrame();
    await scroll("column");
    expect(ui.sent).toHaveLength(0);
    ui.rects.set("column", rect(100, 400, 0, 250));
    ui.rects.set("ask", rect(120, 100, 100, 50));
    await scroll("outer");
    expect(ui.sent).toHaveLength(1);
  });

  it("waits for foreground, focus and ownership, even with visible rows", async () => {
    ui.state = "background";
    ui.focused = false;
    ui.owner = false;
    ui.rects.set("pane", rect(100, 300));
    ui.rects.set("ask", rect(120));
    const screen = () => <AskTimingScrollView testID="pane">{row("ask")}</AskTimingScrollView>;
    await act(async () => root.render(screen()));
    await flushFrame();
    expect(ui.sent).toHaveLength(0);
    ui.state = "active";
    await act(async () => {
      for (const run of ui.appListeners) run();
    });
    await flushFrame();
    expect(ui.sent).toHaveLength(0);
    ui.focused = true;
    await act(async () => root.render(screen()));
    await flushFrame();
    expect(ui.sent).toHaveLength(0);
    ui.owner = true;
    await act(async () => root.render(screen()));
    await flushFrame();
    expect(ui.sent).toHaveLength(1);
  });

  it("does not treat a row with no measured viewport as seen", async () => {
    ui.rects.set("ask", rect(120));
    await act(async () => root.render(row("ask")));
    await flushFrame();
    expect(ui.sent).toHaveLength(0);
  });
});

const pane = rect(100, 300);
it.each([
  ["visible", rect(120), [pane], true],
  ["partly visible", rect(50), [pane], true],
  ["below", rect(500), [pane], false],
  ["above", rect(-20), [pane], false],
  ["left", rect(120, 100, -100, 50), [pane], false],
  ["right", rect(120, 100, 350, 50), [pane], false],
  ["touches edge", rect(400), [pane], false],
  ["zero height", rect(120, 0), [pane], false],
  ["unmeasured clip", rect(120), [null], false],
  ["invalid geometry", rect(NaN), [pane], false],
  ["clipped ancestor", rect(120, 100, 200, 50), [pane, rect(100, 300, 0, 150)], false],
] as const)("viewport matrix: %s", (_name, row, clips, expected) => {
  expect(askInViewport(row, clips)).toBe(expected);
});
