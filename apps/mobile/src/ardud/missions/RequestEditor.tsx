import type { ReactNode } from "react";
import { View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { FilePreviewModal } from "../../components/FilePreviewModal";
import { ComposerAttachmentButton } from "../../features/threads/ComposerAttachmentButton";
import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";
import { FONT_FAMILIES } from "../../lib/fontFamilies";
import { ComposerEditor } from "../../native/T3ComposerEditor";
import type { RequestDraft } from "./requestDraft";

/**
 * The box for a request, a reply or a Discuss message: the thread composer's
 * editor, so attached images sit in the words as chips. Tapping a chip opens
 * the image; the plus picks from the photo library, and pasted images land
 * at the cursor too.
 */
export function RequestEditor(props: {
  readonly draft: RequestDraft;
  readonly placeholder: string;
  readonly autoFocus?: boolean | undefined;
  /** Buttons that sit under the box, after the attach button. */
  readonly children?: ReactNode;
}) {
  const { draft } = props;
  const { color: foreground } = useResolveClassNames("text-foreground");
  const bodyText = useScaledTextRole("body");
  return (
    <View className="gap-2">
      <View className="rounded-[18px] border border-border bg-card-alt px-3.5 py-2">
        <ComposerEditor
          multiline
          scrollEnabled
          // The buttons under the box send; Return on a hardware keyboard is a new line.
          enterBehavior="newline"
          value={draft.text}
          selection={draft.selection}
          context={draft.context}
          placeholder={props.placeholder}
          autoFocus={props.autoFocus}
          editable={!draft.uploading}
          singleLineCentered={false}
          contentInsetVertical={0}
          onChangeText={draft.setText}
          onSelectionChange={draft.setSelection}
          onPasteImages={draft.pasteImages}
          onContextPress={(reference) => draft.openChip(reference.source)}
          style={{ minHeight: 72, maxHeight: 160 }}
          textStyle={{
            ...bodyText,
            color: foreground,
            fontFamily: FONT_FAMILIES.regular,
          }}
        />
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <ComposerAttachmentButton
          disabled={draft.uploading}
          supportsFiles={false}
          onPickMedia={draft.attach}
          onPickFiles={async () => undefined}
        />
        {props.children}
      </View>
      <FilePreviewModal source={draft.preview} onRequestClose={draft.closePreview} />
    </View>
  );
}
