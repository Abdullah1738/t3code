import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { placeRequestImages, requestImageRef } from "@t3tools/contracts";

import type { ExpandedImagePreview } from "../../components/chat/ExpandedImagePreview";

const harness = vi.hoisted(() => ({
  urls: [] as Array<string | null>,
  previews: [] as Array<ExpandedImagePreview>,
}));

vi.mock("../../assets/assetUrls", () => ({ useAssetUrls: () => harness.urls }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "env" }));
vi.mock("../../components/contextChipParts", () => ({
  ImageChipButton: (props: { "aria-label": string; onClick: () => void }) => (
    <button type="button" aria-label={props["aria-label"]} onClick={props.onClick} />
  ),
}));
vi.mock("../../components/chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: (props: { preview: ExpandedImagePreview }) => {
    harness.previews.push(props.preview);
    return null;
  },
}));

import { RequestText } from "./RequestText";

const asset = "mission-0f6c2a52-6a3e-4d8f-9b1e-1d2c3b4a5f60";
const text = placeRequestImages("Like this {image1}", [
  requestImageRef(1, `/Users/o/.t3/userdata/attachments/${asset}.png`),
]);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.urls = [null];
  harness.previews.length = 0;
  host = document.createElement("div");
  root = createRoot(host);
  act(() => root.render(<RequestText text={text} />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("shows an image opened before its URL came once the URL comes", () => {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Open image 1"]')!.click());
  expect(harness.previews.at(-1)?.images[0]?.src).toBeNull();

  harness.urls = ["https://box.test/a.png"];
  act(() => root.render(<RequestText text={text} />));

  expect(harness.previews.at(-1)).toMatchObject({
    images: [{ src: "https://box.test/a.png", name: "Image 1" }],
    index: 0,
  });
});
