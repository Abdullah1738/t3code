import { useIsFocused } from "@react-navigation/native";
import type { KanbanBlock, KanbanMessage, KanbanParticipant } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  avatarOf,
  canSendChoice,
  cardView,
  discussionPresence,
  ownerReadSeq,
  type KanbanBoardState,
} from "@t3tools/client-runtime/ardud/kanban";
import { clockLabel } from "@t3tools/client-runtime/ardud/common";
import { Image } from "expo-image";
import {
  type ComponentRef,
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pressable, ScrollView, View } from "react-native";
import { WebView, type WebViewNavigation } from "react-native-webview";

import { FilePreviewModal } from "../../components/FilePreviewModal";
import type { FilePreviewSource } from "../../components/FilePreviewModal.types";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { FeedError, LoadingLine } from "../common/FeedError";
import { useBoardAction } from "../common/hooks";
import { MarkdownText } from "../common/MarkdownText";
import { kanbanClient, useKanbanMessages, useKanbanMessagesFeed } from "./kanbanStore";
import {
  cardGlyph,
  choiceView,
  firstSendText,
  groupBlockRuns,
  isLoadableImageUrl,
  nextTypingExpiry,
  sendBlocks,
  toggleChoice,
  type StoredAttachment,
} from "./logic";
import { usePairedEnvironmentId } from "../common/environment";
import { ComposerAttachmentButton } from "../../features/threads/ComposerAttachmentButton";
import { pickComposerFiles, pickComposerMedia, type DraftComposerAttachment } from "../../lib/composerImages";
import {
  prepareTurnAttachments,
  releasePendingAttachmentUploads,
} from "../../lib/attachmentUpload";
import { useServerConfigs } from "../../state/entities";
import { useAssetUrl } from "../../state/assets";
import * as Dialog from "../../components/ui/Dialog";
import { Avatar, Glyph } from "./parts";

// Agent posts fold past this many lines and open in place or in a reader.
const MESSAGE_LINES = 24;
const HTML_DEFAULT_HEIGHT = 240;
const HTML_MAX_HEIGHT = 480;
// How close to the end counts as reading the newest message.
const FOLLOW_SLACK = 80;
/** Space kept between a focused answer field and the list's bottom edge. */
const ANSWER_CLEARANCE = 12;

/**
 * Lets an answer field keep itself above the keyboard without the list jumping
 * to the newest message. Null outside the list, where nothing needs revealing.
 */
interface AnswerScroll {
  /** A field gained focus: its own row becomes the one to keep visible. */
  readonly focus: (row: AnswerRow) => void;
  /** A field lost focus or unmounted; clears the target only if it is still this row. */
  readonly blur: (row: AnswerRow) => void;
  /** The focused field's content grew or the list resized; re-reveal while it's focused. */
  readonly reveal: () => void;
  /** Whether some question's answer field currently holds focus. */
  readonly isFocused: () => boolean;
}

type AnswerRow = ComponentRef<typeof View>;

const AnswerScrollContext = createContext<AnswerScroll | null>(null);

/**
 * One discussion: messages oldest first, who has seen your last message, who
 * is typing, and the composer pinned at the foot. A null `discussionId` is a
 * discussion that starts with the first message; `ensureDiscussion` makes it.
 */
