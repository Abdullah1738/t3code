/**
 * The attachment screen while a file is still on its way: the address of a
 * file on the server, the text of one, a file on the phone. Each wait has a
 * time limit. At it the request is dropped, the screen says the file hasn't
 * loaded and offers "Try again"; what comes late is not shown. This drives the
 * real screen and the real `useAttachmentDocument` with those requests pending.
 */
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const ui = vi.hoisted(() => ({
  actions: new Map<string, () => void>(),
  /** The address requests made of the server, each answered by the test. */
  addresses: [] as Array<{ resolve: (url: string | null) => void }>,
  /** The reads of a file's text. */
  reads: [] as Array<{
    readonly url: string;
    readonly signal: AbortSignal;
    readonly resolve: (text: string) => void;
  }>,
  /** The loads of a file that is on the phone. */
  locals: [] as Array<{ readonly signal: AbortSignal }>,
  draft: [] as Array<unknown>,
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Platform: { OS: "ios" },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ canGoBack: () => false, goBack: () => undefined }),
}));
vi.mock("../../components/ui/Toolbar", () => ({
  Toolbar: Object.assign(() => null, { Menu: () => null, MenuAction: () => null }),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: () => undefined }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("@t3tools/client-runtime/state/attachments", () => ({ formatAttachmentSize: () => "" }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  settlePromise: async (run: () => Promise<unknown>) => ({ _tag: "Success", value: await run() }),
  squashAtomCommandFailure: (result: unknown) => result,
}));
vi.mock("@t3tools/client-runtime/file-preview", () => ({
  readFilePreviewResponse: async (response: { text: () => Promise<string> }) => ({
    text: await response.text(),
    truncated: false,
  }),
}));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({
  AndroidHeaderIconButton: () => null,
  AndroidScreenHeader: () => null,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: {
    readonly title: string;
    readonly detail: string;
    readonly actionLabel?: string;
    readonly onAction?: () => void;
  }) => {
    if (props.actionLabel !== undefined && props.onAction !== undefined) {
      ui.actions.set(props.actionLabel, props.onAction);
    }
    return (
      <section>
        <h2>{props.title}</h2>
        <p>{props.detail}</p>
        {props.actionLabel ? <button type="button">{props.actionLabel}</button> : null}
      </section>
    );
  },
}));
vi.mock("../../components/FilePreviewModal", () => ({
  FilePreviewModal: () => <aside>the system viewer</aside>,
}));
vi.mock("../../lib/attachmentDownload", () => ({
  nativeViewerErrorMessage: () => "",
  downloadAndShareAttachment: async () => undefined,
  shareLocalAttachment: async () => undefined,
}));
vi.mock("../../lib/composerImages", () => ({
  isFileBackedComposerAttachment: (attachment: { fileUri?: string }) =>
    attachment.fileUri !== undefined,
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: () => undefined }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../lib/localAttachmentPreview", () => ({
  loadLocalAttachmentPreview: (_attachment: unknown, signal: AbortSignal) => {
    ui.locals.push({ signal });
    return new Promise(() => undefined);
  },
}));
vi.mock("../../state/use-composer-drafts", () => ({
  useComposerDraft: () => ({ attachments: ui.draft }),
  removeComposerDraftAttachment: () => undefined,
}));
vi.mock("../../state/assets", () => {
  // One function for the life of the test, as the app's hook gives for one file.
  const renew = () =>
    new Promise<string | null>((resolve) => {
      ui.addresses.push({ resolve });
    });
  return { useRefreshAssetUrl: () => renew };
});
vi.mock("expo/fetch", () => ({
  fetch: (url: string, init: { readonly signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      ui.reads.push({
        url,
        signal: init.signal,
        resolve: (text) => resolve({ ok: true, text: async () => text }),
      });
    }),
}));
vi.mock("expo-file-system", () => ({ File: function File() {} }));
vi.mock("../../features/files/AudioFilePreview", () => ({ AudioFilePreview: () => null }));
vi.mock("../../features/files/FilePreviewFeedback", () => ({
  FilePreviewLoading: (props: { readonly message: string }) => <p>{props.message}</p>,
  FilePreviewNotice: () => null,
}));
vi.mock("../../features/files/FileMarkdownPreview", () => ({ FileMarkdownPreview: () => null }));
vi.mock("../../features/files/SourceFileSurface", () => ({
  SourceFileSurface: (props: { readonly contents: string }) => <pre>{props.contents}</pre>,
}));
vi.mock("../../features/files/WorkspaceFileWebPreview", () => ({
  WorkspaceFileWebPreview: () => null,
}));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    appearance: { codeWordBreak: false },
    setCodeWordBreak: () => undefined,
  }),
}));
vi.mock("../../features/threads/HtmlRenderWebView", () => ({ HtmlRenderWebView: () => null }));
vi.mock("./AttachmentVideoPreview", () => ({
  AttachmentVideoPreview: (props: { readonly uri: string }) => <video data-uri={props.uri} />,
}));

