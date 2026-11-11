import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  EMPTY_NEEDS_YOU_FILTER,
  askAge,
  askAutoRetryOwed,
  askAsker,
  askDiscussion,
  askFailureText,
  askFormFor,
  askFormWithSecrets,
  askKey,
  askUnreadableKey,
  askKindLabel,
  askNeedsDetail,
  askPrimaryLabel,
  askRefusal,
  askRepliedOnCard,
  askRequiresSecret,
  askSecretAnswerInput,
  askWordsForReply,
  buildAskAnswer,
  isPlainAnswerField,
  needsYouFocusOrder,
  needsYouMarkOf,
  needsYouSections,
  shortWhen,
  type AskSecretAnswerInput,
  type NeedsYouItem,
  type SnoozeUntil,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  kanbanAskChanges,
  kanbanAskResponse,
  kanbanAskRevision,
  type KanbanAskFeedItem,
} from "@t3tools/contracts";
import { type ComponentRef, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ScrollView, View } from "react-native";

import type { AppBarMenuItem } from "../../../components/ui/AppBar.types";
import { AppText as Text } from "../../../components/ui/AppText";
import { LoadingLine } from "../../common/FeedError";
import { useNowMs } from "../../common/hooks";
import { MarkdownText } from "../../common/MarkdownText";
import { resolveKanbanLinkFor } from "../Chat";
import {
  NoteField,
  OptionList,
  TaskSteps,
  WhyField,
  askOffersOwnWords,
  type AskProblems,
} from "./AnswerParts";
import { AskBlocks, AskMediaViewer, BlockPicture, useAskMedia } from "./AskBlocks";
import { FieldRow } from "./AskFields";
import { ActionDetails, AskFacts, ChangeViewer, DiffText, DraftPart } from "./AskParts";
import {
  useAsk,
  useAskScope,
  useAskSecretsHeld,
  useAskWhereabouts,
  useLateStanding,
  useOwnerStanding,
  useWatchAsks,
} from "./askStore";
import {
  askKeyFromParams,
  askNeighbours,
  askParamsFromKey,
  askStatePills,
  askTurn,
  type AskTurn,
  missingAskWords,
  type NeedsYouAskParams,
  ownerStandingBarText,
  type OwnerStanding,
} from "./logic";
import { useNeedsYouNav } from "./nav";
import { Screen, useBottomInset } from "./Screen";
import { HandOverSheet, SnoozePickSheet, snoozeMenuItem } from "./sheets";
import {
  ActionRow,
  AskToastBar,
  Band,
  BarButton,
  Heading,
  Label,
  OwnerBand,
  OfflineBand,
  Pill,
  tapDone,
  tapProblem,
} from "./ui";
import { useQueue } from "./useQueue";

