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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

it("takes no image while a message is sending", async () => {
  act(() => draft().onChange("on its way", 10));
  const delivery = deferred<boolean>();
  let sent: Promise<boolean> | undefined;
  act(() => {
    sent = draft().send(() => delivery.promise);
  });

  await act(() => draft().addFiles([photo()]));
  expect(harness.uploads).toHaveLength(0);
  expect(harness.warned).toContain("Not attached");

  await act(async () => {
    delivery.resolve(true);
    await sent;
  });
  expect(draft().empty).toBe(true);
});

it("drops an image still being read when the message it was meant for went", async () => {
  act(() => draft().onChange("look at this", 12));
  const reading = deferred<CompressImageFileResult>();
  harness.prepare.mockImplementation(() => reading.promise);
  let attached: Promise<void> | undefined;
  act(() => {
    attached = draft().addFiles([photo()]);
  });

  await act(() => draft().send(async () => true));
  expect(draft().empty).toBe(true);

  await act(async () => {
    reading.resolve(read(photo()));
    await attached;
  });
  expect(draft().empty).toBe(true);
  expect(harness.uploads).toHaveLength(0);
  expect(harness.warned).toContain("Not attached");
});

it("drops an image that finishes reading as the message or note goes", async () => {
  // The read can land a few ticks either side of delivery; none of them may
  // chip and upload an image the clear then wipes.
  // Gap 0 resolves both in one turn, which is where the old clear-after-
  // release order let the image through.
  const settle = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
  };

  const orders = (["read", "deliver"] as const).flatMap((first) =>
    [0, 1, 2, 3, 4].map((gap) => ({ first, gap })),
  );
  for (const go of ["send", "note"] as const) {
    for (const order of orders) {
      harness.warned.length = 0;
      harness.uploads.length = 0;
      act(() => draft().onChange("on its way", 10));
      const reading = deferred<CompressImageFileResult>();
      harness.prepare.mockImplementation(() => reading.promise);
      let attached: Promise<void> | undefined;
      act(() => {
        attached = draft().addFiles([photo()]);
      });
      const delivery = deferred<boolean>();
      let went: Promise<boolean> | undefined;
      act(() => {
        went =
          go === "send"
            ? draft().send(() => delivery.promise)
            : draft().run(() => delivery.promise, true);
      });

      await act(async () => {
        const [first, second] =
          order.first === "read"
            ? [() => reading.resolve(read(photo())), () => delivery.resolve(true)]
            : [() => delivery.resolve(true), () => reading.resolve(read(photo()))];
        first();
        if (order.gap > 0) await settle(order.gap);
        second();
        await went;
        await attached;
      });
      const after = { uploads: harness.uploads.length, empty: draft().empty };
      expect({ go, ...order, ...after }).toEqual({ go, ...order, uploads: 0, empty: true });
    }
  }
});
