/**
 * "What an ask can be": every part an ask can show and every part he can give
 * back, drawn by the phone's own parts from sample asks, beside the words
 * agents are given about asking.
 */
import {
  ASK_REFERENCE_KINDS,
  ASK_REFERENCE_MOST_USED,
  ASK_REFERENCE_TOLD,
  SAMPLE_ACTION,
  SAMPLE_CHANGES,
  SAMPLE_CHART_PAGE,
  SAMPLE_CHOOSE,
  SAMPLE_DRAFT,
  SAMPLE_FILL,
  SAMPLE_TASK,
  askFieldKind,
  askFormFor,
  askKey,
  type AskForm,
  type AskReferenceMatch,
} from "@t3tools/client-runtime/ardud/kanban";
import { kanbanAskResponse, type KanbanAskFeedItem } from "@t3tools/contracts";
import { type ReactNode, useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { MarkdownText } from "../../common/MarkdownText";
import { Collapse } from "../Chat";
import { OptionList, TaskSteps } from "./AnswerParts";
import { AskHtml } from "./AskBlocks";
import { FieldRow } from "./AskFields";
import { ActionDetails, ChangeViewer, DraftPart } from "./AskParts";
import { useAsk, useAskScope, useAskSecretsHeld } from "./askStore";
import { useNeedsYouNav } from "./nav";
import { Screen, useBottomInset } from "./Screen";
import { BarButton, Label } from "./ui";

const NO_LINKS = () => null;

const useSampleForm = (entry: KanbanAskFeedItem): AskForm => {
  const stored = useAsk((state) => state.forms[askKey(entry)]);
  return stored ?? askFormFor(entry.ask);
};

function Section(props: {
  readonly title: string;
  readonly sub?: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-4">
      <View className="gap-0.5">
        <Text accessibilityRole="header" className="text-xl font-t3-semibold text-foreground">
          {props.title}
        </Text>
        {props.sub ? <Text className="text-sm text-foreground-muted">{props.sub}</Text> : null}
      </View>
      {props.children}
    </View>
  );
}

function Part(props: {
  readonly name: string;
  readonly how?: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2.5">
      <View className="gap-0.5">
        <Text accessibilityRole="header" className="text-base font-t3-medium text-foreground">
          {props.name}
        </Text>
        {props.how ? <Text className="text-sm text-foreground-muted">{props.how}</Text> : null}
      </View>
      {props.children}
    </View>
  );
}

/** Buttons to look at, not to press: the real ones sit in the bar under an ask. */
function Buttons(props: { readonly yes: string; readonly no?: string }) {
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel={`Buttons: ${[props.no, props.yes].filter(Boolean).join(", ")}`}
      className="flex-row gap-2"
    >
      {props.no ? <BarButton limit label={props.no} onPress={() => undefined} /> : null}
      <BarButton tone="primary" label={props.yes} onPress={() => undefined} />
    </View>
  );
}

function ChooseSample() {
  const form = useSampleForm(SAMPLE_CHOOSE);
  const choose = kanbanAskResponse(SAMPLE_CHOOSE.ask).choose;
  if (choose === null) return null;
  return (
    <OptionList
      entry={SAMPLE_CHOOSE}
      choose={choose}
      ownWords
      form={form}
      problem={undefined}
      disabled={false}
    />
  );
}

function FillSample() {
  const form = useSampleForm(SAMPLE_FILL);
  // A sample secret lives here only, like a real one lives in its reader only.
  const [secret, setSecret] = useState("");
  // Typed for a sample, but held like a real one: cleared first when the server changes.
  const dropSecret = useCallback(() => setSecret(""), []);
  useAskSecretsHeld(dropSecret);
  return (
    <View className="gap-4">
      {kanbanAskResponse(SAMPLE_FILL.ask).fields.map((entry) => (
        <FieldRow
          key={entry.id}
          entry={SAMPLE_FILL}
          ask={SAMPLE_FILL.ask}
          field={entry}
          value={form.values[entry.id]}
          required={false}
          problem={undefined}
          // A sample has no card to keep a file on.
          disabled={askFieldKind(entry) === "file"}
          secret={secret}
          onSecret={setSecret}
        />
      ))}
    </View>
  );
}

function DraftSample() {
  const form = useSampleForm(SAMPLE_DRAFT);
  const [editing, setEditing] = useState(false);
  const draft = SAMPLE_DRAFT.ask.draft;
  if (!draft) return null;
  return (
    <DraftPart
      entry={SAMPLE_DRAFT}
      draft={draft}
      form={form}
      editable
      editing={editing}
      onEditing={setEditing}
      problem={undefined}
      resolveKanbanLink={NO_LINKS}
    />
  );
}

function TaskSample() {
  const form = useSampleForm(SAMPLE_TASK);
  const task = kanbanAskResponse(SAMPLE_TASK.ask).task;
  if (task === null) return null;
  return <TaskSteps entry={SAMPLE_TASK} steps={task.steps} form={form} disabled={false} />;
}

