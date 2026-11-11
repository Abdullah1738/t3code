/**
 * What an ask shows beside its question: text, folded detail, pictures, files,
 * a card, a page. Pictures open full size in the app's viewer (pinch to zoom,
 * swipe between them); any other file opens on the attachment screen, which
 * plays video and audio and previews PDFs and documents the way the system
 * does. A part this build does not know is left out, never a crash.
 */
import { useNavigation } from "@react-navigation/native";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type { EnvironmentId, KanbanAskBlock, KanbanOwnerAsk } from "@t3tools/contracts";
import {
  clampHtmlRenderHeight,
  htmlRenderThemeMessage,
  injectHtmlRenderBootstrap,
} from "@t3tools/shared/htmlRender";
import { Image } from "expo-image";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";

import { FilePreviewModal } from "../../../components/FilePreviewModal";
import type { FilePreviewItem } from "../../../components/FilePreviewModal.types";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { useAppearancePreferences } from "../../../features/settings/appearance/AppearancePreferencesProvider";
import { mobileHtmlRenderTheme } from "../../../lib/htmlRenderTheme";
import { useAssetUrl } from "../../../state/assets";
import { MarkdownText } from "../../common/MarkdownText";
import { PageLinkOffer } from "../../common/PageLinkOffer";
import { pageNavigation } from "../../common/pageNavigation";
import { CardBlock, Collapse, resolveKanbanLinkFor } from "../Chat";
import {
  ASK_HTML_BRIDGE,
  askFileKind,
  askShown,
  readAskHtmlMessage,
  type AskFileKind,
  type AskPicture,
  type AskShown,
} from "./logic";
import { useAskEnvironmentId } from "./askStore";

const INLINE_MAX_HEIGHT = 520;

export interface AskMedia extends AskShown {
  /** The pictures as the viewer takes them; empty until the server is known. */
  readonly gallery: ReadonlyArray<FilePreviewItem>;
}

const previewItem = (picture: AskPicture, environmentId: EnvironmentId): FilePreviewItem =>
  picture.source._tag === "url"
    ? { kind: "image", uri: picture.source.url, name: picture.name }
    : {
        kind: "image",
        name: picture.name,
        mimeType: picture.source.attachment.mimeType,
        environmentId,
        resource: {
          _tag: "attachment",
          attachmentId: picture.source.attachment.id,
          fileName: picture.source.attachment.name,
          mimeType: picture.source.attachment.mimeType,
        },
      };

/** The pictures of an ask, gathered once for the reader and its viewer. */
export function useAskMedia(ask: Pick<KanbanOwnerAsk, "blocks">): AskMedia {
  const environmentId = useAskEnvironmentId();
  const shown = askShown(ask.blocks ?? []);
  return {
    ...shown,
    gallery:
      environmentId === null
        ? []
        : shown.pictures.map((picture) => previewItem(picture, environmentId)),
  };
}

/** The full-size viewer over an ask's pictures. */
export function AskMediaViewer(props: {
  readonly media: AskMedia;
  readonly viewing: number | null;
  readonly onClose: () => void;
}) {
  const item = props.viewing === null ? undefined : props.media.gallery[props.viewing];
  return (
    <FilePreviewModal
      source={item ? { ...item, gallery: props.media.gallery } : null}
      onRequestClose={props.onClose}
    />
  );
}

/** One picture of the ask, drawn in place; tapping it opens it full size. */
export function BlockPicture(props: {
  readonly media: AskMedia;
  /** Index of its block in the ask. */
  readonly index: number;
  readonly onOpen: (at: number) => void;
  /** Inside an option: no caption, a fixed short frame. */
  readonly bare?: boolean;
}) {
  const at = props.media.pictureOf.get(props.index);
  const picture = at === undefined ? undefined : props.media.pictures[at];
  if (at === undefined || picture === undefined) return null;
  return (
    <View className="gap-1.5">
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`${picture.caption ?? picture.name}, open full size`}
        onPress={() => props.onOpen(at)}
        className="overflow-hidden rounded-2xl bg-card"
        style={props.bare ? { height: 150 } : { aspectRatio: 4 / 3 }}
      >
        <PictureImage picture={picture} />
      </Pressable>
      {!props.bare && picture.caption ? (
        <Text className="text-sm text-foreground-muted">{picture.caption}</Text>
      ) : null}
    </View>
  );
}

function PictureImage(props: { readonly picture: AskPicture }) {
  const { source } = props.picture;
  const environmentId = useAskEnvironmentId();
  const stored = useAssetUrl(
    source._tag === "attachment" ? environmentId : null,
    source._tag === "attachment"
      ? {
          _tag: "attachment",
          attachmentId: source.attachment.id,
          fileName: source.attachment.name,
          mimeType: source.attachment.mimeType,
        }
      : null,
  );
  const uri = source._tag === "url" ? source.url : stored;
  if (uri === null) return null;
  return (
    <Image
      source={{ uri }}
      cachePolicy="memory-disk"
      contentFit="contain"
      style={{ width: "100%", height: "100%" }}
      accessibilityIgnoresInvertColors
    />
  );
}