export function Chat(props: {
  readonly boardId: string;
  readonly state: KanbanBoardState;
  readonly discussionId: string | null;
  /** Makes the discussion when the first message goes out; gets that message's text. */
  readonly ensureDiscussion: (firstText: string) => Promise<string>;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly onOpenCard: (cardId: string) => void;
  /** Scrolls with the messages, above them. */
  readonly header?: ReactNode;
  /** Opens at the newest message; otherwise at the header. */
  readonly startAtEnd?: boolean;
}) {
  const { boardId, discussionId, state } = props;
  const messages = useKanbanMessages(boardId, discussionId);
  const feed = useKanbanMessagesFeed(boardId, discussionId);
  const discussion = discussionId === null ? undefined : state.discussions.get(discussionId);
  const clock = useTypingClock(discussion?.participants);
  const presence =
    discussion && messages
      ? discussionPresence(discussion, messages, Math.max(clock, props.nowMs))
      : null;
  const lastOwnSeq = messages?.findLast((message) => message.author._tag === "owner")?.seq ?? null;

  useMarkRead(boardId, discussionId, state, messages);

  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const frame = useRef<ComponentRef<typeof View>>(null);
  const following = useRef(props.startAtEnd ?? true);
  const placed = useRef(false);
  const scrollY = useRef(0);
  // The one focused answer field's row, or null. Only a field's own focus sets
  // it, and only that same row clears it, so other questions can't move it.
  const answerRow = useRef<AnswerRow | null>(null);
  const followToEnd = () => {
    following.current = true;
    scroll.current?.scrollToEnd({ animated: true });
  };

  // Scrolls only as far as the focused field's bottom edge needs, so the
  // list stays where the owner is reading. Every callback reads refs only, so
  // one stable object serves the whole list.
  const answerScroll = useMemo<AnswerScroll>(() => {
    const reveal = () => {
      const row = answerRow.current;
      const box = frame.current;
      if (row === null || box === null) return;
      row.measureInWindow((_x, rowY, _width, rowHeight) => {
        box.measureInWindow((_bx, boxY, _boxWidth, boxHeight) => {
          const overflow = rowY + rowHeight - (boxY + boxHeight) + ANSWER_CLEARANCE;
          if (overflow <= 0) return;
          scroll.current?.scrollTo({ y: Math.max(0, scrollY.current + overflow), animated: true });
        });
      });
    };
    return {
      focus: (row) => {
        answerRow.current = row;
        reveal();
      },
      blur: (row) => {
        if (answerRow.current === row) answerRow.current = null;
      },
      reveal,
      isFocused: () => answerRow.current !== null,
    };
  }, []);

  return (
    <View className="flex-1">
      <View ref={frame} className="flex-1" onLayout={answerScroll.reveal}>
        <ScrollView
          ref={scroll}
          className="flex-1"
          contentContainerClassName="gap-3 px-4 pb-4 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          scrollEventThrottle={64}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            scrollY.current = contentOffset.y;
            following.current =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK;
          }}
          onContentSizeChange={() => {
            // A focused answer keeps its own place; following the newest message would push it out of view.
            if (answerScroll.isFocused()) return answerScroll.reveal();
            if (!following.current) return;
            scroll.current?.scrollToEnd({ animated: placed.current });
            placed.current = true;
          }}
          // The keyboard shrinks the list without changing its content; keep
          // the newest message above the composer.
          onLayout={() => {
            if (following.current && placed.current && !answerScroll.isFocused()) {
              scroll.current?.scrollToEnd({ animated: false });
            }
          }}
        >
          <AnswerScrollContext.Provider value={answerScroll}>
            {props.header}
            <FeedError what="the discussion" feed={feed} nowMs={props.nowMs} />
            {discussionId !== null && messages === undefined && !feed.failure ? (
              <LoadingLine />
            ) : null}
            {messages?.map((message) => (
              <Fragment key={message.seq}>
                <MessageView
                  boardId={boardId}
                  discussionId={discussionId}
                  message={message}
                  state={state}
                  nowMs={props.nowMs}
                  onOpenCard={props.onOpenCard}
                />
                {message.seq === lastOwnSeq && presence && presence.seenBy.length > 0 ? (
                  <View
                    accessible
                    accessibilityLabel={`Seen by ${presence.seenBy.map((face) => face.name).join(", ")}`}
                    className="-mt-1.5 flex-row justify-end gap-[3px]"
                  >
                    {presence.seenBy.map((face) => (
                      <Avatar key={face.key} kind={face.kind} letter={face.letter} size="small" />
                    ))}
                  </View>
                ) : null}
              </Fragment>
            ))}
            {presence?.typing.map((face) => (
              <View
                key={face.key}
                accessible
                accessibilityLabel={`${face.name} is typing`}
                className="flex-row items-center gap-2.5"
              >
                <Avatar kind={face.kind} letter={face.letter} />
                <View className="h-[30px] flex-row items-center gap-1 rounded-full bg-card px-3">
                  <View className="size-1.5 rounded-full bg-foreground-muted" />
                  <View className="size-1.5 rounded-full bg-foreground-muted" />
                  <View className="size-1.5 rounded-full bg-foreground-muted" />
                </View>
              </View>
            ))}
          </AnswerScrollContext.Provider>
        </ScrollView>
      </View>
      <Composer
        boardId={boardId}
        discussionId={discussionId}
        ensureDiscussion={props.ensureDiscussion}
        bottomInset={props.bottomInset}
        onSent={followToEnd}
      />
    </View>
  );
}

