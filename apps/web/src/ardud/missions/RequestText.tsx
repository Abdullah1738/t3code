import { useState } from "react";

import {
  requestTextParts,
  type AssetResource,
  type EnvironmentId,
  type RequestTextPart,
} from "@t3tools/contracts";

import { useAssetUrls } from "../../assets/assetUrls";
import { ExpandedImageDialog } from "../../components/chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../../components/chat/ExpandedImagePreview";
import { ImageChipButton } from "../../components/contextChipParts";
import { usePrimaryEnvironmentId } from "../../state/environments";

type ImagePart = Extract<RequestTextPart, { type: "image" }>;

/**
 * A request message's words with its images as chips where the owner put
 * them; a chip opens the message's images full size at that one.
 */
export function RequestText(props: { text: string }) {
  const parts = requestTextParts(props.text);
  const environmentId = usePrimaryEnvironmentId();
  const images = parts.filter((part): part is ImagePart => part.type === "image");
  if (images.length === 0 || environmentId === null) return props.text;
  return <TextWithImages parts={parts} images={images} environmentId={environmentId} />;
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
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const open = (at: number) =>
    setPreview({
      images: props.images.map((image, index) => ({
        src: urls[index] ?? null,
        name: `Image ${image.index}`,
      })),
      index: at,
    });
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
            onClick={() => open(at)}
          />
        );
      })}
      {preview ? <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} /> : null}
    </>
  );
}
