import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { DraftComposerImageAttachment } from "../../lib/composerImages";

const harness = vi.hoisted(() => ({
  alerts: [] as Array<{ title: string; message: string }>,
  pick: null as null | ((images: ReadonlyArray<unknown>) => void),
  paste: null as null | ((images: ReadonlyArray<unknown>) => void),
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, message: string) => harness.alerts.push({ title, message }),
  },
}));
vi.mock("../../lib/attachmentUpload", () => ({
  prepareTurnAttachments: vi.fn(),
  releasePendingAttachmentUploads: vi.fn(async () => undefined),
}));
vi.mock("../../lib/composerImages", () => ({
  isComposerImageAttachment: () => true,
  convertPastedImagesToAttachments: () =>
    new Promise((resolve) => {
      harness.paste = resolve;
    }),
  pickComposerImages: () =>
    new Promise((resolve) => {
      harness.pick = (images) => resolve({ images, error: null });
    }),
}));
vi.mock("./missionsStore", () => ({ useMissionsEnvironmentId: () => "environment-1" }));

import { useRequestDraft, type RequestDraft } from "./requestDraft";

let root: Root | null = null;
let draft: RequestDraft | null = null;

function Probe() {
  const seen = useRequestDraft();
  useEffect(() => {
    draft = seen;
  });
  return null;
}

function current(): RequestDraft {
  if (!draft) throw new Error("not mounted");
  return draft;
}

function photo(id: string): DraftComposerImageAttachment {
  return {
    id,
    type: "image",
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 10,
    previewUri: `file:///${id}.png`,
    dataUrl: "data:image/png;base64,AA==",
  };
}

function deferred() {
  let resolve: (value: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.alerts.length = 0;
  harness.pick = null;
  harness.paste = null;
  root = createRoot(document.createElement("div"));
  act(() => root?.render(<Probe />));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  draft = null;
});

it("holds a words-only send busy and takes no photo until it went", async () => {
  act(() => current().setText("see the board"));
  const delivery = deferred();
  const texts: string[] = [];
  let sending: Promise<boolean> = Promise.resolve(false);
  act(() => {
    sending = current().send((text) => {
      texts.push(text);
      return delivery.promise;
    });
  });
  expect(current().busy).toBe(true);
  // A second tap before the first lands sends nothing.
  await act(async () => {
    expect(await current().send(async () => true)).toBe(false);
  });

  await act(() => current().attach());
  expect(harness.pick).toBeNull();
  expect(harness.alerts).toEqual([
    { title: "Not attached", message: "Wait for the message to send, then attach it." },
  ]);

  await act(async () => {
    delivery.resolve(true);
    expect(await sending).toBe(true);
  });
  expect(texts).toEqual(["see the board"]);
  expect(current().busy).toBe(false);
  expect(current().text).toBe("");
});

it("drops a photo still being picked when a message went meanwhile", async () => {
  act(() => current().setText("first"));
  let picking: Promise<void> = Promise.resolve();
  act(() => {
    picking = current().attach();
  });
  await act(() => current().send(async () => true));
  expect(current().text).toBe("");

  await act(async () => {
    harness.pick?.([photo("late")]);
    await picking;
  });
  expect(current().text).toBe("");
  expect(current().empty).toBe(true);
  expect(harness.alerts).toEqual([
    { title: "Not attached", message: "A message went while it was read. Attach it again." },
  ]);
});

it("refuses a paste that finishes reading as a settle note goes", async () => {
  act(() => current().setText("done here"));
  act(() => current().pasteImages(["file:///tmp/pasted.png"]));
  const settled = deferred();
  const notes: string[] = [];
  let settling: Promise<boolean> = Promise.resolve(false);
  act(() => {
    settling = current().sendNote((note) => {
      notes.push(note);
      return settled.promise;
    });
  });

  await act(async () => {
    settled.resolve(true);
    harness.paste?.([photo("pasted")]);
    expect(await settling).toBe(true);
  });
  expect(notes).toEqual(["done here"]);
  expect(current().empty).toBe(true);
  expect(harness.alerts).toEqual([
    { title: "Not attached", message: "A message went while it was read. Attach it again." },
  ]);
});

it("refuses a native paste from before a send that went in one go", async () => {
  act(() => current().setText("first"));
  const before = current().pasteEpoch;
  // Sent and cleared at once, so busy never shows and the editor never locks.
  await act(() => current().send(async () => true));
  expect(current().text).toBe("");

  act(() => current().pasteImages(["file:///tmp/old.png"], before));
  await act(async () => harness.paste?.([photo("old")]));
  expect(current().empty).toBe(true);
  expect(harness.alerts).toEqual([
    { title: "Not attached", message: "A message went while it was read. Attach it again." },
  ]);

  act(() => current().pasteImages(["file:///tmp/new.png"], current().pasteEpoch));
  await act(async () => harness.paste?.([photo("new")]));
  expect(current().context?.records).toHaveLength(1);
  expect(harness.alerts).toHaveLength(1);
});

it("chips a photo picked while nothing is sending", async () => {
  let picking: Promise<void> = Promise.resolve();
  act(() => {
    picking = current().attach();
  });
  await act(async () => {
    harness.pick?.([photo("kept")]);
    await picking;
  });
  expect(current().empty).toBe(false);
  expect(current().context?.records).toHaveLength(1);
  expect(harness.alerts).toEqual([]);
});
