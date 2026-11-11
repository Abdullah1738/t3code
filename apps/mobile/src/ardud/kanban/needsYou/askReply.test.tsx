/**
 * What leaves the phone when he replies under an ask whose thread holds
 * stand-ins. A block of a kind this build doesn't know is read as a one-line
 * stand-in; sent back, it would replace the real block with that line. The
 * reply is built from what he typed and nothing else, and this drives the real
 * parts to pin it: the ask's talk as the screen renders it (`AskTalk`), the
 * board's composer, the shared store and the HTTP call, over a server that
 * sends blocks only a newer build knows.
 */
import { KANBAN_UNKNOWN_BLOCK_TEXT } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface InputProps {
  readonly accessibilityLabel?: string;
  readonly value?: string;
  readonly onChangeText?: (text: string) => void;
}
interface PressProps {
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly children?: ReactNode;
}

const ui = vi.hoisted(() => ({
  inputs: new Map<string, { onChangeText?: (text: string) => void; value?: string }>(),
  presses: new Map<string, { onPress?: () => void; disabled?: boolean }>(),
  scope: { current: null as unknown },
  boardPost: vi.fn(),
  alerts: [] as Array<string>,
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: PressProps) => {
    if (props.accessibilityLabel !== undefined) {
      ui.presses.set(props.accessibilityLabel, {
        ...(props.onPress === undefined ? {} : { onPress: props.onPress }),
        ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
      });
    }
    return <button type="button">{props.children}</button>;
  },
}));
vi.mock("react-native-webview", () => ({ WebView: () => null }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ isFocused: () => true }),
}));
vi.mock("../../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: InputProps) => {
    if (props.accessibilityLabel !== undefined) {
      ui.inputs.set(props.accessibilityLabel, {
        ...(props.onChangeText === undefined ? {} : { onChangeText: props.onChangeText }),
        ...(props.value === undefined ? {} : { value: props.value }),
      });
    }
    return null;
  },
}));
vi.mock("../../../components/ui/Dialog", () => ({
  alert: (title: string) => void ui.alerts.push(title),
}));
vi.mock("../../../features/threads/ComposerAttachmentButton", () => ({
  ComposerAttachmentButton: () => null,
}));
vi.mock("../../../lib/composerImages", () => ({
  pickComposerFiles: async () => ({ files: [] }),
  pickComposerMedia: async () => ({ attachments: [] }),
}));
vi.mock("../../../lib/attachmentUpload", () => ({
  prepareTurnAttachments: async () => ({ status: "cancelled" }),
  releasePendingAttachmentUploads: async () => undefined,
}));
vi.mock("../../../state/use-composer-drafts", () => ({
  releaseUnusedComposerAttachmentFiles: async () => undefined,
}));
vi.mock("../../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../../state/assets", () => ({ useAssetUrl: () => null }));
vi.mock("@t3tools/client-runtime/state/attachments", () => ({ formatAttachmentSize: () => "" }));
vi.mock("../../common/environment", () => ({ usePairedEnvironmentId: () => "A" }));
vi.mock("../../common/FeedError", () => ({ FeedError: () => null, LoadingLine: () => null }));
vi.mock("../../common/PageLinkOffer", () => ({ PageLinkOffer: () => null }));
// A message's text, as plain text: what the thread shows is read back from the page below.
vi.mock("../../common/MarkdownText", () => ({
  MarkdownText: ({ text }: { text: string }) => <p>{text}</p>,
}));
// The board's one-at-a-time action wrapper, without the alert and layout it brings.
vi.mock("../../common/hooks", () => ({
  useNowMs: () => Date.parse("2026-11-11T09:00:00.000Z"),
  useBoardAction: () => ({
    pending: false,
    run: async (title: string, action: () => Promise<void>) => {
      try {
        await action();
        return true;
      } catch {
        ui.alerts.push(title);
        return false;
      }
    },
  }),
}));
// The board's own discussion post: a reply on an ask must never go this way.
vi.mock("../kanbanStore", () => ({
  kanbanClient: () => ({ post: ui.boardPost, expandMessage: async () => undefined }),
  useKanbanBoardCard: () => undefined,
  useKanbanMessages: () => undefined,
  useKanbanMessagesFeed: () => undefined,
}));
vi.mock("../parts", () => ({ Avatar: () => null, Glyph: () => null }));
vi.mock("./askStore", () => ({
  useAskScope: () => ui.scope.current,
  useAsks: () => (ui.scope.current as { asks: unknown }).asks,
  useLateStanding: () => () => "here",
  useOwnerStanding: () => ({ standing: "owner", recheck: () => undefined }),
  useWatchAsks: () => undefined,
}));
vi.mock("./nav", () => ({ useNeedsYouNav: () => ({}) }));
vi.mock("./Screen", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useBottomInset: () => 0,
}));
vi.mock("./ui", () => ({ OwnerBand: () => null, OfflineBand: () => null }));
vi.mock("./useQueue", () => ({ useQueue: () => ({}) }));