/** Re-renders when the soonest typing marker runs out; markers carry no live updates of their own. */
function useTypingClock(participants: ReadonlyArray<KanbanParticipant> | undefined): number {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (participants === undefined) return;
    const tick = () => setClock(Date.now());
    const timers = [setTimeout(tick, 0)];
    const left = nextTypingExpiry(participants, Date.now());
    if (left !== null) timers.push(setTimeout(tick, left + 50));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [participants]);
  return clock;
}

/** Marks what is on screen read while the screen is in front. */
function useMarkRead(
  boardId: string,
  discussionId: string | null,
  state: KanbanBoardState,
  messages: ReadonlyArray<KanbanMessage> | undefined,
) {
  const focused = useIsFocused();
  const lastSeq = messages?.at(-1)?.seq ?? 0;
  const discussion = discussionId === null ? undefined : state.discussions.get(discussionId);
  const readSeq = discussion ? ownerReadSeq(discussion) : 0;
  const unread = discussionId === null ? 0 : (state.unread.get(discussionId) ?? 0);
  // The server's read position comes back later, with the discussion's next change.
  const marked = useRef<{ discussionId: string | null; seq: number }>({ discussionId, seq: 0 });
  useEffect(() => {
    if (!focused || discussionId === null || lastSeq === 0) return;
    const sent = marked.current.discussionId === discussionId ? marked.current.seq : 0;
    if (lastSeq <= sent) return;
    if (lastSeq <= readSeq && unread === 0) return;
    marked.current = { discussionId, seq: lastSeq };
    kanbanClient().markRead(boardId, discussionId, lastSeq);
  }, [boardId, discussionId, focused, lastSeq, readSeq, unread]);
}

function MessageView(props: {
  readonly boardId: string;
  readonly discussionId: string | null;
  readonly message: KanbanMessage;
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const { message } = props;
  const time = clockLabel(message.createdAt, props.nowMs);
  const blocks = (
    <Blocks
      boardId={props.boardId}
      discussionId={props.discussionId}
      message={message}
      state={props.state}
      nowMs={props.nowMs}
      onOpenCard={props.onOpenCard}
    />
  );
  if (message.author._tag === "owner") {
    return (
      <View className="max-w-[86%] gap-1 self-end">
        {/* user-bubble, as in a thread: card is the screen colour in some themes. */}
        <View className="gap-2 rounded-[18px] rounded-br-[6px] bg-user-bubble px-3.5 py-2.5">
          {blocks}
        </View>
        <Text className="self-end px-1 text-[12px] text-foreground-muted">{time}</Text>
      </View>
    );
  }
  const face = avatarOf(message.author, message.authorName);
  return (
    <View className="flex-row items-start gap-2.5">
      <Avatar kind={face.kind} letter={face.letter} label={message.authorName} />
      <View className="min-w-0 max-w-[90%] shrink gap-2 rounded-[18px] rounded-tl-[6px] bg-card px-3.5 py-2.5">
        <View className="flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="shrink text-[13px] font-t3-medium text-foreground">
            {message.authorName}
          </Text>
          <Text className="text-[12px] text-foreground-muted">{time}</Text>
        </View>
        {blocks}
      </View>
    </View>
  );
}

function Blocks(props: {
  readonly boardId: string;
  readonly discussionId: string | null;
  readonly message: KanbanMessage;
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly onOpenCard: (cardId: string) => void;
}) {
  return groupBlockRuns(props.message.blocks).map((run) =>
    run.kind === "attachments" ? (
      <AttachmentRun key={run.index} attachments={run.attachments} />
    ) : (
      <BlockView
        // oxlint-disable-next-line react/no-array-index-key -- a message's blocks never reorder
        key={run.index}
        block={run.block}
        {...props}
      />
    ),
  );
}

function BlockView(props: {
  readonly block: KanbanBlock;
  readonly boardId: string;
  readonly discussionId: string | null;
  readonly message: KanbanMessage;
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const { block } = props;
  switch (block._tag) {
    case "md":
      return (
        <MarkdownText
          text={block.text}
          maxLines={MESSAGE_LINES}
          tone={props.message.author._tag === "owner" ? "user" : "screen"}
        />
      );
    case "collapse":
      return <Collapse title={block.title} text={block.text} />;
    case "html":
      return <HtmlBlock html={block.html} title={block.title} height={block.height} />;
    case "choice":
      return (
        <ChoiceBlock
          block={block}
          boardId={props.boardId}
          discussionId={props.discussionId}
          message={props.message}
        />
      );
    case "card":
      return (
        <CardBlock
          cardId={block.cardId}
          state={props.state}
          nowMs={props.nowMs}
          onOpenCard={props.onOpenCard}
        />
      );
    case "image":
      return <ImageBlock url={block.url} alt={block.alt} />;
    // Attachment runs render through AttachmentRun in Blocks.
    case "attachment":
      return <AttachmentRun attachments={[block.attachment]} />;
  }
}

/** Consecutive attachments share one wrapping row. */
function AttachmentRun(props: { readonly attachments: ReadonlyArray<StoredAttachment> }) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.attachments.map((attachment) => (
        <StoredAttachmentView key={attachment.id} attachment={attachment} />
      ))}
    </View>
  );
}