/** One ask, whole: what it says, what it shows, his answer, and the bar to send it. */
export function AskRouteScreen({ route }: StaticScreenProps<NeedsYouAskParams | undefined>) {
  const { asks, serial } = useAskScope();
  const navigation = useNavigation();
  const nav = useNeedsYouNav();
  const nowMs = useNowMs();
  const bottomInset = useBottomInset();
  useWatchAsks(true);
  useOwnerStanding();
  const queue = useQueue(nowMs);
  const key = askKeyFromParams(route.params);
  const entry = key === null ? undefined : queue.entries.get(key);
  const item = key === null ? undefined : queue.items.get(key);
  // Open, but not readable by this build: it is not closed, and must not be said to be.
  const unreadable = useAsk((state) =>
    key === null ? undefined : state.unreadable.find((ask) => askUnreadableKey(ask) === key),
  );

  useEffect(() => {
    asks.noteAskFocus(key);
    return () => asks.noteAskFocus(null);
  }, [asks, key]);

  const toast = (bar: number) => (
    <AskToastBar
      bottom={bottomInset + bar}
      onUndo={(undone) => {
        if (undone === null || undone === key) return;
        if (undone.startsWith("batch:")) nav.back();
        else navigation.setParams(askParamsFromKey(undone) ?? {});
      }}
    />
  );

  // Not among the open asks once they are read: closed, or never there. It is asked for by
  // itself, so "closed" is said only of an ask known to have closed.
  const absent = key !== null && queue.read && entry === undefined && unreadable === undefined;
  const whereabouts = useAskWhereabouts(key, absent);

  if (key === null || entry === undefined || item === undefined) {
    // Not in the open asks: still loading, unreachable, or answered and gone.
    const loading =
      (!queue.read && (queue.status === "idle" || queue.status === "loading")) ||
      (absent && whereabouts.where === "looking");
    const missing =
      absent && whereabouts.where !== "looking" ? missingAskWords(whereabouts.where) : null;
    return (
      <Screen title="Ask" onBack={nav.back}>
        <View className="flex-1 gap-3 px-4 pt-4">
          {loading ? (
            <LoadingLine />
          ) : !queue.read ? (
            <Band
              tone="negative"
              action={{ label: "Retry", onPress: () => void asks.refreshAsks() }}
            >
              Couldn't load asks. {queue.error ?? ""}
            </Band>
          ) : (
            <>
              <OfflineBand />
              <View className="gap-1 pt-4">
                <Text accessibilityRole="header" className="text-xl font-t3-semibold">
                  {key === null
                    ? "This link opens no ask"
                    : unreadable
                      ? "This ask can't be shown in this version of Robob"
                      : (missing?.title ?? "This ask can't be opened")}
                </Text>
                <Text className="text-base text-foreground-muted">
                  {key === null
                    ? "It names no card or ask."
                    : unreadable
                      ? "It is still open. Open its card to read it there."
                      : (missing?.detail ?? "It is not among the open asks.")}
                </Text>
              </View>
              <View className="flex-row flex-wrap gap-2">
                {missing?.retry ? (
                  <BarButton
                    tone="primary"
                    label="Check again"
                    onPress={() => {
                      whereabouts.retry();
                      void asks.refreshAsks();
                    }}
                  />
                ) : null}
                {unreadable && unreadable.boardId !== null && unreadable.cardId !== null ? (
                  <BarButton
                    tone="primary"
                    label="Open the card"
                    onPress={() => nav.openCard(unreadable.boardId!, unreadable.cardId!)}
                  />
                ) : null}
                <BarButton label="Needs you" onPress={nav.openQueue} />
                <BarButton label="See what you answered" onPress={nav.openHistory} />
              </View>
            </>
          )}
        </View>
        {toast(8)}
      </Screen>
    );
  }

  const sections = needsYouSections(
    queue.needsYou,
    EMPTY_NEEDS_YOU_FILTER,
    queue.boardNames,
    new Map(Object.entries(queue.marks)),
    queue.hidden,
  );
  const steps = askNeighbours(needsYouFocusOrder(sections, queue.allBatches), key);
  const step = (to: string | null) => {
    const params = to === null ? null : askParamsFromKey(to);
    if (params !== null) navigation.setParams(params);
  };
  return (
    <OpenAsk
      // A new server is a new ask, even under the same card and ask id: what
      // he typed for the old one, secrets included, does not carry over.
      key={`${serial}:${key}`}
      entry={entry}
      item={item}
      nowMs={nowMs}
      bottomInset={bottomInset}
      previous={steps.previous}
      next={steps.next}
      onStep={step}
      toast={toast}
    />
  );
}

