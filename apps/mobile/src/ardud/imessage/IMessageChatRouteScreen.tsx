import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  formatIMessageDuration,
  imessageAgentSummary,
  imessageChatKind,
  imessageChatLabel,
  imessageDayKey,
  imessageEarlierStep,
  imessageThreadWindowStart,
  type IMessageAgentStep,
  type IMessageChatRow,
} from "@t3tools/client-runtime/ardud/imessage";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { shouldShowLoadEarlierControl } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type ComponentRef,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useHomeRouteVisible } from "../../features/home/home-route-visibility";
import { threadHasUnseenCompletion } from "../../features/threads/threadListV2";
import { cn } from "../../lib/cn";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { EmptyLine, LinkButton, Meta } from "../common/parts";
import { useHeaderInset } from "../common/hooks";
import { IMessageAvatar } from "./IMessageAvatar";
import { type IMessagePalette, useIMessagePalette } from "./palette";
import {
  threadRef,
  useIMessageChatThreads,
  useIMessageThreadRows,
  useLoadEarlierHistory,
  useThreadHistoryMeta,
} from "./useIMessageChat";

// Deep links deliver plain strings.
export type IMessageChatParams = {
  readonly chatSlug?: string | undefined;
};

type OpenThread = (ref: ScopedThreadRef) => void;

/** One iMessage chat as Messages shows it, read-only. */
export function IMessageChatRouteScreen({
  route,
}: StaticScreenProps<IMessageChatParams | undefined>) {
  const navigation = useNavigation();
  const slug = route.params?.chatSlug ?? "";
  // Route-generic despite its name: true from the moment this screen starts to
  // appear, so a back swipe from a thread already shows the live transcript.
  const onScreen = useHomeRouteVisible();
  const { chat, threads } = useIMessageChatThreads(slug, onScreen);
  const back = () => navigation.goBack();
  const openThread = useCallback<OpenThread>(
    (ref) => navigation.navigate("Thread", ref),
    [navigation],
  );
  if (slug === "") {
    return (
      <Shell title="iMessage" onBack={back}>
        <EmptyLine label="This link does not open anything." />
      </Shell>
    );
  }
  const label = imessageChatLabel(slug, chat?.latestTitle);
  return (
    <Shell title={label} onBack={back}>
      {threads.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <IMessageAvatar label={label} size="large" />
          <Meta>No messages yet.</Meta>
        </View>
      ) : (
        // A new chat starts its own window and paging.
        <ChatTranscript
          key={slug}
          slug={slug}
          threads={threads}
          onScreen={onScreen}
          onOpenThread={openThread}
        />
      )}
    </Shell>
  );
}

function Shell(props: {
  readonly title: string;
  readonly onBack: () => void;
  readonly children: ReactNode;
}) {
  const headerInset = useHeaderInset();
  return (
    <View collapsable={false} className="flex-1 bg-screen" style={{ paddingTop: headerInset }}>
      <AppBar title={props.title} sidebar={false} onBack={props.onBack} />
      {props.children}
    </View>
  );
}

// Within this distance of the end the transcript follows new messages.
const FOLLOW_SLOP = 48;

/**
 * Only the newest sessions are mounted, since each holds a live subscription. "Show
 * earlier" first pages the oldest shown session's own history, then widens the window
 * by a day.
 */
