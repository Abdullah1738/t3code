import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import {
  attachmentVideoKey,
  fileViewerStall,
  fileViewerTimeLimitMs,
  systemViewerKind,
} from "./fileViewer";
import { attachmentVideoPreviewSource, mediaVideoThumbnailKey } from "../../lib/videoPreviewSource";

describe("which files go to the system's viewer", () => {
  it("video and audio are played in the app, never handed over", () => {
    expect(systemViewerKind("video")).toBeNull();
    expect(systemViewerKind("audio")).toBeNull();
  });

  it("text, markdown and pages are shown by the app too", () => {
    expect(systemViewerKind("text")).toBeNull();
    expect(systemViewerKind("markdown")).toBeNull();
    expect(systemViewerKind("html")).toBeNull();
  });

  it("pictures, PDFs and formats the app can't show are handed over", () => {
    expect(systemViewerKind("image")).toBe("image");
    expect(systemViewerKind("pdf")).toBe("pdf");
    expect(systemViewerKind("unsupported")).toBe("document");
  });
});

describe("when the wait for the viewer ends", () => {
  it("on iOS it is said, and a viewer that may be up is left alone", () => {
    expect(fileViewerStall("ios", "document")).toBe("say");
    expect(fileViewerStall("ios", "pdf")).toBe("say");
    expect(fileViewerStall("ios", "image")).toBe("say");
  });

  it("on Android the fetching sheet is taken down so the error can be read", () => {
    expect(fileViewerStall("android", "document")).toBe("closeAndSay");
  });

  it("the app's own picture and PDF sheets on Android are never closed under him", () => {
    expect(fileViewerStall("android", "pdf")).toBe("none");
    expect(fileViewerStall("android", "image")).toBe("none");
  });

  it("a file the app shows itself has nothing to wait for", () => {
    expect(fileViewerStall("ios", null)).toBe("none");
    expect(fileViewerStall("android", null)).toBe("none");
  });
});

describe("how long the system's viewer is waited for", () => {
  it("is never forever: twenty seconds for a small file or an unknown size", () => {
    expect(fileViewerTimeLimitMs(0)).toBe(20_000);
    expect(fileViewerTimeLimitMs(Number.NaN)).toBe(20_000);
    expect(fileViewerTimeLimitMs(-5)).toBe(20_000);
    // The clip from the smoke test: 68 KB.
    expect(fileViewerTimeLimitMs(68 * 1024)).toBeLessThan(21_000);
  });

  it("gives a large file longer, up to two minutes", () => {
    expect(fileViewerTimeLimitMs(10 * 1024 * 1024)).toBe(60_000);
    expect(fileViewerTimeLimitMs(500 * 1024 * 1024)).toBe(120_000);
    expect(fileViewerTimeLimitMs(Number.POSITIVE_INFINITY)).toBe(20_000);
  });
});

describe("what a video attachment's player and still frame are kept under", () => {
  const clip = { attachmentId: "X", name: "clip.mp4", mimeType: "video/mp4" };
  const A = EnvironmentId.make("A");
  const B = EnvironmentId.make("B");

  it("the same attachment id on two servers is two videos", () => {
    const onA = attachmentVideoKey({ ...clip, environmentId: A, localDraftKey: null });
    const onB = attachmentVideoKey({ ...clip, environmentId: B, localDraftKey: null });
    expect(onA).not.toBe(onB);
    expect(onA).toContain("A");
    expect(onB).toContain("B");
  });

  it("is the key the thread's tile uses for that attachment on that server", () => {
    const tile = attachmentVideoPreviewSource(A, {
      type: "file",
      id: "X",
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1,
    } as Parameters<typeof attachmentVideoPreviewSource>[1]);
    expect(attachmentVideoKey({ ...clip, environmentId: A, localDraftKey: null })).toBe(
      mediaVideoThumbnailKey(tile),
    );
  });

  it("a file still on the phone goes by its draft, never by a server's attachment", () => {
    const local = attachmentVideoKey({ ...clip, environmentId: A, localDraftKey: "draft-1" });
    expect(local).not.toBe(attachmentVideoKey({ ...clip, environmentId: A, localDraftKey: null }));
    expect(local).not.toBe(
      attachmentVideoKey({ ...clip, environmentId: A, localDraftKey: "draft-2" }),
    );
  });

  it("with no server at all it still has a key of its own", () => {
    const nowhere = attachmentVideoKey({ ...clip, environmentId: null, localDraftKey: null });
    expect(nowhere).not.toBe(
      attachmentVideoKey({ ...clip, environmentId: A, localDraftKey: null }),
    );
  });
});
