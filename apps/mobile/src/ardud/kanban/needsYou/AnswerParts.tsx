/**
 * The parts of an answer, drawn from what the ask takes back
 * (`kanbanAskResponse`), never from its kind.
 */
import {
  askRefusal,
  askWordsForReply,
  type AskForm,
  type AskProblemKey,
} from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem, KanbanAskResponse, KanbanAskTaskStep } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { useAsks } from "./askStore";
import { stepWebLink } from "./logic";
import { Check, FieldLabel, GrowingInput, Pill, Problem, tapSelection } from "./ui";

export type AskProblems = Readonly<Partial<Record<AskProblemKey, string>>>;

/** Whether "Your own answer" is offered beside the options. */
export const askOffersOwnWords = (response: KanbanAskResponse): boolean =>
  response.choose !== null && !response.choose.multi && response.verdict === null;

const pickHint = (choose: NonNullable<KanbanAskResponse["choose"]>): string =>
  choose.min === choose.max
    ? `Pick ${choose.max}`
    : choose.min > 0
      ? `Pick ${choose.min} to ${choose.max}`
      : `Pick up to ${choose.max}`;

/** One option as a full-width row: picked is the accent band with a ring. */
export function OptionRow(props: {
  readonly label: string;
  readonly detail?: string | undefined;
  readonly consequence?: string | undefined;
  readonly recommended?: boolean | undefined;
  readonly checked: boolean;
  readonly multi: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly picture?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole={props.multi ? "checkbox" : "radio"}
      accessibilityState={{ checked: props.checked, disabled: props.disabled }}
      accessibilityLabel={[
        props.label,
        props.recommended ? "recommended" : null,
        props.detail,
        props.checked ? props.consequence : null,
      ]
        .filter(Boolean)
        .join(", ")}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-12 gap-2 rounded-xl border-2 px-3.5 py-3",
        props.checked ? "border-primary bg-inline-skill-background" : "border-border bg-screen",
        props.disabled && !props.checked && "opacity-50",
      )}
    >
      {props.picture ? <View className="overflow-hidden rounded-lg">{props.picture}</View> : null}
      <View className="flex-row items-start gap-3">
        <View className="pt-px">
          <Check checked={props.checked} round={!props.multi} />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
          {props.recommended ? <Pill label="Recommended" tone="accent" /> : null}
          {props.detail ? (
            <Text className="text-sm text-foreground-muted">{props.detail}</Text>
          ) : null}
          {props.checked && props.consequence ? (
            <View className="flex-row items-start gap-1.5">
              <View className="pt-[3px]">
                <SymbolView
                  name="arrow.right"
                  size={11}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
              </View>
              <Text className="min-w-0 flex-1 text-sm text-foreground">{props.consequence}</Text>
            </View>
          ) : null}
          {props.children}
        </View>
      </View>
    </Pressable>
  );
}

/** Options to pick from: one, or several within the ask's limits. */
export function OptionList(props: {
  readonly entry: KanbanAskFeedItem;
  readonly choose: NonNullable<KanbanAskResponse["choose"]>;
  readonly ownWords: boolean;
  readonly form: AskForm;
  readonly problem: string | undefined;
  readonly disabled: boolean;
  /** A picture an option points at, drawn inside it. */
  readonly renderBlock?: ((index: number) => ReactNode) | undefined;
}) {
  const asks = useAsks();
  const { entry, choose, form } = props;
  const [ownOpen, setOwnOpen] = useState(false);
  const own = props.ownWords && (ownOpen || form.ownWords !== "");
  const full = choose.multi && form.optionIds.length >= choose.max;

  const toggle = (id: string) => {
    tapSelection();
    if (!choose.multi) {
      setOwnOpen(false);
      asks.patchAskForm(entry, { optionIds: form.optionIds[0] === id ? [] : [id], ownWords: "" });
      return;
    }
    const picked = form.optionIds.includes(id);
    if (!picked && form.optionIds.length >= choose.max) return;
    asks.patchAskForm(entry, {
      optionIds: picked ? form.optionIds.filter((other) => other !== id) : [...form.optionIds, id],
    });
  };

  return (
    <View className="gap-2">
      {choose.multi ? (
        <Text className="text-sm text-foreground-muted">{pickHint(choose)}</Text>
      ) : null}
      <View
        accessibilityRole={choose.multi ? undefined : "radiogroup"}
        accessibilityLabel="Options"
        className="gap-2"
      >
        {choose.options.map((option) => {
          const checked = !own && form.optionIds.includes(option.id);
          return (
            <OptionRow
              key={option.id}
              label={option.label}
              detail={option.detail}
              consequence={option.consequence}
              recommended={option.recommended}
              checked={checked}
              multi={choose.multi}
              disabled={props.disabled || (full && !checked)}
              onPress={() => toggle(option.id)}
              picture={
                option.block !== undefined && props.renderBlock
                  ? props.renderBlock(option.block)
                  : undefined
              }
            />
          );
        })}
        {props.ownWords ? (
          <OptionRow
            label="Your own answer"
            checked={own}
            multi={false}
            disabled={props.disabled}
            onPress={() => {
              tapSelection();
              if (own) {
                setOwnOpen(false);
                asks.patchAskForm(entry, { ownWords: "" });
              } else {
                setOwnOpen(true);
                asks.patchAskForm(entry, { optionIds: [] });
              }
            }}
          >
            {own ? (
              <View className="gap-1.5 pt-1">
                <GrowingInput
                  autoFocus={ownOpen && form.ownWords === ""}
                  accessibilityLabel="Your own answer"
                  placeholder="Type your answer"
                  value={form.ownWords}
                  maxLength={20_000}
                  editable={!props.disabled}
                  onChangeText={(ownWords) => asks.patchAskForm(entry, { ownWords })}
                  className="bg-screen"
                />
                {askWordsForReply(entry.ask, form) !== null ? (
                  <Text className="text-2xs text-foreground-muted">
                    Words alone don't answer this one. They go to the agent as a reply and the ask
                    stays open.
                  </Text>
                ) : null}
              </View>
            ) : null}
          </OptionRow>
        ) : null}
      </View>
      {props.problem ? <Problem>{props.problem}</Problem> : null}
    </View>
  );
}

