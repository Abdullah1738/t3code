import { placeRequestImages, requestImageRef } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { requestTextView } from "./requestTextView";

const asset = "mission-0f6c2a52-6a3e-4d8f-9b1e-1d2c3b4a5f60";

it("shows typed ref look-alikes in a text-only message as he typed them", () => {
  const typed = "See [image 1: /tmp/x.png] and [image 2\\: y]";
  const stored = placeRequestImages(typed, []);
  expect(stored).not.toBe(typed);

  expect(requestTextView(stored)).toEqual({ type: "text", text: typed });
});

it("keeps a message with a real image as parts with its chip", () => {
  const stored = placeRequestImages("Like [image 9: no] {image1}", [
    requestImageRef(1, `/Users/o/.t3/userdata/attachments/${asset}.png`),
  ]);

  const view = requestTextView(stored);
  expect(view.type).toBe("images");
  if (view.type !== "images") return;
  expect(view.images.map((image) => image.assetId)).toEqual([asset]);
  expect(view.parts[0]).toEqual({ type: "text", text: "Like [image 9: no] " });
});
