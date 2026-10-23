import { useState } from "react";

import {
  requestPlainText,
  type AssetResource,
  type EnvironmentId,
  type RequestTextPart,
} from "@t3tools/contracts";

import { useAssetUrls } from "../../assets/assetUrls";
import { ExpandedImageDialog } from "../../components/chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../../components/chat/ExpandedImagePreview";
import { ImageChipButton } from "../../components/contextChipParts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { requestTextView, type RequestImagePart as ImagePart } from "./requestTextView";

/**
 * A request message's words with its images as chips where the owner put
 * them; a chip opens the message's images full size at that one.
 */
export function RequestText(props: { text: string }) {
  const view = requestTextView(props.text);
  const environmentId = usePrimaryEnvironmentId();
  if (view.type === "text") return view.text;
  if (environmentId === null) return requestPlainText(props.text);
  return <TextWithImages parts={view.parts} images={view.images} environmentId={environmentId} />;
}

function TextWithImages(props: {
  parts: ReadonlyArray<RequestTextPart>;
  images: ReadonlyArray<ImagePart>;
  environmentId: EnvironmentId;
}) {
  const resources = props.images.map((image): AssetResource => ({
    _tag: "attachment",
    attachmentId: image.assetId,
  }));
  const urls = useAssetUrls(props.environmentId, resources);
  // The viewer keeps only which image is open, so a URL that resolves after
  // the click still reaches it.
  const [opened, setOpened] = useState<number | null>(null);
  const preview: ExpandedImagePreview | null =
    opened === null
      ? null
      : {
          images: props.images.map((image, index) => ({
            src: urls[index] ?? null,
            name: `Image ${image.index}`,
          })),
          index: opened,
        };
  let seen = 0;
  return (
    <>
      {props.parts.map((part, key) => {
        if (part.type === "text") return part.text;
        const at = seen++;
        return (
          <ImageChipButton
            // oxlint-disable-next-line react/no-array-index-key -- parts are positional; a repeated image is a separate chip
            key={key}
            name={`Image ${part.index}`}
            previewUrl={urls[at] ?? undefined}
            size=""
            aria-label={`Open image ${part.index}`}
            className="mx-0.5"
            onClick={() => setOpened(at)}
          />
        );
      })}
      {preview ? <ExpandedImageDialog preview={preview} onClose={() => setOpened(null)} /> : null}
    </>
  );
}