function SeeOne(props: {
  readonly label: string;
  readonly name: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: an open ${props.name} ask`}
      hitSlop={8}
      onPress={props.onPress}
      className="min-h-11 justify-center"
    >
      <Text className="text-sm font-t3-semibold text-primary-text">{props.label}</Text>
    </Pressable>
  );
}

export function ReferenceRouteScreen() {
  // A new server starts the page over: what was typed into its samples goes with the old one.
  const { serial } = useAskScope();
  return <Reference key={serial} />;
}

function Reference() {
  const nav = useNeedsYouNav();
  const bottomInset = useBottomInset();
  const open = useAsk((state) => state.feed?.open);
  const changeView = useAsk((state) => state.changeView);
  const example = (match: AskReferenceMatch) =>
    (open ?? []).find((entry) => entry.waitsOn === "owner" && match(entry));
  return (
    <Screen title="What an ask can be" onBack={nav.back}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ padding: 16, paddingBottom: bottomInset + 24, gap: 32 }}
      >
        <Text className="text-base text-foreground">
          An ask is what it shows you and what you give back. Agents combine the parts they need,
          and the app lays them out the same way every time.
        </Text>

        <Section
          title="What you can give back"
          sub="Always in this order: steps, options, fields, then the buttons."
        >
          <Part name="Approve or reject" how="The labels can say what happens.">
            <Buttons yes="Deploy" no="Don't deploy" />
          </Part>
          <Part name="Choose" how="One or many. An option can carry a picture.">
            <ChooseSample />
          </Part>
          <Part name="Fill in" how="A small form, checked before it sends.">
            <FillSample />
          </Part>
          <Part name="Edit" how="The draft is edited in place, then approved.">
            <DraftSample />
          </Part>
          <Part name="Do it yourself" how="Steps only you can do.">
            <TaskSample />
          </Part>
          <Part name="Just seen" how="A notice. It never blocks.">
            <Buttons yes="Seen" />
          </Part>
        </Section>

        <Section title="What an ask can show" sub="Any of these, in any order.">
          <Part name="A command" how="Exactly what runs, where, the proof and the way back.">
            <ActionDetails action={SAMPLE_ACTION} resolveKanbanLink={NO_LINKS} />
          </Part>
          <Part name="Changes" how="After, Before or Changes.">
            <ChangeViewer changes={SAMPLE_CHANGES} view={changeView} resolveKanbanLink={NO_LINKS} />
          </Part>
          <Part name="Text">
            <MarkdownText
              text={"Plain words, **bold**, lists and `code`, with links to cards."}
              maxLines={null}
            />
          </Part>
          <Part name="Folded detail">
            <View className="rounded-2xl bg-card p-1">
              <Collapse
                stateKey="reference:review-notes"
                title="Review notes"
                text={"Opens in place, for what only some asks need read."}
                resolveKanbanLink={NO_LINKS}
              />
            </View>
          </Part>
          <Part name="A page" how="A chart or a table, drawn in the app's colours.">
            <AskHtml html={SAMPLE_CHART_PAGE} title="Spend this week" height={200} />
          </Part>
          <Text className="text-sm text-foreground-muted">
            Pictures open full size; recordings, PDFs and other files open in the file viewer.
          </Text>
        </Section>

        <Section
          title="Shortcuts"
          sub="Named combinations agents reach for. A new kind needs no new screen."
        >
          <View className="overflow-hidden rounded-2xl bg-card">
            {ASK_REFERENCE_KINDS.map(([name, shows, gives, match], index) => {
              const live = example(match);
              return (
                <View
                  key={name}
                  className={
                    index > 0
                      ? "flex-row items-center gap-3 border-t border-border px-3.5 py-2.5"
                      : "flex-row items-center gap-3 px-3.5 py-2.5"
                  }
                >
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-t3-medium text-foreground">{name}</Text>
                    <Text className="text-sm text-foreground-muted">{shows}</Text>
                    <Text className="text-sm text-foreground">{gives}</Text>
                  </View>
                  {live ? (
                    <SeeOne label="See one" name={name} onPress={() => nav.openAsk(askKey(live))} />
                  ) : null}
                </View>
              );
            })}
          </View>
        </Section>

        <Section title="The five most used, and what an agent fills in">
          {ASK_REFERENCE_MOST_USED.map((template) => {
            const live = example(template.match);
            return (
              <Part key={template.name} name={template.name} how={template.use}>
                <View className="gap-1.5 rounded-2xl bg-card px-3.5 py-3">
                  {template.fills.map(([what, how]) => (
                    <View key={what}>
                      <Text className="text-sm font-t3-medium text-foreground">{what}</Text>
                      <Text className="text-sm text-foreground-muted">{how}</Text>
                    </View>
                  ))}
                </View>
                <Text className="text-sm text-foreground">{template.answer}</Text>
                {live ? (
                  <SeeOne
                    label="See a real one"
                    name={template.name}
                    onPress={() => nav.openAsk(askKey(live))}
                  />
                ) : null}
              </Part>
            );
          })}
        </Section>

        <View className="gap-2.5 rounded-2xl bg-card p-4">
          <Label>What agents are told, in the card_ask tool description</Label>
          {ASK_REFERENCE_TOLD.map((sentence, index) => (
            <View key={sentence} className="flex-row gap-2.5">
              <Text className="w-5 text-right text-sm tabular-nums text-foreground-muted">
                {index + 1}
              </Text>
              <Text className="min-w-0 flex-1 text-sm text-foreground">{sentence}</Text>
            </View>
          ))}
        </View>

        <BarButton label="Back to Needs you" onPress={nav.openQueue} />
      </ScrollView>
    </Screen>
  );
}