function StoredAttachmentView(props: { readonly attachment: StoredAttachment }) {
  const { attachment } = props;
  const environmentId = usePairedEnvironmentId();
  const isImage = attachment.type === "image";
  const resource = {
    _tag: "attachment" as const,
    attachmentId: attachment.id,
    fileName: attachment.name,
    mimeType: attachment.mimeType,
  };
  const uri = useAssetUrl(environmentId, resource);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  if (environmentId === null) return null;
  if (isImage) {
    return (
      <>
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open ${attachment.name}`}
          onPress={() =>
            uri !== null &&
            setPreview({
              kind: "image",
              environmentId,
              resource,
              name: attachment.name,
            })
          }
          className="size-24 overflow-hidden rounded-[12px] bg-secondary"
        >
          {uri !== null ? (
            <Image
              source={{ uri }}
              cachePolicy="memory-disk"
              contentFit="cover"
              style={{ width: "100%", height: "100%" }}
              accessibilityIgnoresInvertColors
            />
          ) : null}
        </Pressable>
        <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
      </>
    );
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${attachment.name}`}
        accessibilityValue={{ text: formatAttachmentSize(attachment.sizeBytes) }}
        onPress={() =>
          setPreview({
            kind: "document",
            name: attachment.name,
            mimeType: attachment.mimeType,
            environmentId,
            resource,
          })
        }
        className="min-h-10 max-w-full flex-row items-center gap-2 rounded-[12px] bg-screen px-3 py-2"
      >
        <Text numberOfLines={1} className="shrink text-[14px] font-t3-medium text-foreground">
          {attachment.name}
        </Text>
        <Text className="text-[12px] text-foreground-muted">
          {formatAttachmentSize(attachment.sizeBytes)}
        </Text>
      </Pressable>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </>
  );
}

function Collapse(props: { readonly title: string; readonly text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="rounded-[12px] bg-screen">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="min-h-9 flex-row items-center gap-2 px-3 py-2"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={11}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
        <Text className="flex-1 text-[13px] font-t3-medium text-foreground">{props.title}</Text>
      </Pressable>
      {open ? (
        <View className="px-3 pb-2.5">
          <MarkdownText text={props.text} maxLines={null} />
        </View>
      ) : null}
    </View>
  );
}

function HtmlBlock(props: {
  readonly html: string;
  readonly title: string | null;
  readonly height: number | null;
}) {
  const height = Math.min(HTML_MAX_HEIGHT, props.height ?? HTML_DEFAULT_HEIGHT);
  // The page draws in place; links it follows open outside the app. Frames
  // inside it (iOS asks for those too) load where they are.
  const onNavigate = useCallback((request: WebViewNavigation & { isTopFrame?: boolean }) => {
    if (request.url === "about:blank" || request.url.startsWith("data:")) return true;
    if (request.isTopFrame === false) return true;
    void tryOpenExternalUrl(request.url, "html-render");
    return false;
  }, []);
  return (
    <View className="gap-1.5">
      {props.title ? (
        <Text className="text-[13px] font-t3-medium text-foreground">{props.title}</Text>
      ) : null}
      <View className="overflow-hidden rounded-[12px] bg-screen" style={{ height }}>
        <WebView
          source={{ html: props.html }}
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={onNavigate}
          setSupportMultipleWindows={false}
          incognito
          nestedScrollEnabled
          style={{ backgroundColor: "transparent" }}
        />
      </View>
    </View>
  );
}

