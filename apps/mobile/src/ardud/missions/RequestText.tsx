import { requestPlainText, requestTextParts, type EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import type { FilePreviewItem, FilePreviewSource } from "../../components/FilePreviewModal.types";
import { AppText as Text } from "../../components/ui/AppText";

/**
 * A request message's words with each image as a tappable chip where he put
 * it. `onOpen` gets the image's place among the message's images.
 */
export function requestInline(text: string, onOpen: (position: number) => void): ReactNode {
  const parts = requestTextParts(text);
  // Stored words keep typed ref look-alikes escaped; plain text reads them back.
  if (!parts.some((part) => part.type === "image")) return requestPlainText(text);
  let position = 0;
  return parts.map((part, at) => {
    if (part.type === "text") return part.text;
    const opens = position;
    position += 1;
    return (
      <Text
        // oxlint-disable-next-line react/no-array-index-key -- parts are a fixed split of one message
        key={at}
        accessibilityRole="button"
        accessibilityLabel={`Open image ${part.index}`}
        onPress={() => onOpen(opens)}
        className="font-t3-medium text-primary-text"
      >
        {`Image ${part.index}`}
      </Text>
    );
  });
}

/** The full-size viewer for one of a message's images, the others a swipe away. */
export function requestImagePreview(
  text: string,
  environmentId: EnvironmentId,
  position: number,
): FilePreviewSource | null {
  const gallery = requestTextParts(text).flatMap((part): FilePreviewItem[] =>
    part.type === "image"
      ? [
          {
            kind: "image",
            name: `Image ${part.index}`,
            environmentId,
            resource: { _tag: "attachment", attachmentId: part.assetId },
          },
        ]
      : [],
  );
  const opened = gallery[position];
  return opened ? { ...opened, gallery } : null;
}