/** After a "no": what is wrong, in his words. */
export function WhyField(props: {
  readonly entry: KanbanAskFeedItem;
  readonly response: KanbanAskResponse;
  readonly form: AskForm;
  readonly problem: string | undefined;
  readonly disabled: boolean;
}) {
  const asks = useAsks();
  const refusal = askRefusal(props.response);
  if (refusal === null) return null;
  return (
    <View className="gap-1.5">
      <FieldLabel
        label={refusal.prompt}
        aside={refusal.why === "optional" ? "Optional" : undefined}
      />
      <GrowingInput
        autoFocus={!props.disabled}
        accessibilityLabel={refusal.prompt}
        editable={!props.disabled}
        invalid={props.problem !== undefined}
        value={props.form.why}
        maxLength={20_000}
        onChangeText={(why) => asks.patchAskForm(props.entry, { why })}
      />
      {props.problem ? <Problem>{props.problem}</Problem> : null}
    </View>
  );
}

/** A note that rides along with the answer to the agent that acts on it. Never saved as a rule. */
export function NoteField(props: {
  readonly entry: KanbanAskFeedItem;
  readonly form: AskForm;
  readonly problem: string | undefined;
  readonly disabled: boolean;
  readonly autoFocus?: boolean;
}) {
  const asks = useAsks();
  return (
    <View className="gap-1.5">
      <FieldLabel label="Note for the agent" aside="Goes with your answer" />
      <GrowingInput
        autoFocus={props.autoFocus}
        accessibilityLabel="Note for the agent"
        editable={!props.disabled}
        invalid={props.problem !== undefined}
        value={props.form.note}
        onChangeText={(note) => asks.patchAskForm(props.entry, { note })}
      />
      {props.problem ? <Problem>{props.problem}</Problem> : null}
    </View>
  );
}

/** Steps he does himself. Ticking them is for his own count; nothing is sent until Done. */
export function TaskSteps(props: {
  readonly entry: KanbanAskFeedItem;
  readonly steps: ReadonlyArray<KanbanAskTaskStep>;
  readonly form: AskForm;
  readonly disabled: boolean;
}) {
  const asks = useAsks();
  const { entry, form } = props;
  return (
    <View className="gap-1">
      {props.steps.map((step, index) => {
        const link = stepWebLink(step.link);
        const done = form.steps.includes(index);
        return (
          // oxlint-disable-next-line react/no-array-index-key -- An ask's steps never reorder.
          <View key={index} className="gap-0.5">
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: done, disabled: props.disabled }}
              accessibilityLabel={`Step ${index + 1} of ${props.steps.length}, ${step.text}`}
              disabled={props.disabled}
              onPress={() => {
                tapSelection();
                asks.patchAskForm(entry, {
                  steps: done
                    ? form.steps.filter((other) => other !== index)
                    : [...form.steps, index],
                });
              }}
              className="min-h-11 flex-row items-start gap-3 py-2.5"
            >
              <Check checked={done} />
              <Text
                className={cn(
                  "min-w-0 flex-1 text-base",
                  done ? "text-foreground-muted" : "text-foreground",
                )}
              >
                {step.text}
              </Text>
            </Pressable>
            {link !== null ? (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`Open ${link.host}`}
                onPress={() => void tryOpenExternalUrl(link.url, "markdown-link")}
                className="ml-[34px] min-h-11 flex-row items-center gap-1.5 self-start"
              >
                <SymbolView
                  name="arrow.up.right"
                  size={12}
                  tintColorClassName="accent-primary-text"
                  type="monochrome"
                />
                <Text className="text-sm font-t3-medium text-primary-text">Open {link.host}</Text>
              </Pressable>
            ) : step.link ? (
              // Not a web address: shown as it is written, and it opens nothing.
              <Text selectable className="ml-[34px] text-sm text-foreground-muted">
                {step.link}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