const FILE_SYMBOLS: Partial<Record<AskFileKind, AppSymbolName>> = {
  video: "play",
  audio: "play",
  pdf: "doc.text",
};

const FILE_WORDS: Partial<Record<AskFileKind, string>> = {
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
};

/** A file of the ask that is not a picture: a row that opens it. */
function FileRow(props: {
  readonly attachment: Extract<KanbanAskBlock, { _tag: "attachment" }>["attachment"];
  readonly caption: string | null;
}) {
  const { attachment } = props;
  const navigation = useNavigation();
  const environmentId = useAskEnvironmentId();
  const kind = askFileKind(attachment);
  const size = formatAttachmentSize(attachment.sizeBytes);
  const what = FILE_WORDS[kind];
  if (environmentId === null) return null;
  return (
    <View className="gap-1.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${attachment.name}`}
        accessibilityValue={{ text: [what, size].filter(Boolean).join(", ") }}
        onPress={() =>
          navigation.navigate("ThreadAttachment", {
            environmentId: String(environmentId),
            attachmentId: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: String(attachment.sizeBytes),
          })
        }
        className="min-h-14 flex-row items-center gap-3 rounded-2xl bg-card px-3.5 py-2.5 active:bg-card-alt"
      >
        <View className="size-9 items-center justify-center rounded-full bg-screen">
          <SymbolView
            name={FILE_SYMBOLS[kind] ?? "doc"}
            size={15}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base font-t3-medium text-foreground">
            {attachment.name}
          </Text>
          <Text className="text-2xs text-foreground-muted">
            {[what, size].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
      {props.caption ? (
        <Text className="text-sm text-foreground-muted">{props.caption}</Text>
      ) : null}
    </View>
  );
}

function useAskHtmlTheme() {
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  return mobileHtmlRenderTheme({
    themeId,
    appearance: themeAppearance,
    variables: themeVariables,
    systemColors: systemColorsActive,
    platform: Platform.OS,
  });
}

/**
 * A page inside an ask. It is text an agent wrote, so it is not trusted.
 *
 * What it cannot reach: it is loaded from a string with no base address, so it
 * has no origin of the server's; the WebView is private (`incognito`, no
 * shared or third-party cookies, no cache, no storage) so it holds no cookie
 * of the app's, and the app's session is a token in the app's own memory that
 * is never given to a WebView; files are off. The only way it can talk to the
 * app is `postMessage`, and the app reads two things from that and nothing
 * else: how tall the page is, and a value for a custom field. The app tells it
 * the colours of the theme and nothing more.
 *
 * Where it can go: nowhere by itself (`pageNavigation`). It can never move the
 * app or open another one, and a web link it follows is only offered under the
 * page, to be opened by his own tap.
 */
export function AskHtml(props: {
  readonly html: string;
  readonly title: string | null;
  readonly height: number | null;
  /** Called when the page posts a value for a custom field. */
  readonly onValue?: ((value: unknown) => void) | undefined;
  /**
   * The answer can't be changed now (not his device, expired, handed over,
   * sending): the page still shows, but it takes no touches and a value it
   * posts is ignored.
   */
  readonly disabled?: boolean | undefined;
}) {
  const title = props.title ?? "Page";
  const theme = useAskHtmlTheme();
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  // A web link the page tried to follow, waiting for his tap.
  const [offered, setOffered] = useState<string | null>(null);
  const disabled = props.disabled === true;
  const height = Math.min(
    INLINE_MAX_HEIGHT,
    clampHtmlRenderHeight(contentHeight ?? props.height ?? 320),
  );
  const onMessage = (event: WebViewMessageEvent) => {
    const message = readAskHtmlMessage(event.nativeEvent.data);
    if (message === null) return;
    if (message._tag === "height") setContentHeight(message.height);
    else if (!disabled) props.onValue?.(message.value);
  };
  // Every navigation of the page and of its frames is asked about here. The
  // origin whitelist stays "*" on purpose: a URL outside the whitelist is
  // opened by the WebView library itself, with no question asked.
  const onNavigate = (request: WebViewNavigation & { isTopFrame?: boolean }) => {
    const verdict = pageNavigation(request);
    // He can't touch a disabled page, so a link it follows is its own doing.
    if (verdict._tag === "offer" && !disabled) setOffered(verdict.url);
    return verdict._tag === "load";
  };
  // The page takes the app's colours as it loads, and again when they change.
  const themeScript = `window.postMessage(${JSON.stringify(htmlRenderThemeMessage(theme))}, "*"); true;`;
  const webView = useRef<WebView<object>>(null);
  useEffect(() => {
    webView.current?.injectJavaScript(themeScript);
  }, [themeScript]);
  return (
    <View className="overflow-hidden rounded-2xl bg-card">
      <View className="min-h-11 flex-row items-center gap-2 px-3.5">
        <Text numberOfLines={1} className="min-w-0 flex-1 text-sm font-t3-medium text-foreground">
          {title}
        </Text>
      </View>
      {failed ? (
        <Text className="px-3.5 pb-3.5 text-sm text-foreground-muted">
          This page couldn't be shown here.
        </Text>
      ) : (
        <View
          style={{ height, pointerEvents: disabled ? "none" : "auto" }}
          accessibilityElementsHidden={disabled}
          importantForAccessibility={disabled ? "no-hide-descendants" : "auto"}
          className={disabled ? "opacity-60" : undefined}
        >
          <WebView<object>
            ref={webView}
            source={{ html: injectHtmlRenderBootstrap(props.html) }}
            accessibilityLabel={title}
            originWhitelist={["*"]}
            injectedJavaScriptBeforeContentLoaded={ASK_HTML_BRIDGE}
            injectedJavaScript={themeScript}
            onMessage={onMessage}
            onShouldStartLoadWithRequest={onNavigate}
            // A new window is a navigation like any other: offered, never opened.
            onOpenWindow={(event) => {
              const verdict = pageNavigation({ url: event.nativeEvent.targetUrl });
              if (verdict._tag === "offer" && !disabled) setOffered(verdict.url);
            }}
            onError={() => setFailed(true)}
            setSupportMultipleWindows={false}
            javaScriptCanOpenWindowsAutomatically={false}
            allowsLinkPreview={false}
            dataDetectorTypes="none"
            incognito
            cacheEnabled={false}
            domStorageEnabled={false}
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            geolocationEnabled={false}
            mediaPlaybackRequiresUserAction
            nestedScrollEnabled
            style={{ backgroundColor: "transparent" }}
          />
        </View>
      )}
      {offered !== null && !disabled ? (
        <PageLinkOffer url={offered} onDone={() => setOffered(null)} />
      ) : null}
    </View>
  );
}

/** A big block the feed sent as a stub, while the ask is read whole. */
function Stub(props: { readonly title: string | null }) {
  return (
    <View
      accessibilityLabel={props.title ? `${props.title}, loading` : "Loading"}
      className="h-24 justify-end rounded-2xl bg-card p-3.5"
    >
      {props.title ? (
        <Text className="text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
      ) : null}
    </View>
  );
}

// oxlint-disable react/no-array-index-key -- An ask's blocks never reorder.
/** Every block of the ask in order, but the ones a field or an option already draws. */
export function AskBlocks(props: {
  readonly boardId: string;
  readonly ask: KanbanOwnerAsk;
  readonly media: AskMedia;
  /** Blocks drawn elsewhere: inside a custom field, inside an option. */
  readonly skip: ReadonlySet<number>;
  readonly onOpenMedia: (at: number) => void;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const blocks = props.ask.blocks ?? [];
  const resolveKanbanLink = resolveKanbanLinkFor(props.boardId);
  const parts: Array<ReactNode> = [];
  blocks.forEach((block, index) => {
    if (props.skip.has(index) || props.media.captions.has(index)) return;
    const caption = (): string | null => {
      const next = blocks[index + 1];
      return props.media.captions.has(index + 1) && next?._tag === "md" ? next.text : null;
    };
    switch (block._tag) {
      case "md":
        parts.push(
          block.truncated ? (
            <Stub key={index} title={null} />
          ) : (
            <MarkdownText
              key={index}
              text={block.text}
              maxLines={null}
              resolveKanbanLink={resolveKanbanLink}
            />
          ),
        );
        return;
      case "collapse":
        parts.push(
          block.truncated ? (
            <Stub key={index} title={block.title} />
          ) : (
            <View key={index} className="rounded-2xl bg-card p-1">
              <Collapse
                title={block.title}
                text={block.text}
                resolveKanbanLink={resolveKanbanLink}
              />
            </View>
          ),
        );
        return;
      case "html":
        parts.push(
          block.truncated ? (
            <Stub key={index} title={block.title} />
          ) : (
            <AskHtml key={index} html={block.html} title={block.title} height={block.height} />
          ),
        );
        return;
      case "card":
        parts.push(
          <View key={index} className="rounded-2xl bg-card p-1">
            <CardBlock
              boardId={props.boardId}
              cardId={block.cardId}
              onOpenCard={props.onOpenCard}
            />
          </View>,
        );
        return;
      case "image":
        parts.push(
          props.media.pictureOf.has(index) ? (
            <BlockPicture
              key={index}
              media={props.media}
              index={index}
              onOpen={props.onOpenMedia}
            />
          ) : (
            <Text key={index} className="text-sm text-foreground-muted">
              {block.alt ?? "Picture"}
            </Text>
          ),
        );
        return;
      case "attachment":
        parts.push(
          props.media.pictureOf.has(index) ? (
            <BlockPicture
              key={index}
              media={props.media}
              index={index}
              onOpen={props.onOpenMedia}
            />
          ) : (
            <FileRow key={index} attachment={block.attachment} caption={caption()} />
          ),
        );
        return;
      default:
        // A part a newer server sends that this build has no drawing for.
        return;
    }
  });
  if (parts.length === 0) return null;
  return <View className="gap-3">{parts}</View>;
}
