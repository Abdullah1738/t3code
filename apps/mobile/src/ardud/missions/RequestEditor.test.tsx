import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import type { ComposerEditorProps } from "../../native/T3ComposerEditor.types";

const editors = vi.hoisted(() => [] as ComposerEditorProps[]);

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({ color: "black" }) }));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../features/threads/ComposerAttachmentButton", () => ({
  ComposerAttachmentButton: () => null,
}));
vi.mock("../../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({ fontSize: 16, lineHeight: 22 }),
}));
vi.mock("../../native/T3ComposerEditor", () => ({
  ComposerEditor: (props: ComposerEditorProps) => {
    editors.push(props);
    return null;
  },
}));

import { RequestEditor } from "./RequestEditor";
import type { RequestDraft } from "./requestDraft";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  editors.length = 0;
  vi.unstubAllGlobals();
});

it("keeps Return on a hardware keyboard as a new line, since only the buttons send", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const draft = {
    text: "",
    selection: { start: 0, end: 0 },
    context: [],
    uploading: false,
    preview: null,
  } as unknown as RequestDraft;
  root = createRoot(document.createElement("div"));
  act(() => root?.render(<RequestEditor draft={draft} placeholder="Reply" />));

  const editor = editors.at(-1);
  expect(editor?.onSubmit).toBeUndefined();
  expect(editor?.enterBehavior).toBe("newline");
});