function ChatTranscript(props: {
  readonly slug: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onScreen: boolean;
  readonly onOpenThread: OpenThread;
}) {
  const [openedAt] = useState(() => Date.now());
  const [earlierDays, setEarlierDays] = useState(0);
  const start = imessageThreadWindowStart(props.threads, openedAt, earlierDays);
  const visible = props.threads.slice(start);
  const oldest = visible[0] ?? null;
  const oldestHistory = useThreadHistoryMeta(oldest ? threadRef(oldest) : null, props.onScreen);
  const earlierStep = imessageEarlierStep({
    windowStart: start,
    oldestHasMoreHistory: oldestHistory.hasMoreHistory,
  });
  const loadEarlier = useLoadEarlierHistory();
  const namedSenders = imessageChatKind(props.slug) !== "owner";
  useMarkSeen(props.threads, props.onScreen);

  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const following = useRef(true);
  const onShow =
    earlierStep === "history" && oldest
      ? () => loadEarlier(oldest)
      : earlierStep === "sessions"
        ? () => setEarlierDays((days) => days + 1)
        : null;

  return (
    <ScrollView
      ref={scroll}
      className="flex-1"
      contentContainerClassName="px-4 pb-8 pt-2"
      // Rows are direct children, so earlier rows land above the one being read
      // instead of pushing it down. Index 1 skips the "Show earlier" control.
      maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
      scrollEventThrottle={64}
      onScroll={(event) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        following.current =
          contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLOP;
      }}
      onContentSizeChange={() => {
        if (following.current) scroll.current?.scrollToEnd({ animated: false });
      }}
    >
      {earlierStep !== null || oldestHistory.error !== null ? (
        <ShowEarlier
          loading={earlierStep === "history" && oldestHistory.loading}
          error={oldestHistory.error}
          onShow={onShow}
        />
      ) : null}
      {visible.map((thread, index) => (
        <ThreadRows
          key={thread.id}
          thread={thread}
          previousDayKey={index === 0 ? null : imessageDayKey(visible[index - 1]!.updatedAt)}
          namedSenders={namedSenders}
          pagesOwnHistory={index > 0}
          onScreen={props.onScreen}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </ScrollView>
  );
}

/** Reading the chat clears its new-replies dot on Home, as opening a thread does. */
function useMarkSeen(threads: ReadonlyArray<EnvironmentThreadShell>, onScreen: boolean) {
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const sent = useRef(new Set<string>());
  useEffect(() => {
    if (!onScreen) return;
    for (const thread of threads) {
      if (!threadHasUnseenCompletion(thread)) continue;
      const key = `${thread.id}:${thread.updatedAt}`;
      if (sent.current.has(key)) continue;
      sent.current.add(key);
      void visit({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, visitedAt: thread.updatedAt },
      });
    }
  }, [onScreen, threads, visit]);
}

function ShowEarlier(props: {
  readonly loading: boolean;
  readonly error: string | null;
  readonly onShow: (() => void) | null;
}) {
  return (
    <View className="items-center gap-1.5 pb-1 pt-2">
      {props.onShow ? (
        <LinkButton
          label={props.loading ? "Loading…" : "Show earlier"}
          disabled={props.loading}
          onPress={props.onShow}
        />
      ) : null}
      {props.error !== null ? (
        <Meta className="text-center" numberOfLines={2}>
          {props.error}
        </Meta>
      ) : null}
    </View>
  );
}

/** One session's rows. It returns a fragment so each row is a direct scroll child. */
const ThreadRows = memo(function ThreadRows(props: {
  readonly thread: EnvironmentThreadShell;
  readonly previousDayKey: string | null;
  readonly namedSenders: boolean;
  readonly pagesOwnHistory: boolean;
  readonly onScreen: boolean;
  readonly onOpenThread: OpenThread;
}) {
  const { thread, onOpenThread } = props;
  const { environmentId, id: threadId } = thread;
  const { rows, status, error } = useIMessageThreadRows(
    thread,
    { previousDayKey: props.previousDayKey, namedSenders: props.namedSenders },
    props.onScreen,
  );
  const history = useThreadHistoryMeta(
    props.pagesOwnHistory ? threadRef(thread) : null,
    props.onScreen,
  );
  const loadEarlier = useLoadEarlierHistory();
  const palette = useIMessagePalette();
  // Keyed on ids so a shell update doesn't re-render every row.
  const openThread = useCallback(
    () => onOpenThread({ environmentId, threadId }),
    [onOpenThread, environmentId, threadId],
  );
  const pending = status === "empty" || status === "synchronizing";
  return (
    <>
      {shouldShowLoadEarlierControl(history) ? (
        <ShowEarlier
          loading={history.loading}
          error={history.error}
          onShow={history.hasMoreHistory ? () => loadEarlier(thread) : null}
        />
      ) : null}
      {rows.length === 0 && error !== null ? (
        <Meta className="mt-3.5 text-center">Couldn't load this session.</Meta>
      ) : rows.length === 0 && pending ? (
        <Meta className="mt-3.5 text-center">Loading…</Meta>
      ) : null}
      {rows.map((row) => (
        <ChatRow key={row.id} row={row} palette={palette} onOpenThread={openThread} />
      ))}
    </>
  );
});

interface ChatRowProps {
  readonly row: IMessageChatRow;
  readonly palette: IMessagePalette;
  readonly onOpenThread: () => void;
}

// Rows are rebuilt as new objects on every streamed chunk, so compare content
// to keep unchanged bubbles from re-rendering.
const ChatRow = memo(
  ChatRowContent,
  (previous: ChatRowProps, next: ChatRowProps) =>
    previous.palette === next.palette &&
    previous.onOpenThread === next.onOpenThread &&
    sameRow(previous.row, next.row),
);

function sameRow(left: IMessageChatRow, right: IMessageChatRow): boolean {
  if (left === right) return true;
  if (left.kind !== "agent" || right.kind !== "agent") return sameFields(left, right);
  const { steps: leftSteps, ...leftRest } = left;
  const { steps: rightSteps, ...rightRest } = right;
  return (
    sameFields(leftRest, rightRest) &&
    leftSteps.length === rightSteps.length &&
    leftSteps.every((step, index) => sameFields(step, rightSteps[index]!))
  );
}

function sameFields(left: object, right: object): boolean {
  const leftEntries = Object.entries(left);
  const rightValues = new Map(Object.entries(right));
  return (
    leftEntries.length === rightValues.size &&
    leftEntries.every(([key, value]) => Object.is(value, rightValues.get(key)))
  );
}

function ChatRowContent(props: ChatRowProps) {
  const { row, palette } = props;
  switch (row.kind) {
    case "divider":
      return (
        <Text className="mb-1.5 mt-3.5 text-center text-xs font-t3-medium text-foreground-muted">
          {new Date(row.createdAt).toLocaleDateString([], {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </Text>
      );
    case "time":
      return (
        <Text className="mb-1.5 mt-3.5 text-center text-2xs text-foreground-muted">
          {new Date(row.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </Text>
      );
    case "incoming":
      return (
        <Bubble
          side="incoming"
          palette={palette}
          text={row.voice && row.text === "" ? "Voice message, not transcribed" : row.text}
          sender={row.senderChanged ? row.sender : null}
          quote={row.quote}
          caption={row.voice && row.text !== "" ? "Voice message" : null}
        />
      );
    case "reply":
      return (
        <Bubble
          side="reply"
          palette={palette}
          text={row.text}
          sender={null}
          quote={null}
          caption={null}
        />
      );
    case "event":
      return (
        <Text className="my-1.5 self-center px-6 text-center text-xs text-foreground-muted">
          <Text className="text-xs font-t3-semibold text-foreground">{row.source}</Text>
          {row.title ? ` · ${row.title}` : ""}
        </Text>
      );
    case "agent":
      return <AgentRow row={row} palette={palette} onOpenThread={props.onOpenThread} />;
  }
}

function Bubble(props: {
  readonly side: "incoming" | "reply";
  readonly palette: IMessagePalette;
  readonly text: string;
  readonly sender: string | null;
  readonly quote: string | null;
  readonly caption: string | null;
}) {
  const reply = props.side === "reply";
  return (
    <View className={cn("mt-[3px] max-w-[78%]", reply ? "items-end self-end" : "self-start")}>
      {props.sender ? (
        <Text className="mb-0.5 ml-[13px] mt-1.5 text-xs text-foreground-muted">
          {props.sender}
        </Text>
      ) : null}
      {props.quote ? (
        <Text numberOfLines={2} className="mb-0.5 ml-[13px] text-xs text-foreground-muted">
          {props.quote}
        </Text>
      ) : null}
      <View
        className="rounded-[18px] px-[13px] py-2"
        style={{ backgroundColor: reply ? props.palette.outgoing : props.palette.incoming }}
      >
        <Text
          selectable
          className="text-[16px] leading-[21px]"
          style={{ color: reply ? "#ffffff" : props.palette.incomingInk }}
        >
          {props.text}
        </Text>
      </View>
      {props.caption ? (
        <Text className="ml-[13px] mt-0.5 text-2xs text-foreground-muted">{props.caption}</Text>
      ) : null}
    </View>
  );
}

/** Everything the agent did for one turn, folded into a line under the conversation. */
function AgentRow(props: {
  readonly row: Extract<IMessageChatRow, { kind: "agent" }>;
  readonly palette: IMessagePalette;
  readonly onOpenThread: () => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = imessageAgentSummary(props.row);
  return (
    <View className="self-end">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        onPress={() => setOpen((value) => !value)}
        className="mt-1 flex-row items-center gap-1 self-end px-1.5 pb-0.5 pt-1"
      >
        <Text className={cn("text-xs", open ? "text-foreground" : "text-foreground-muted")}>
          {summary}
        </Text>
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={11}
          tintColorClassName={open ? "accent-foreground" : "accent-foreground-muted"}
          type="monochrome"
        />
      </Pressable>
      {open ? (
        <View
          className="mb-1.5 mt-1 w-[92%] self-end rounded-xl px-4 py-3.5"
          style={{ backgroundColor: props.palette.raised }}
        >
          {props.row.steps.length > 0 ? (
            <View className="gap-2">
              {props.row.steps.map((step) => (
                <AgentStep key={step.id} step={step} />
              ))}
            </View>
          ) : null}
          <Pressable
            accessibilityRole="link"
            hitSlop={8}
            onPress={props.onOpenThread}
            className={cn(
              "flex-row items-center gap-1 self-start",
              props.row.steps.length > 0 && "mt-3",
            )}
          >
            <Text className="text-[13px] font-t3-medium" style={{ color: props.palette.link }}>
              Open thread
            </Text>
            <SymbolView
              name="arrow.up.right"
              size={11}
              tintColor={props.palette.link}
              type="monochrome"
            />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function AgentStep(props: { readonly step: IMessageAgentStep }) {
  const { step } = props;
  const [open, setOpen] = useState(false);
  const line = (
    <View className="flex-row items-start gap-3">
      <Text
        numberOfLines={1}
        className={cn(
          "w-[88px] text-[13px] leading-[18px]",
          step.error ? "text-danger-foreground" : "text-foreground-muted",
        )}
      >
        {step.label}
      </Text>
      <Text
        numberOfLines={open ? undefined : 2}
        className={cn(
          "min-w-0 flex-1 text-foreground",
          step.code ? "font-mono text-xs leading-[18px]" : "text-[13px] leading-[18px]",
        )}
      >
        {step.text}
      </Text>
      {step.seconds !== null ? (
        <Text className="text-xs leading-[18px] text-foreground-muted tabular-nums">
          {formatIMessageDuration(step.seconds)}
        </Text>
      ) : null}
    </View>
  );
  if (step.detail === null) return line;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${step.label}: ${step.text}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
      >
        {line}
      </Pressable>
      {open ? (
        <ScrollView className="mt-1.5 max-h-72" nestedScrollEnabled>
          <Text selectable className="text-xs leading-[17px] text-foreground-muted">
            {step.detail}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}