import { AskTalk } from "./AskDiscussionRouteScreen";
import { createAskScopes } from "./askScope";

/** A block of a kind only a newer server knows, with a payload this build must not keep or send. */
const FROM_LATER = { _tag: "map", zoom: 12, pins: [{ lat: 25.2, lng: 55.3, note: "PRIVATE-PIN" }] };

const wireMessage = (seq: number, blocks: ReadonlyArray<unknown>, author: unknown) => ({
  discussionId: "d1",
  seq,
  author,
  authorName: "Worker",
  blocks,
  answers: [],
  createdAt: "2026-11-11T08:00:00.000Z",
  askId: "q1",
});

/** The feed as the server sends it: the ask and an agent's message under it both carry the new block. */
const wireFeed = () => ({
  at: "2026-11-11T08:00:00.000Z",
  open: [
    {
      boardId: "b1",
      boardSlug: "robob",
      boardName: "Robob",
      cardId: "c1",
      cardNumber: 1,
      cardRef: "robob:1",
      cardTitle: "Card 1",
      stage: "needs_owner",
      priority: 3,
      discussionId: "d1",
      blocks: 0,
      ask: {
        id: "q1",
        text: "Ship it?",
        blocking: true,
        by: { _tag: "thread", threadId: "t1" },
        at: "2026-11-11T08:00:00.000Z",
        seq: 1,
        closedAt: null,
        kind: "approval",
        respond: { verdict: {} },
        blocks: [{ _tag: "md", text: "READ-ASK-BLOCK" }, FROM_LATER],
      },
      kind: "approval",
      revision: 0,
      waitsOn: "owner",
      expired: false,
      messages: [
        wireMessage(1, [{ _tag: "md", text: "READ-ASK-MESSAGE" }, FROM_LATER], {
          _tag: "thread",
          threadId: "t1",
        }),
        wireMessage(2, [{ _tag: "md", text: "READ-AGENT-MESSAGE" }, FROM_LATER], {
          _tag: "thread",
          threadId: "t1",
        }),
      ],
    },
  ],
  closed: [],
});