function OpenAsk(props: {
  readonly entry: KanbanAskFeedItem;
  readonly item: NeedsYouItem;
  readonly nowMs: number;
  readonly bottomInset: number;
  readonly previous: string | null;
  readonly next: string | null;
  readonly onStep: (key: string | null) => void;
  readonly toast: (bar: number) => ReactNode;
}) {
  // The store and the server calls of the server this ask was read from: an
  // answer or a secret started here can go nowhere else.
  const { asks, api: askApi } = useAskScope();
  const late = useLateStanding();
  const { entry, item, nowMs } = props;
  const nav = useNeedsYouNav();
  const key = askKey(entry);
  const turn = askTurn(entry, item);
  const detail = useAsk((state) => state.details[`${key}@${entry.revision}`]);
  const detailError = useAsk((state) => state.detailErrors[`${key}@${entry.revision}`]);
  const ask = detail ?? entry.ask;
  // The stored form, or a fresh one: a selector must not build a new object per read.
  const storedForm = useAsk((state) => state.forms[key]);
  const form = storedForm ?? askFormFor(entry.ask);
  const tried = useAsk((state) => state.tried[key] === true);
  const refused = useAsk((state) => state.refused[key]);
  const marks = useAsk((state) => state.marks);
  const mark = needsYouMarkOf(item, marks);
  const failed = useAsk((state) => state.failed[key]);
  const { standing } = useOwnerStanding();
  const previous = useAsk((state) => state.previous[key]);
  const changeView = useAsk((state) => state.changeView);
  const [noteOpen, setNoteOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [handOpen, setHandOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const response = kanbanAskResponse(ask);
  const refusal = askRefusal(response);
  // Not known to be his own device (not yet, or not at all): everything reads,
  // nothing can be filled in or sent.
  const readOnly = standing !== "owner";
  const locked = turn === "evaluator" || turn === "expired" || readOnly;
  const resolveKanbanLink = resolveKanbanLinkFor(entry.boardId);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const answerY = useRef(0);

  // The feed carries big blocks as stubs: read the ask whole once it is open.
  const needsDetail = detail === undefined && askNeedsDetail(entry.ask);
  useEffect(() => {
    if (needsDetail) void asks.loadAskDetail(entry).catch(() => undefined);
  }, [asks, needsDetail, entry]);

  // What was new on the ask counts as seen once he moves on from it.
  useEffect(() => () => asks.seeAsk(key), [asks, key]);

  // Secret values live here and nowhere else: gone when he sends, and when he leaves the ask.
  const [secrets, setSecrets] = useState<Readonly<Record<string, string>>>({});
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  // Nothing of the answer can be changed: not his to answer now, or it is on its way.
  const frozen = locked || secretBusy;
  // The server changed: secrets are cleared before anything else is dropped.
  const dropSecrets = useCallback(() => setSecrets({}), []);
  useAskSecretsHeld(dropSecrets);

  const media = useAskMedia(ask);
  const changes = kanbanAskChanges(ask);
  // Blocks a field or an option already draws are not drawn a second time.
  const optionPictures = (response.choose?.options ?? []).flatMap((option) =>
    option.block !== undefined && media.pictureOf.has(option.block) ? [option.block] : [],
  );
  const placed = new Set<number>([
    ...response.fields.flatMap((field) => (field.block === undefined ? [] : [field.block])),
    ...optionPictures,
  ]);

  const built = buildAskAnswer(
    ask,
    askFormWithSecrets(ask, form, secrets),
    form.refusing ? "refuse" : "primary",
    kanbanAskRevision(ask),
  );
  const problems: AskProblems = {
    ...(tried && !built.ok ? built.problems : {}),
    ...refused,
  };

  const canEditDraft =
    ask.draft !== undefined && response.edit === "draft" && !frozen && !form.refusing;
  const toAnswer = () => {
    scroll.current?.scrollTo({ y: Math.max(0, answerY.current - 16), animated: true });
  };
  const stopped = (text: string | undefined) => {
    tapProblem();
    toAnswer();
    if (text) AccessibilityInfo.announceForAccessibility(text);
  };
  // To a screen that shows the toast: Undo has to be reachable wherever this ask was opened from.
  const leave = () => {
    tapDone();
    nav.leave();
  };

  // An answer that carries a secret is not held for Undo and never queued: it
  // goes at once, over the private channel, and the typed value is dropped as
  // it leaves.
  const sendSecrets = async (input: AskSecretAnswerInput, label: string) => {
    setSecretBusy(true);
    setSecretError(null);
    setSecrets({});
    const outcome = await askApi.answerSecrets(
      { ...input, cardId: entry.cardId },
      kanbanAskRevision(ask),
    );
    // He may have left, opened something on top, or changed server while it was away.
    const standing = late();
    // The server it went to is no longer in use: nothing of it is on screen to act on.
    if (standing === "gone") return;
    setSecretBusy(false);
    if (outcome._tag === "sent") {
      asks.noteAskAnswered(entry, input.answer, label);
      // Only the ask in front goes back: from anywhere else it would close another screen.
      if (standing === "here") leave();
      return;
    }
    if (outcome._tag === "interrupted") return;
    const { failure } = outcome;
    if (failure.notOwner) {
      // Not his own session: said once for every ask, and not something to send again.
      asks.noteAskNotOwner(failure.message, failure.notOwner.device);
      return;
    }
    setSecretError(failure.message);
    if (failure.stale) asks.noteAskStale(entry);
    if (standing === "here") stopped(failure.message);
    // He is elsewhere: say it where he is, since the ask's own line is out of sight.
    else asks.showAskToast({ text: `Answer not sent. ${failure.message}` }, 9_000);
  };
  // Words alone never close a pick he has to make: they go to its agent as a reply and the ask stays open.
  const sendWordsAsReply = (words: string) => {
    void asks.replyOnAsk(entry, [{ _tag: "md", text: words }]).then(
      () => {
        asks.patchAskForm(entry, { ownWords: "" });
        asks.showAskToast({ text: "Sent as a reply. The ask stays open." });
      },
      (error: unknown) =>
        asks.showAskToast({ text: `Reply not sent. ${askFailureText(error)}` }, 9_000),
    );
  };
  const send = (intent: "primary" | "refuse") => {
    if (locked || secretBusy) return;
    const words = intent === "primary" ? askWordsForReply(ask, form) : null;
    if (words !== null) return sendWordsAsReply(words);
    const now = buildAskAnswer(
      ask,
      askFormWithSecrets(ask, form, secrets),
      intent,
      kanbanAskRevision(ask),
    );
    if (!now.ok) {
      asks.markAskTried(entry);
      stopped(now.problems[now.first]);
      return;
    }
    const input = askSecretAnswerInput(entry.cardId, ask, now.body, secrets);
    if (input !== null) {
      void sendSecrets(input, now.label);
      return;
    }
    const result = asks.answerAsk({ ...entry, ask }, intent);
    if (result.ok) leave();
    else stopped(undefined);
  };
  const snoozeUntil = (until: SnoozeUntil) => {
    if (readOnly) return;
    nav.leave();
    void asks.snoozeAsks([entry], until.iso, until.label);
  };
  const primary = () => send(form.refusing ? "refuse" : "primary");
  const refuse = () => {
    if (frozen || refusal === null) return;
    if (refusal.why === "none" || form.refusing) return send("refuse");
    asks.patchAskForm(entry, { refusing: true });
    toAnswer();
  };
  const canTalk = (turn === "owner" || turn === "agent") && !readOnly;
  const canNote = canTalk && !response.ack;

  const title = ask.title ?? entry.cardTitle;
  const plain = response.fields.length === 1 && isPlainAnswerField(ask, response.fields[0]!);
  const showNote = canNote && (noteOpen || form.note !== "");
  const said = askDiscussion(entry).length;
  const hasAnswerParts =
    response.choose !== null ||
    response.fields.length > 0 ||
    form.refusing ||
    showNote ||
    response.task !== null;
  const canHand = canTalk && !response.ack && response.task === null && ask.to !== "evaluator";
  const pills = askStatePills({ entry, item, turn, mark, nowMs });
  const openCard = () => nav.openCard(entry.boardId, entry.cardId);

  const more: ReadonlyArray<AppBarMenuItem> = [
    { id: "card", title: `Open card #${entry.cardNumber}`, icon: "doc.text", onPress: openCard },
    ...(canNote && !showNote
      ? [
          {
            id: "note",
            title: "Add a note for the agent",
            icon: "square.and.pencil",
            onPress: () => {
              setNoteOpen(true);
              toAnswer();
            },
          },
        ]
      : []),
    ...(canEditDraft && !editing
      ? [
          {
            id: "draft",
            title: "Edit the draft",
            icon: "pencil",
            onPress: () => setEditing(true),
          },
        ]
      : []),
    ...(readOnly
      ? []
      : item.snoozed
        ? [
            {
              id: "back",
              title: "Bring back",
              icon: "arrow.uturn.backward",
              onPress: () => void asks.snoozeAsks([entry], null, ""),
            },
          ]
        : [snoozeMenuItem({ nowMs, onSnooze: snoozeUntil, onPick: () => setPickOpen(true) })]),
  ];

  return (
    <Screen
      title={`${entry.boardName} #${entry.cardNumber}`}
      onBack={nav.back}
      actions={[
        {
          accessibilityLabel: "Previous ask",
          icon: "chevron.up",
          disabled: props.previous === null,
          onPress: () => props.onStep(props.previous),
        },
        {
          accessibilityLabel: "Next ask",
          icon: "chevron.down",
          disabled: props.next === null,
          onPress: () => props.onStep(props.next),
        },
      ]}
      menus={[{ title: "More", icon: "ellipsis.circle", items: more }]}
    >
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerClassName="gap-5 px-4 pb-8 pt-4"
      >
        <View className="gap-2.5">
          <Text className="text-sm text-foreground-muted">
            {askKindLabel(entry.kind)} · {askAsker(entry).replace(/^the /, "")} ·{" "}
            {askAge(item.ageMs)}
          </Text>
          {pills.length > 0 ? (
            <View className="flex-row flex-wrap gap-1.5">
              {pills.map((pill) => (
                <Pill key={pill.key} label={pill.label} tone={pill.tone} />
              ))}
            </View>
          ) : null}
          {turn === "agent" && askRepliedOnCard(entry) ? (
            <Text className="text-sm text-foreground-muted">
              You replied in the card's discussion; the agent is reading it.
            </Text>
          ) : null}
          <Text accessibilityRole="header" className="text-xl font-t3-semibold text-foreground">
            {title}
          </Text>
        </View>

        <OwnerBand />
        <OfflineBand />
        {detailError !== undefined && detail === undefined ? (
          // Its big parts did not load: said here, on this ask, and the rest of it still reads.
          <Band
            tone="negative"
            action={{
              label: "Retry",
              onPress: () => void asks.loadAskDetail(entry).catch(() => undefined),
            }}
          >
            Couldn't read all of this ask. {detailError}
          </Band>
        ) : null}
        {failed ? (
          <Band
            tone="negative"
            action={
              readOnly ? undefined : { label: "Retry", onPress: () => asks.retryAskSend(key) }
            }
          >
            Not sent. {failed.message}
            {failed.unreached
              ? askAutoRetryOwed({ failed: { [key]: failed } })
                ? " Your answer is kept and goes again once Robob is back."
                : " Your answer is kept. It no longer goes by itself: retry when Robob is back."
              : ""}
          </Band>
        ) : null}
        {secretError ? <Band tone="negative">{secretError}</Band> : null}
        {mark === "back" && item.backFromSnoozeAt ? (
          <Band tone="accent">
            Back from snooze.{" "}
            {ask.backFromSnoozeAt
              ? `Its agent changed it or replied, ${shortWhen(ask.backFromSnoozeAt, nowMs)}.`
              : `You set this aside until ${shortWhen(item.backFromSnoozeAt, nowMs)}.`}
          </Band>
        ) : null}
        {mark === "updated" ? (
          <Band tone="accent">
            Its agent changed this ask{ask.revisionNote ? `: ${ask.revisionNote}` : "."} What you
            typed is kept.
            {previous && previous.text !== ask.text ? "\n" : ""}
            {previous && previous.text !== ask.text ? (
              <DiffText
                before={previous.text}
                after={ask.text}
                side="both"
                className="text-sm leading-5"
              />
            ) : null}
          </Band>
        ) : null}
        {turn === "evaluator" && ask.handedThreadId ? (
          <Band
            tone="accent"
            action={{
              label: "Open thread",
              onPress: () => nav.openThread(ask.handedThreadId!),
            }}
          >
            Handed over with your words.
          </Band>
        ) : null}
        {turn === "expired" ? (
          <Band tone="warn">
            The facts changed since this was asked{ask.basis ? ` (${ask.basis})` : ""}. Its agent
            has to refresh it first.
          </Band>
        ) : null}

        {ask.title === undefined || (ask.text.trim() !== "" && ask.text !== ask.title) ? (
          <Text selectable className="text-base font-t3-medium text-foreground">
            {ask.text}
          </Text>
        ) : null}
        {ask.context ? (
          <View className="-mt-2">
            <MarkdownText
              text={ask.context}
              maxLines={null}
              resolveKanbanLink={resolveKanbanLink}
            />
          </View>
        ) : null}

        {ask.action ? (
          <ActionDetails action={ask.action} resolveKanbanLink={resolveKanbanLink} />
        ) : null}
        {changes.length > 0 ? (
          <ChangeViewer changes={changes} view={changeView} resolveKanbanLink={resolveKanbanLink} />
        ) : null}
        <AskBlocks
          boardId={entry.boardId}
          ask={ask}
          media={media}
          skip={placed}
          onOpenMedia={setViewing}
          onOpenCard={(cardId) => nav.openCard(entry.boardId, cardId)}
        />

        {ask.draft ? (
          <DraftPart
            entry={entry}
            draft={ask.draft}
            form={form}
            editable={canEditDraft}
            editing={editing}
            onEditing={setEditing}
            problem={problems.draft}
            resolveKanbanLink={resolveKanbanLink}
          />
        ) : null}

        {hasAnswerParts ? (
          <View
            accessibilityLabel={response.task ? "Your part" : "Your answer"}
            className="gap-4"
            onLayout={(event) => {
              answerY.current = event.nativeEvent.layout.y;
            }}
          >
            <Heading>{response.task ? "Your part" : "Your answer"}</Heading>
            {response.task && response.task.steps.length > 0 ? (
              <TaskSteps entry={entry} steps={response.task.steps} form={form} disabled={frozen} />
            ) : null}
            {response.choose ? (
              <OptionList
                entry={entry}
                choose={response.choose}
                ownWords={askOffersOwnWords(response)}
                form={form}
                problem={problems.choose}
                disabled={frozen || form.refusing}
                renderBlock={(index) => (
                  <BlockPicture bare media={media} index={index} onOpen={setViewing} />
                )}
              />
            ) : null}
            {response.fields.length > 0 && !form.refusing ? (
              <View className="gap-4">
                {response.fields.map((field) => (
                  <FieldRow
                    key={field.id}
                    entry={entry}
                    ask={ask}
                    field={field}
                    value={form.values[field.id]}
                    required={field.required === true || response.task?.proof === field.id}
                    problem={problems[`field:${field.id}`]}
                    bare={plain}
                    disabled={frozen}
                    secret={secrets[field.id] ?? ""}
                    onSecret={(value) => {
                      setSecretError(null);
                      setSecrets((current) => ({ ...current, [field.id]: value }));
                    }}
                  />
                ))}
              </View>
            ) : null}
            {form.refusing ? (
              <WhyField
                entry={entry}
                response={response}
                form={form}
                problem={problems.why}
                disabled={frozen}
              />
            ) : null}
            {showNote ? (
              <NoteField
                entry={entry}
                form={form}
                problem={problems.note}
                disabled={frozen}
                autoFocus={noteOpen && form.note === ""}
              />
            ) : null}
          </View>
        ) : null}

        <AskFacts entry={entry} item={item} onOpenCard={openCard} />

        {canHand ? (
          <View className="gap-1.5">
            <Label>Fewer like this</Label>
            {askRequiresSecret(ask) ? (
              <Text className="text-sm text-foreground-muted">
                It needs a secret only you can give, so it can't go to the evaluator.
              </Text>
            ) : (
              <View className="overflow-hidden rounded-2xl bg-card">
                <ActionRow
                  label="Evaluator decides this one"
                  onPress={() => {
                    if (readOnly) return;
                    nav.leave();
                    asks.handAsks([entry], key);
                  }}
                />
                <View className="ml-3.5 h-px bg-border" />
                <ActionRow
                  label="…and ones like this from now on"
                  onPress={() => setHandOpen(true)}
                />
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>

      <AskBar
        turn={turn}
        standing={standing}
        refusing={form.refusing}
        primaryLabel={askPrimaryLabel(ask, form)}
        refusalLabel={refusal?.label ?? null}
        busy={secretBusy}
        said={said}
        bottomInset={props.bottomInset}
        onDiscussion={() => nav.openDiscussion(key)}
        onPrimary={primary}
        onRefuse={refuse}
        onBack={() => asks.patchAskForm(entry, { refusing: false })}
        onTakeBack={() => {
          if (!readOnly) void asks.takeBackAsk(entry);
        }}
        onRefresh={() =>
          void asks
            .replyOnAsk(entry, [
              {
                _tag: "md",
                text: "This ask is out of date. Please refresh it with the current facts.",
              },
            ])
            .then(
              () => asks.showAskToast({ text: "Asked its agent for a refresh." }),
              (error: unknown) =>
                asks.showAskToast({
                  text: `Couldn't ask for a refresh. ${askFailureText(error)}`,
                }),
            )
        }
      />
      {props.toast(76)}
      <AskMediaViewer media={media} viewing={viewing} onClose={() => setViewing(null)} />
      {handOpen && !readOnly ? (
        <HandOverSheet entries={[entry]} onClose={() => setHandOpen(false)} onLeave={nav.leave} />
      ) : null}
      {pickOpen && !readOnly ? (
        <SnoozePickSheet onClose={() => setPickOpen(false)} onSnooze={snoozeUntil} />
      ) : null}
    </Screen>
  );
}

/**
 * The bar under an ask: the talk with its agent, the "no" in the ask's own
 * word, and one filled button for the answer the form holds.
 */
function AskBar(props: {
  readonly turn: AskTurn;
  readonly standing: OwnerStanding;
  readonly refusing: boolean;
  readonly primaryLabel: string;
  readonly refusalLabel: string | null;
  readonly busy: boolean;
  readonly said: number;
  readonly bottomInset: number;
  readonly onDiscussion: () => void;
  readonly onPrimary: () => void;
  readonly onRefuse: () => void;
  readonly onBack: () => void;
  readonly onTakeBack: () => void;
  readonly onRefresh: () => void;
}) {
  const discussion = (
    <BarButton
      label={props.said > 0 ? String(props.said) : ""}
      accessibilityLabel={`Discussion, ${props.said} ${props.said === 1 ? "message" : "messages"}`}
      icon="bubble.left"
      onPress={props.onDiscussion}
    />
  );
  const state = (text: string) => (
    // As many lines as it takes: at the largest text sizes two lines cut it off.
    <Text className="min-w-0 flex-1 text-sm text-foreground-muted">{text}</Text>
  );
  return (
    <View
      className="flex-row items-center gap-2 border-t border-border bg-screen px-3 pt-2.5"
      style={{ paddingBottom: props.bottomInset }}
    >
      {props.standing !== "owner" ? (
        <>
          {discussion}
          {state(ownerStandingBarText(props.standing, "answer"))}
        </>
      ) : props.turn === "evaluator" ? (
        <>
          {discussion}
          {state("With the evaluator")}
          <BarButton label="Take it back" onPress={props.onTakeBack} />
        </>
      ) : props.turn === "expired" ? (
        <>
          {discussion}
          {state("Out of date")}
          <BarButton label="Ask for a refresh" tone="primary" onPress={props.onRefresh} />
        </>
      ) : props.refusing ? (
        <>
          <BarButton label="Back" disabled={props.busy} onPress={props.onBack} />
          <BarButton
            grow
            tone="primary"
            label={props.busy ? "Sending…" : props.primaryLabel}
            busy={props.busy}
            onPress={props.onPrimary}
          />
        </>
      ) : (
        <>
          {discussion}
          {props.refusalLabel ? (
            <BarButton
              limit
              label={props.refusalLabel}
              disabled={props.busy}
              onPress={props.onRefuse}
            />
          ) : null}
          <BarButton
            grow
            tone="primary"
            label={props.busy ? "Sending…" : props.primaryLabel}
            busy={props.busy}
            onPress={props.onPrimary}
          />
        </>
      )}
    </View>
  );
}
