import { placeRequestImages, requestImageRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));

import { requestInline } from "./RequestText";

const asset = "mission-0f6c2a52-6a3e-4d8f-9b1e-1d2c3b4a5f60";

it("shows typed ref look-alikes in a text-only message as he typed them", () => {
  const typed = "See [image 1: /tmp/x.png] and [image 2\\: y]";
  const stored = placeRequestImages(typed, []);
  expect(stored).not.toBe(typed);

  expect(requestInline(stored, () => {})).toBe(typed);
});

it("keeps a real image as a chip between the unescaped words", () => {
  const stored = placeRequestImages("Like [image 9: no] {image1}", [
    requestImageRef(1, `/Users/o/.t3/userdata/attachments/${asset}.png`),
  ]);

  const parts = requestInline(stored, () => {}) as ReadonlyArray<unknown>;
  expect(parts).toHaveLength(2);
  expect(parts[0]).toBe("Like [image 9: no] ");
  expect(parts[1]).toMatchObject({ props: { accessibilityLabel: "Open image 1" } });
});
