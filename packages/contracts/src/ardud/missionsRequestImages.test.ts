import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { OpenOwnerRequestInput, ReplyOwnerRequestInput } from "./missions.ts";
import {
  placeRequestImages,
  requestImageMarker,
  requestImageRef,
  requestPlainText,
  requestTextParts,
} from "./missionsRequestImages.ts";

const assetA = "mission-0f6c2a52-6a3e-4d8f-9b1e-1d2c3b4a5f60";
const assetB = "mission-9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const pathA = `/Users/o/.t3/userdata/attachments/${assetA}.png`;
const pathB = `/Users/o/.t3/userdata/attachments/${assetB}.jpg`;
const decodeOpen = Schema.decodeUnknownSync(OpenOwnerRequestInput);
const decodeReply = Schema.decodeUnknownSync(ReplyOwnerRequestInput);

describe("request image inputs", () => {
  it("decodes images on open and reply, in order", () => {
    const open = decodeOpen({
      missionId: "mission-1",
      text: "Compare {image1} with {image2}",
      images: [
        { _tag: "attachment", attachmentId: "att-1" },
        { _tag: "file", path: "/tmp/b.png" },
      ],
    });
    expect(open.images?.map((image) => image._tag)).toEqual(["attachment", "file"]);
    const reply = decodeReply({
      requestId: "request-1",
      text: "this one",
      images: [{ _tag: "file", path: "/tmp/c.png" }],
    });
    expect(reply.images).toHaveLength(1);
  });

  it("refuses an empty list and unknown sources", () => {
    const decode = decodeOpen;
    expect(() => decode({ missionId: "mission-1", text: "x", images: [] })).toThrow();
    expect(() =>
      decode({ missionId: "mission-1", text: "x", images: [{ _tag: "url", url: "https://x" }] }),
    ).toThrow();
    expect(() =>
      decode({
        missionId: "mission-1",
        text: "x",
        images: Array.from({ length: 13 }, () => ({ _tag: "file", path: "/tmp/a.png" })),
      }),
    ).toThrow();
  });
});

describe("placeRequestImages", () => {
  it("puts each ref at its marker", () => {
    const text = `Left ${requestImageMarker(2)} is old, right ${requestImageMarker(1)} is new`;
    expect(placeRequestImages(text, [requestImageRef(1, pathA), requestImageRef(2, pathB)])).toBe(
      `Left [image 2: ${pathB}] is old, right [image 1: ${pathA}] is new`,
    );
  });

  it("appends refs without a marker and leaves stray markers alone", () => {
    expect(placeRequestImages("See {image1} and {image3}", ["[A]", "[B]"])).toBe(
      "See [A] and {image3}\n\n[B]",
    );
    expect(placeRequestImages("", ["[A]", "[B]"])).toBe("[A]\n[B]");
  });

  it("keeps an image at every place he referred to it", () => {
    expect(placeRequestImages("{image1} then {image1}", ["[A]"])).toBe("[A] then [A]");
  });
});

describe("requestTextParts", () => {
  it("splits stored text into text and images in place", () => {
    const text = placeRequestImages("Here {image1} and there {image2}.", [
      requestImageRef(1, pathA),
      requestImageRef(2, pathB),
    ]);
    expect(requestTextParts(text)).toEqual([
      { type: "text", text: "Here " },
      { type: "image", index: 1, assetId: assetA, path: pathA },
      { type: "text", text: " and there " },
      { type: "image", index: 2, assetId: assetB, path: pathB },
      { type: "text", text: "." },
    ]);
    expect(requestPlainText(text)).toBe("Here [image 1] and there [image 2].");
  });

  it("keeps refs that are not mission assets as text", () => {
    const text = "see [image 1: /tmp/not-an-asset.png]";
    expect(requestTextParts(text)).toEqual([{ type: "text", text }]);
  });
});