function ChoiceBlock(props: {
  readonly block: Extract<KanbanBlock, { _tag: "choice" }>;
  readonly boardId: string;
  readonly discussionId: string | null;
  readonly message: KanbanMessage;
}) {
  const { block, message } = props;
  const action = useBoardAction();
  const answerScroll = useContext(AnswerScrollContext);
  const answerRowRef = useRef<AnswerRow | null>(null);
  // The row this field registered on focus. Kept apart from answerRowRef because
  // React detaches that ref before unmount cleanup runs.
  const focusedRowRef = useRef<AnswerRow | null>(null);
  // Unmounting while focused must not leave the list pinned to this row.
  useEffect(
    () => () => {
      const row = focusedRowRef.current;
      focusedRowRef.current = null;
      if (row !== null) answerScroll?.blur(row);
    },
    [answerScroll],
  );
  // A multi pick being put together, or an answer on its way. It holds until
  // the owner's own answer on this block changes, so re-reads and other
  // people's answers don't drop it, and it can't flicker back early.
  const [draft, setDraft] = useState<ChoiceDraft | null>(null);
  const view = choiceView(block, message.answers);
  const ownAt =
    message.answers.find((answer) => answer.blockId === block.id && answer.by._tag === "owner")
      ?.at ?? null;
  const current = draft !== null && draft.against === ownAt ? draft : null;
  const mine = current?.choice ?? view.mine;
  const text = current?.text ?? "";
  const poll = block.style === "poll";
  // Every owner answer reaches the agent, so a pick is answered once; a poll
  // vote can move.
  const locked = !poll && (view.mine.length > 0 || view.mineText !== null || current?.sent === true);
  const multiPick = !poll && block.multi;
  const canSend = canSendChoice(block, mine, text);
  // Sending from the field removes it while ChoiceBlock stays mounted, and
  // React Native doesn't reliably deliver onBlur for a removed input.
  useEffect(() => {
    if (!locked) return;
    const row = focusedRowRef.current;
    focusedRowRef.current = null;
    if (row !== null) answerScroll?.blur(row);
  }, [locked, answerScroll]);

  const send = (choice: ReadonlyArray<string>, words: string) => {
    const discussionId = props.discussionId;
    if (discussionId === null || !canSendChoice(block, choice, words)) return;
    const against = ownAt;
    setDraft({ choice, text: words, against, sent: true });
    void action
      .run("Couldn't send the answer", () =>
        kanbanClient().answer(
          props.boardId,
          discussionId,
          message.seq,
          block.id,
          [...choice],
          words.trim() || null,
        ),
      )
      .then((ok) => {
        // A failed answer keeps what was ticked and typed so it can be sent again.
        if (!ok) {
          const keep = multiPick || words.trim() !== "";
          setDraft(keep ? { choice, text: words, against, sent: false } : null);
        }
      });
  };

  const setWords = (words: string) =>
    setDraft({ choice: mine, text: words, against: ownAt, sent: false });

  const pick = (optionId: string) => {
    if (locked) return;
    const next = toggleChoice(mine, optionId, block.multi);
    if (multiPick) {
      setDraft({ choice: next, text, against: ownAt, sent: false });
      return;
    }
    send(next, "");
  };

  return (
    <View className="gap-1.5">
      <Text className="text-[15px] leading-[22px] text-foreground">{block.question}</Text>
      <View accessibilityRole={block.multi ? undefined : "radiogroup"} className="gap-1">
        {view.options.map((option) => {
          const selected = mine.includes(option.id);
          return (
            <Pressable
              key={option.id}
              accessibilityRole={block.multi ? "checkbox" : "radio"}
              accessibilityState={{ checked: selected, disabled: action.pending || locked }}
              accessibilityLabel={poll ? `${option.label}, ${option.percent}%` : option.label}
              disabled={action.pending || locked}
              onPress={() => pick(option.id)}
              className={cn(
                "min-h-10 flex-row items-center gap-2.5 overflow-hidden rounded-[12px] border-[1.5px] bg-screen px-3 py-2",
                !poll && selected ? "border-primary" : "border-transparent",
              )}
            >
              {poll ? (
                <View
                  className="absolute inset-y-0 left-0 bg-update"
                  style={{ width: `${option.percent}%` }}
                />
              ) : (
                <View
                  className={cn(
                    "size-4 border-[1.5px]",
                    block.multi ? "rounded-[5px]" : "rounded-full",
                    selected ? "border-[5px] border-primary" : "border-input-border",
                  )}
                />
              )}
              <Text
                className={cn(
                  "flex-1 text-[14px] text-foreground",
                  poll && selected && "font-t3-medium",
                )}
              >
                {option.label}
              </Text>
              {poll ? (
                <Text className="text-[14px] font-t3-medium text-foreground">
                  {option.percent}%
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {!poll && !locked ? (
        <View
          ref={answerRowRef}
          className="min-h-10 flex-row items-end gap-2 rounded-[12px] border-[1.5px] border-transparent bg-screen py-1.5 pl-3 pr-1.5"
        >
          <AppTextInput
            multiline
            accessibilityLabel="Your own answer"
            value={text}
            onChangeText={setWords}
            onFocus={() => {
              const row = answerRowRef.current;
              if (row === null) return;
              focusedRowRef.current = row;
              answerScroll?.focus(row);
            }}
            onBlur={() => {
              const row = focusedRowRef.current;
              focusedRowRef.current = null;
              if (row !== null) answerScroll?.blur(row);
            }}
            onContentSizeChange={() => answerScroll?.reveal()}
            editable={!action.pending}
            placeholder="Your own answer"
            placeholderTextColorClassName="accent-foreground-muted"
            className="max-h-32 min-h-8 flex-1 rounded-none border-0 bg-transparent px-0 py-1.5 text-[15px]"
          />
          {!multiPick ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send your answer"
              accessibilityState={{ disabled: !canSend || action.pending }}
              disabled={!canSend || action.pending}
              onPress={() => send([], text)}
              className={cn(
                "size-8 items-center justify-center rounded-full",
                !canSend || action.pending ? "bg-secondary" : "bg-foreground",
              )}
            >
              <SymbolView
                name="arrow.up"
                size={15}
                tintColorClassName={
                  !canSend || action.pending ? "accent-icon-muted" : "accent-screen"
                }
                type="monochrome"
              />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {locked && view.mineText !== null ? (
        <View className="min-h-10 flex-row items-center gap-2.5 rounded-[12px] border-[1.5px] border-primary bg-screen px-3 py-2">
          <View className="size-4 rounded-[5px] border-[5px] border-primary" />
          <Text className="flex-1 text-[14px] text-foreground">{view.mineText}</Text>
        </View>
      ) : null}
      {locked ? (
        <Text className="text-[12px] text-foreground-muted">
          {view.mine.length > 0 || view.mineText !== null ? "Answer sent" : "Sending…"}
        </Text>
      ) : null}
      {multiPick && !locked ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send answer"
          accessibilityState={{ disabled: !canSend || action.pending }}
          disabled={!canSend || action.pending}
          onPress={() => send(mine, text)}
          className={cn(
            "h-9 self-start justify-center rounded-full px-4",
            !canSend || action.pending ? "bg-secondary" : "bg-foreground",
          )}
        >
          <Text
            className={cn(
              "text-[14px] font-t3-medium",
              !canSend || action.pending ? "text-foreground-muted" : "text-screen",
            )}
          >
            Send
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

interface ChoiceDraft {
  readonly choice: ReadonlyArray<string>;
  readonly text: string;
  readonly against: string | null;
  readonly sent: boolean;
}

function CardBlock(props: {
  readonly cardId: string;
  readonly state: KanbanBoardState;
  readonly nowMs: number;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const card = props.state.cards.get(props.cardId);
  if (card === undefined) {
    return <Text className="text-[13px] text-foreground-muted">Card not on this board</Text>;
  }
  const view = cardView(card, props.state, props.nowMs);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${view.number}, ${view.title}, ${view.stageLabel}`}
      onPress={() => props.onOpenCard(card.id)}
      className="min-h-10 flex-row items-center gap-2.5 rounded-[12px] bg-screen px-3 py-2"
    >
      <Glyph kind={cardGlyph(card)} />
      <Text numberOfLines={1} className="flex-1 text-[14px] font-t3-medium text-foreground">
        {view.title}
      </Text>
      <Text className="text-[12px] text-foreground-muted">{view.number}</Text>
    </Pressable>
  );
}

function ImageBlock(props: { readonly url: string; readonly alt: string | null }) {
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  if (!isLoadableImageUrl(props.url)) {
    return <Text className="text-[13px] text-foreground-muted">{props.alt ?? "Image"}</Text>;
  }
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={props.alt ?? "Image"}
        onPress={() =>
          setPreview({ kind: "image", uri: props.url, ...(props.alt ? { name: props.alt } : {}) })
        }
        className="overflow-hidden rounded-[12px] bg-secondary"
        style={{ aspectRatio: 4 / 3 }}
      >
        <Image
          source={{ uri: props.url }}
          cachePolicy="memory-disk"
          contentFit="cover"
          style={{ width: "100%", height: "100%" }}
          accessibilityIgnoresInvertColors
        />
      </Pressable>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </>
  );
}

/** A picked file on its way to the server. The chip shows it uploading until the server has it. */
interface ComposerDraft {
  readonly local: DraftComposerAttachment;
  readonly uploaded: StoredAttachment | null;
  readonly failed: boolean;
}

function Composer(props: {
  readonly boardId: string;
  readonly discussionId: string | null;
  readonly ensureDiscussion: (firstText: string) => Promise<string>;
  readonly bottomInset: number;
  readonly onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<ReadonlyArray<ComposerDraft>>([]);
  // iOS keeps a grown multiline input tall after its value is cleared; a new one starts short.
  const [field, setField] = useState(0);
  const action = useBoardAction();
  const environmentId = usePairedEnvironmentId();
  const configs = useServerConfigs();
  const capabilities =
    environmentId === null ? undefined : configs.get(environmentId)?.environment.capabilities;
  const canAttach = capabilities?.attachmentUploads === true;
  const maxFileBytes = capabilities?.fileAttachments?.maxUploadBytes;
  const uploading = drafts.some((draft) => draft.uploaded === null && !draft.failed);
  const empty = text.trim().length === 0 && drafts.length === 0;
  const blocked = empty || action.pending || uploading;
  // The latest drafts, for the unmount cleanup, which runs once.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const environmentRef = useRef(environmentId);
  environmentRef.current = environmentId;
  useEffect(
    () => () => {
      const id = environmentRef.current;
      const uploads = draftsRef.current.flatMap((draft) =>
        draft.uploaded === null ? [] : [draft.uploaded.id],
      );
      if (id !== null && uploads.length > 0) void releasePendingAttachmentUploads(id, uploads);
    },
    [],
  );

  const addPicked = (picked: ReadonlyArray<DraftComposerAttachment>) => {
    if (picked.length === 0 || environmentId === null) return;
    setDrafts((current) => [
      ...current,
      ...picked.map((local) => ({ local, uploaded: null, failed: false })),
    ]);
    // Each file uploads as it is picked, so its chip can show progress and a removed one is released.
    for (const local of picked) {
      void prepareTurnAttachments({
        environmentId,
        attachments: [local],
        supportsImageUploads: true,
      })
        .then((result) => {
          const stored = result.status === "ready" ? result.attachments[0] : undefined;
          if (stored === undefined) throw new Error("Upload cancelled.");
          setDrafts((current) =>
            current.map((draft) =>
              draft.local.id === local.id
                ? { ...draft, uploaded: stored as StoredAttachment }
                : draft,
            ),
          );
        })
        .catch((error: unknown) => {
          setDrafts((current) =>
            current.map((draft) =>
              draft.local.id === local.id ? { ...draft, failed: true } : draft,
            ),
          );
          Dialog.alert(
            "Couldn't attach file",
            error instanceof Error ? error.message : "Try again.",
          );
        });
    }
  };

  const pick = async (kind: "media" | "files") => {
    const result =
      kind === "files"
        ? await pickComposerFiles({ existingCount: drafts.length, maxBytes: maxFileBytes })
        : await pickComposerMedia({ existingCount: drafts.length, maxVideoBytes: maxFileBytes });
    addPicked("files" in result ? result.files : result.attachments);
    if (result.error) Dialog.alert("Could not attach file", result.error);
  };

  const removeDraft = (id: string) => {
    const removed = drafts.find((draft) => draft.local.id === id);
    setDrafts((current) => current.filter((draft) => draft.local.id !== id));
    if (removed?.uploaded && environmentId !== null) {
      void releasePendingAttachmentUploads(environmentId, [removed.uploaded.id]);
    }
  };

  const send = () => {
    if (blocked) return;
    const body = text.trim();
    const sending = drafts;
    const stored = sending.flatMap((draft) => (draft.uploaded ? [draft.uploaded] : []));
    setText("");
    setDrafts([]);
    setField((key) => key + 1);
    void action
      .run("Couldn't send", async () => {
        const discussionId =
          props.discussionId ?? (await props.ensureDiscussion(firstSendText(body, stored)));
        await kanbanClient().post(props.boardId, discussionId, sendBlocks(body, stored));
      })
      .then((sent) => {
        if (sent) {
          props.onSent();
          return;
        }
        // A failed send gives the text and files back so the owner can send again.
        setText((current) => (current === "" ? body : current));
        setDrafts((current) => [...sending, ...current]);
      });
  };

  return (
    <View className="gap-2 bg-screen px-3 pt-2" style={{ paddingBottom: props.bottomInset }}>
      {drafts.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {drafts.map((draft) => (
            <DraftChip
              key={draft.local.id}
              draft={draft}
              onRemove={() => removeDraft(draft.local.id)}
            />
          ))}
        </View>
      ) : null}
      <View className="flex-row items-end gap-1.5 rounded-[22px] bg-card py-1.5 pl-1.5 pr-1.5">
        {canAttach ? (
          <ComposerAttachmentButton
            disabled={action.pending}
            supportsFiles={capabilities?.fileAttachments !== undefined}
            onPickMedia={() => pick("media")}
            onPickFiles={() => pick("files")}
          />
        ) : null}
        <AppTextInput
          key={field}
          // The new input after a send takes the focus back, so the keyboard stays up.
          autoFocus={field > 0}
          multiline
          accessibilityLabel="Message"
          value={text}
          onChangeText={setText}
          placeholder="Message"
          placeholderTextColorClassName="accent-foreground-muted"
          className="max-h-32 min-h-8 flex-1 rounded-none border-0 bg-transparent px-0 py-1.5 text-[15px]"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: blocked }}
          disabled={blocked}
          onPress={send}
          className={cn(
            "mr-1 size-8 items-center justify-center rounded-full",
            blocked ? "bg-secondary" : "bg-foreground",
          )}
        >
          <SymbolView
            name="arrow.up"
            size={15}
            tintColorClassName={blocked ? "accent-icon-muted" : "accent-screen"}
            type="monochrome"
          />
        </Pressable>
      </View>
    </View>
  );
}

/** A picked file as a removable chip: a thumbnail for pictures, the name and size otherwise. */
function DraftChip(props: { readonly draft: ComposerDraft; readonly onRemove: () => void }) {
  const { local } = props.draft;
  const uploading = props.draft.uploaded === null && !props.draft.failed;
  const previewUri = "previewUri" in local ? local.previewUri : null;
  const label = props.draft.failed ? "Failed" : uploading ? "Uploading…" : null;
  return (
    <View className="max-w-full flex-row items-center gap-2 rounded-[12px] bg-screen py-1.5 pl-1.5 pr-1">
      {previewUri ? (
        <Image
          source={{ uri: previewUri }}
          contentFit="cover"
          style={{ width: 36, height: 36, borderRadius: 8 }}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <View className="min-w-0 shrink">
        <Text numberOfLines={1} className="text-[13px] font-t3-medium text-foreground">
          {local.name}
        </Text>
        <Text className="text-[11px] text-foreground-muted">
          {label ?? formatAttachmentSize(local.sizeBytes)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${local.name}`}
        onPress={props.onRemove}
        className="size-7 items-center justify-center rounded-full"
      >
        <SymbolView name="xmark" size={11} tintColorClassName="accent-icon-muted" type="monochrome" />
      </Pressable>
    </View>
  );
}
