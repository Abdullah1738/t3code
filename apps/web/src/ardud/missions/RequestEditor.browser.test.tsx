import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { CompressImageFileResult } from "../../lib/imageCompression";

const harness = vi.hoisted(() => ({
  prepare: vi.fn<(file: File) => Promise<CompressImageFileResult>>(),
  warned: [] as string[],
  uploads: [] as string[],
}));

vi.mock(import("../../lib/imageCompression"), async (original) => ({
  ...(await original()),
  prepareImageForAttachment: (file: File) => harness.prepare(file),
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  releaseAttachmentUpload: () => undefined,
  startAttachmentUpload: (input: { image: { id: string } }) => harness.uploads.push(input.image.id),
  useAttachmentUploadStore: (select: (state: { uploadsByImageId: object }) => unknown) =>
    select({ uploadsByImageId: {} }),
}));
vi.mock("../../components/ui/toast", () => ({
  toastManager: { add: (toast: { title: string }) => harness.warned.push(toast.title) },
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "env" }));
vi.mock("../../components/ComposerPromptEditor", () => ({ ComposerPromptEditor: () => null }));
vi.mock("../../components/chat/ExpandedImageDialog", () => ({ ExpandedImageDialog: () => null }));
vi.mock("../../components/composerContextPresentation", () => ({
  ComposerContextActionsContext: null,
  composerContextRecordsFromDraft: () => [],
}));

import { useRequestDraft, type RequestDraft } from "./RequestEditor";

let root: Root;
const latest: { draft: RequestDraft | null } = { draft: null };

function Probe() {
  const value = useRequestDraft();
  useEffect(() => {
    latest.draft = value;
  });
  return null;
}

function draft(): RequestDraft {
  if (latest.draft === null) throw new Error("The box isn't mounted.");
  return latest.draft;
}

const photo = () => new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });

const read = (file: File): CompressImageFileResult => ({ ok: true, file, recompressed: false });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:photo");
  vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
  harness.prepare.mockImplementation(async (file) => read(file));
  harness.warned.length = 0;
  harness.uploads.length = 0;
  root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  latest.draft = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("takes an image in a box mounted under StrictMode", async () => {
  await act(() => draft().addFiles([photo()]));

  expect(draft().empty).toBe(false);
  expect(harness.uploads).toHaveLength(1);
});