function server() {
  const writes: Array<{ readonly path: string; readonly body: string }> = [];
  const fetchFake = (async (url: string, init?: { method?: string; body?: unknown }) => {
    const path = String(url).replace(/^https:\/\/a\.test/, "");
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push({ path, body: String(init?.body ?? "") });
    const body = method === "GET" ? wireFeed() : { seq: 3 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  const scopes = createAskScopes({
    paired: () => "A",
    onPairedChange: () => () => undefined,
    target: () => ({
      base: "https://a.test",
      headers: { authorization: "Bearer token-A" },
      cookies: false,
    }),
    sendSecrets: async () => ({ _tag: "sent" }),
    watch: {
      onBoardsChange: () => () => undefined,
      onForeground: () => () => undefined,
      isForeground: () => true,
    },
    owner: () => true,
    defer: () => undefined,
    now: () => Date.now(),
    fetch: fetchFake,
  });
  return { scopes, writes };
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  root = createRoot(host);
  ui.inputs.clear();
  ui.presses.clear();
  ui.alerts.length = 0;
  ui.boardPost.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
});

const input = () => {
  const props = ui.inputs.get("Message");
  if (props?.onChangeText === undefined) throw new Error("The composer's field is not rendered");
  return props as { onChangeText: (text: string) => void; value?: string };
};
const sendButton = () => {
  const props = ui.presses.get("Send");
  if (props?.onPress === undefined) throw new Error("The composer's Send is not rendered");
  return props as { onPress: () => void; disabled?: boolean };
};

describe("a reply under an ask whose thread holds stand-ins", () => {
  it("sends what he typed and nothing that was read", async () => {
    const { scopes, writes } = server();
    const scope = scopes.current();
    ui.scope.current = scope;
    await scope.asks.refreshAsks();
    const entry = scope.cell.getState().feed!.open[0]!;

    // The feed was read through the schema: the unknown block is its stand-in, in the ask and the thread.
    const standIn = { _tag: "md", text: KANBAN_UNKNOWN_BLOCK_TEXT };
    expect(entry.ask.blocks).toEqual([{ _tag: "md", text: "READ-ASK-BLOCK" }, standIn]);
    expect(entry.messages[1]!.blocks).toEqual([
      { _tag: "md", text: "READ-AGENT-MESSAGE" },
      standIn,
    ]);
    expect(JSON.stringify(entry)).not.toContain("PRIVATE-PIN");

    act(() =>
      root.render(
        <AskTalk
          entry={entry}
          waiting={false}
          nowMs={Date.parse("2026-11-11T09:00:00.000Z")}
          bottomInset={0}
          onOpenCard={() => undefined}
        />,
      ),
    );
    // The thread on screen holds the agent's message and its stand-in.
    expect(host.textContent).toContain("READ-AGENT-MESSAGE");
    expect(host.textContent).toContain(KANBAN_UNKNOWN_BLOCK_TEXT);
    expect(sendButton().disabled).toBe(true);

    act(() => input().onChangeText("  his reply  "));
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      sendButton().onPress();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });

    // One write, to the ask's reply route on its own server, carrying one block: his words.
    expect(ui.alerts).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/api/ardud/kanban/cards/robob%3A1/asks/q1/reply");
    expect(JSON.parse(writes[0]!.body)).toEqual({ blocks: [{ _tag: "md", text: "his reply" }] });
    // Nothing that was read went back: no stand-in, no block of the ask or the thread.
    expect(writes[0]!.body).not.toContain(KANBAN_UNKNOWN_BLOCK_TEXT);
    expect(writes[0]!.body).not.toContain("READ-");
    expect(writes[0]!.body).not.toContain("PRIVATE-PIN");
    // And it did not go as a post on the card's discussion.
    expect(ui.boardPost).not.toHaveBeenCalled();
    // The field is empty again: the next reply starts from nothing too.
    expect(input().value).toBe("");
  });

  it("a second reply is built new as well, after the thread was read again", async () => {
    const { scopes, writes } = server();
    const scope = scopes.current();
    ui.scope.current = scope;
    await scope.asks.refreshAsks();
    const entry = scope.cell.getState().feed!.open[0]!;
    act(() =>
      root.render(
        <AskTalk
          entry={entry}
          waiting={false}
          nowMs={Date.parse("2026-11-11T09:00:00.000Z")}
          bottomInset={0}
          onOpenCard={() => undefined}
        />,
      ),
    );
    for (const words of ["first", "second"]) {
      act(() => input().onChangeText(words));
      await act(async () => {
        sendButton().onPress();
        await new Promise((done) => setTimeout(done, 0));
      });
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
    expect(writes.map((write) => JSON.parse(write.body))).toEqual([
      { blocks: [{ _tag: "md", text: "first" }] },
      { blocks: [{ _tag: "md", text: "second" }] },
    ]);
  });
});
