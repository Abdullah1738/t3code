import { StackActions, useNavigation } from "@react-navigation/native";
import {
  viewMarkdownChunks,
  viewMarkdownFold,
  viewMarkdownPreview,
} from "@t3tools/client-runtime/ardud/common";
import { parseKanbanLink } from "@t3tools/client-runtime/ardud/kanban";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { useMemo, useState } from "react";
import { FlatList, Modal, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { markdownGapBefore } from "../../native/markdownSpacing";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { usePairedEnvironmentId } from "./environment";
import { LinkButton } from "./parts";

/** A board link resolves to the record it opens on the current board, or null when it isn't on that board. */
export type KanbanLinkTarget = {
  readonly kind: "card" | "discussion";
  readonly boardId: string;
  readonly id: string;
};
export type ResolveKanbanLink = (href: string) => KanbanLinkTarget | null;

/**
 * Thread links open the thread's screen and board links open the card or
 * discussion (after `before`, e.g. closing a reader); others open outside.
 * A board link that isn't on the current board stays inert.
 */
function useOpenMarkdownLink(before?: () => void, resolveKanbanLink?: ResolveKanbanLink) {
  const navigation = useNavigation();
  const environmentId = usePairedEnvironmentId();
  return (href: string) => {
    if (parseKanbanLink(href) !== null) {
      const target = resolveKanbanLink?.(href) ?? null;
      if (target === null) return;
      before?.();
      navigation.dispatch(StackActions.push("KanbanRecord", target));
      return;
    }
    const threadId = parseThreadLinkHref(href);
    if (threadId === null) return void tryOpenExternalUrl(href, "markdown-link");
    if (environmentId === null) return;
    before?.();
    navigation.navigate("Thread", { environmentId, threadId });
  };
}

/** The preview colours sit on the screen; the owner's bubble has its own, as in a thread. */
function useTextStyle(tone: "screen" | "user") {
  const styles = useMarkdownPreviewStyles();
  const theme = useUniwindTheme();
  if (tone === "screen") return styles.nativeTextStyle;
  const body = theme["--color-user-bubble-foreground"];
  return {
    ...styles.nativeTextStyle,
    color: body,
    strongColor: body,
    mutedColor: body,
    linkColor: body,
    inlineCodeColor: theme["--color-user-bubble-foreground-muted"],
    codeColor: theme["--color-md-user-code-text"],
    codeBackgroundColor: theme["--color-md-user-code-bg"],
    codeBlockBackgroundColor: theme["--color-md-user-fence-bg"],
    fileTextColor: body,
    skillTextColor: body,
    quoteMarkerColor: body,
    dividerColor: body,
  };
}

/** Markdown folded to `maxLines`; long text opens in a full-screen reader. */
export function MarkdownText(props: {
  readonly text: string;
  readonly maxLines: number | null;
  readonly tone?: "screen" | "user";
  readonly resolveKanbanLink?: ResolveKanbanLink;
}) {
  const textStyle = useTextStyle(props.tone ?? "screen");
  const [unfolded, setUnfolded] = useState(false);
  const [reading, setReading] = useState(false);
  const openMarkdownLink = useOpenMarkdownLink(undefined, props.resolveKanbanLink);
  const [height, setHeight] = useState<number | null>(null);
  const preview = useMemo(
    () =>
      props.maxLines === null
        ? { text: props.text, cut: false }
        : viewMarkdownPreview(props.text, props.maxLines),
    [props.text, props.maxLines],
  );
  if (props.text.trim() === "") return null;
  // The native markdown view can't clamp lines, so a capped block clips its height.
  const cap = props.maxLines === null ? null : props.maxLines * textStyle.lineHeight;
  const fold = viewMarkdownFold({
    chars: props.text.length,
    cut: preview.cut,
    contentHeight: height,
    capHeight: cap,
  });
  const open = unfolded && fold === "inline";
  return (
    <View>
      {/* Clips even when open: a document pulls its leading heading's margin
          up, and the native view must not catch touches above the block.
          "scroll", not "hidden": Yoga hands a non-scrolling parent's
          maxHeight down as the child's measure limit, so the text below
          would measure no taller than the cap and Show all never shows.
          It still clips, and nothing here scrolls. */}
      <View style={{ overflow: "scroll", maxHeight: cap === null || open ? undefined : cap }}>
        {/* Lays out at full height inside the clip, which is how overflow
            shows. Measured open too, so a width or text change refolds. */}
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <SelectableMarkdownText
            markdown={open ? props.text : preview.text}
            textStyle={textStyle}
            spacing="document"
            onLinkPress={openMarkdownLink}
          />
        </View>
      </View>
      {fold === "none" ? null : (
        <View className="items-start">
          <LinkButton
            label={open ? "Show less" : "Show all"}
            tone={props.tone}
            onPress={() => (fold === "reader" ? setReading(true) : setUnfolded(!open))}
          />
        </View>
      )}
      {reading ? (
        <MarkdownReader
          text={props.text}
          resolveKanbanLink={props.resolveKanbanLink}
          onClose={() => setReading(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * A long report in a screen of its own. It renders in pieces as they scroll
 * in, where one native view of the whole text would lay out every line first.
 */
function MarkdownReader(props: {
  readonly text: string;
  readonly resolveKanbanLink?: ResolveKanbanLink;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      visible
      animationType="slide"
      supportedOrientations={["portrait", "landscape"]}
      onRequestClose={props.onClose}
    >
      {/* Its own provider: the modal is a separate window whose insets follow
          rotation, where the board's would go stale. */}
      <SafeAreaProvider>
        <MarkdownReaderBody
          text={props.text}
          resolveKanbanLink={props.resolveKanbanLink}
          onClose={props.onClose}
        />
      </SafeAreaProvider>
    </Modal>
  );
}

function MarkdownReaderBody(props: {
  readonly text: string;
  readonly resolveKanbanLink?: ResolveKanbanLink;
  readonly onClose: () => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const openMarkdownLink = useOpenMarkdownLink(props.onClose, props.resolveKanbanLink);
  const insets = useSafeAreaInsets();
  const chunks = useMemo(() => viewMarkdownChunks(props.text), [props.text]);
  return (
    <View
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}
    >
      <View className="min-h-12 flex-row items-center justify-end px-4">
        <LinkButton label="Done" onPress={props.onClose} />
      </View>
      <FlatList
        data={chunks}
        keyExtractor={(_, index) => String(index)}
        initialNumToRender={2}
        windowSize={7}
        contentContainerStyle={{
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + 24,
        }}
        renderItem={({ item, index }) => (
          <View
            style={{
              paddingTop: index === 0 ? 4 : markdownGapBefore(item.text, item.continuesList),
            }}
          >
            <SelectableMarkdownText
              markdown={item.text}
              textStyle={styles.nativeTextStyle}
              spacing="document"
              onLinkPress={openMarkdownLink}
            />
          </View>
        )}
      />
    </View>
  );
}