import {
  AttachmentFileScreen,
  type AttachmentFileRouteParams,
} from "../../features/files/AttachmentFileScreen";
import {
  FILE_ADDRESS_TIME_LIMIT_MS,
  FILE_LOAD_STALLED_TEXT,
  LOCAL_FILE_LOAD_STALLED_TEXT,
  fileViewerTimeLimitMs,
} from "./fileViewer";

const CLIP: AttachmentFileRouteParams = {
  environmentId: "A",
  attachmentId: "X",
  name: "clip.mp4",
  mimeType: "video/mp4",
  sizeBytes: String(68 * 1024),
};
const PDF: AttachmentFileRouteParams = {
  ...CLIP,
  name: "report.pdf",
  mimeType: "application/pdf",
};
const NOTES: AttachmentFileRouteParams = {
  ...CLIP,
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: "2048",
};

let root: Root;
let page: HTMLElement;

const open = async (params: AttachmentFileRouteParams) => {
  await act(async () => {
    root.render(<AttachmentFileScreen route={{ params } as never} />);
    await vi.advanceTimersByTimeAsync(0);
  });
};
const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const press = async (label: string) => {
  const run = ui.actions.get(label);
  if (run === undefined) throw new Error(`nothing to press: ${label}`);
  await act(async () => {
    run();
    await vi.advanceTimersByTimeAsync(0);
  });
};
const answer = async (at: number, url: string | null) => {
  await act(async () => {
    ui.addresses[at]!.resolve(url);
    await vi.advanceTimersByTimeAsync(0);
  });
};
const says = () => page.textContent ?? "";
const video = () => page.querySelector("video")?.getAttribute("data-uri") ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  ui.actions.clear();
  ui.addresses = [];
  ui.reads = [];
  ui.locals = [];
  ui.draft = [];
  page = document.createElement("div");
  document.body.append(page);
  root = createRoot(page);
});

afterEach(async () => {
  await act(async () => root.unmount());
  page.remove();
  vi.useRealTimers();
});

describe("a video whose address never comes", () => {
  it("is waited for a limited time, then says so and offers Try again", async () => {
    await open(CLIP);
    expect(ui.addresses).toHaveLength(1);
    expect(says()).toContain("Loading file...");

    await pass(FILE_ADDRESS_TIME_LIMIT_MS - 1);
    expect(says()).toContain("Loading file...");
    expect(ui.actions.has("Try again")).toBe(false);

    await pass(1);
    expect(says()).not.toContain("Loading file...");
    expect(says()).toContain("The file hasn't loaded");
    expect(says()).toContain(FILE_LOAD_STALLED_TEXT);
    expect(video()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the request is dropped: an address that comes late is not played", async () => {
    await open(CLIP);
    await pass(FILE_ADDRESS_TIME_LIMIT_MS);
    await answer(0, "https://a.example/late");
    expect(video()).toBeNull();
    expect(says()).toContain("The file hasn't loaded");
  });

  it("Try again asks anew, with a limit of its own, and plays what comes", async () => {
    await open(CLIP);
    await pass(FILE_ADDRESS_TIME_LIMIT_MS);
    await press("Try again");
    expect(ui.addresses).toHaveLength(2);
    expect(says()).toContain("Loading file...");

    // The second try stalls too, and ends the same way.
    await pass(FILE_ADDRESS_TIME_LIMIT_MS);
    expect(says()).toContain("The file hasn't loaded");

    await press("Try again");
    expect(ui.addresses).toHaveLength(3);
    await answer(2, "https://a.example/fresh");
    expect(video()).toBe("https://a.example/fresh");
    expect(says()).not.toContain("The file hasn't loaded");
    // Nothing waits any more: the limit ended with the answer.
    expect(vi.getTimerCount()).toBe(0);
    await pass(FILE_ADDRESS_TIME_LIMIT_MS * 3);
    expect(video()).toBe("https://a.example/fresh");
  });

  it("an address that comes in time is left alone", async () => {
    await open(CLIP);
    await pass(FILE_ADDRESS_TIME_LIMIT_MS - 1);
    await answer(0, "https://a.example/in-time");
    expect(video()).toBe("https://a.example/in-time");
    expect(vi.getTimerCount()).toBe(0);
    await pass(FILE_ADDRESS_TIME_LIMIT_MS * 3);
    expect(video()).toBe("https://a.example/in-time");
    expect(ui.actions.has("Try again")).toBe(false);
  });

  it("leaving the screen ends the wait", async () => {
    await open(CLIP);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(page);
  });
});

describe("the other files that wait the same way", () => {
  it("a PDF whose address never comes: one Try again, and then the viewer opens", async () => {
    await open(PDF);
    expect(says()).toContain("Opening in file viewer...");
    await pass(FILE_ADDRESS_TIME_LIMIT_MS);
    expect(says()).toContain("The file hasn't loaded");
    // The wait for the viewer did not run alongside: it is not said twice over.
    await pass(fileViewerTimeLimitMs(68 * 1024));
    expect(says()).not.toContain("The file hasn't opened");

    await press("Try again");
    await answer(1, "https://a.example/report");
    expect(says()).toContain("the system viewer");
    expect(says()).not.toContain("The file hasn't loaded");
    expect(says()).not.toContain("The file hasn't opened");
  });

  it("a text file whose contents never come: the read is stopped, and Try again reads anew", async () => {
    await open(NOTES);
    await answer(0, "https://a.example/notes");
    expect(ui.reads).toHaveLength(1);
    expect(says()).toContain("Loading file...");

    await pass(fileViewerTimeLimitMs(2048) - 1);
    expect(says()).toContain("Loading file...");
    await pass(1);
    expect(says()).toContain("The file hasn't loaded");
    expect(ui.reads[0]!.signal.aborted).toBe(true);

    await press("Try again");
    await answer(1, "https://a.example/notes-2");
    const again = ui.reads.at(-1)!;
    expect(again.url).toBe("https://a.example/notes-2");
    // Every read before it was stopped.
    expect(ui.reads.slice(0, -1).every((read) => read.signal.aborted)).toBe(true);
    await act(async () => {
      again.resolve("what the file says");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(says()).toContain("what the file says");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a file on the phone that never loads: the same, in words that fit", async () => {
    ui.draft = [{ id: "X", type: "file", name: "clip.mp4", fileUri: "file:///drafts/clip.mp4" }];
    await open({ ...CLIP, draftKey: "draft-1" });
    expect(ui.addresses).toHaveLength(0);
    expect(ui.locals).toHaveLength(1);
    await pass(fileViewerTimeLimitMs(68 * 1024));
    expect(says()).toContain("The file hasn't loaded");
    expect(says()).toContain(LOCAL_FILE_LOAD_STALLED_TEXT);
    expect(ui.locals[0]!.signal.aborted).toBe(true);
    await press("Try again");
    expect(ui.locals).toHaveLength(2);
  });
});
