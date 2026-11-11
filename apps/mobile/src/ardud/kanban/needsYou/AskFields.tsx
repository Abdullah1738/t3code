/**
 * One value to fill in on an ask. The field's type picks the control; a type
 * this build does not know is drawn, checked and sent as text.
 */
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import {
  askFieldKind,
  askFieldProblem,
  askFormOf,
  localInputValue,
  type AskAnswerFile,
} from "@t3tools/client-runtime/ardud/kanban";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import type {
  EnvironmentId,
  KanbanAskFeedItem,
  KanbanAskField,
  KanbanOwnerAsk,
} from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import {
  prepareTurnAttachments,
  releasePendingAttachmentUploads,
} from "../../../lib/attachmentUpload";
import { cn } from "../../../lib/cn";
import {
  pickComposerFiles,
  pickComposerMedia,
  type DraftComposerAttachment,
} from "../../../lib/composerImages";
import { useServerConfigs } from "../../../state/entities";
import { releaseUnusedComposerAttachmentFiles } from "../../../state/use-composer-drafts";
import { AskHtml } from "./AskBlocks";
import { useAskScope, useAsks } from "./askStore";
import {
  acceptsInWords,
  acceptsOnlyMedia,
  customValueTaken,
  moveRank,
  rankOrder,
  shownValue,
} from "./logic";
import { Check, FieldLabel, GrowingInput, Pill, Problem, tapSelection } from "./ui";

const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

export function FieldRow(props: {
  readonly entry: KanbanAskFeedItem;
  /** The ask whole, for a field that shows one of its blocks. */
  readonly ask: KanbanOwnerAsk;
  readonly field: KanbanAskField;
  readonly value: unknown;
  /** Required here even when the field itself is not (a task's proof). */
  readonly required: boolean;
  /** What stopped the last send, or what the server refused. */
  readonly problem: string | undefined;
  /** The only field of a plain question: the section's heading is its label. */
  readonly bare?: boolean;
  readonly disabled: boolean;
  /** A secret field's value and its setter: held by the reader, never by the form. */
  readonly secret?: string;
  readonly onSecret?: (value: string) => void;
}) {
  const asks = useAsks();
  const { entry, field, value } = props;
  const kind = askFieldKind(field);
  // A value he has left is checked at once; an empty required one only when he sends.
  const [touched, setTouched] = useState(false);
  const problem =
    props.problem ?? (touched && !isBlank(value) ? askFieldProblem(field, value, false) : null);
  // No control of a field that can't be changed writes into the answer,
  // whatever the control itself still lets through.
  const set = (next: unknown) => {
    if (!props.disabled) asks.setAskValue(entry, field.id, next);
  };
  const text = typeof value === "string" ? value : "";
  const label = field.label || field.id;
  const invalid = problem !== null && problem !== undefined;
  const editable = !props.disabled;
  const onBlur = () => setTouched(true);

  let control: ReactNode;
  let ownLabel = false;
  switch (kind) {
    case "longtext":
      control = (
        <GrowingInput
          accessibilityLabel={props.bare ? "Your answer" : label}
          placeholder={props.bare ? "Type your answer" : undefined}
          editable={editable}
          invalid={invalid}
          value={text}
          onChangeText={set}
          onBlur={onBlur}
        />
      );
      break;
    case "number":
      control = (
        <View className="flex-row items-center gap-2.5">
          <AppTextInput
            accessibilityLabel={field.unit ? `${label}, in ${field.unit}` : label}
            keyboardType="decimal-pad"
            autoComplete="off"
            editable={editable}
            value={typeof value === "number" ? String(value) : text}
            onChangeText={set}
            onBlur={onBlur}
            className={cn(
              "min-h-12 w-36 rounded-xl bg-card text-right",
              invalid ? "border-danger-border" : "border-transparent",
            )}
            style={{ fontVariant: ["tabular-nums"] }}
          />
          {field.unit ? (
            <Text className="text-base text-foreground-muted">{field.unit}</Text>
          ) : null}
        </View>
      );
      break;
    case "date":
    case "datetime":
      control = (
        <DateControl
          label={label}
          withTime={kind === "datetime"}
          value={text}
          invalid={invalid}
          disabled={props.disabled}
          clearable={!props.required}
          onChange={(next) => {
            setTouched(true);
            set(next);
          }}
        />
      );
      break;
    case "toggle":
      ownLabel = true;
      control = (
        <View className="min-h-12 flex-row items-center gap-3 rounded-xl bg-card px-3.5 py-2">
          <Text className="min-w-0 flex-1 text-base text-foreground">{label}</Text>
          <ThemedSwitch
            accessibilityLabel={label}
            disabled={props.disabled}
            value={value === true}
            onValueChange={(next) => set(next)}
          />
        </View>
      );
      break;
    case "select":
      control = (
        <SelectControl
          field={field}
          value={value}
          label={label}
          disabled={props.disabled}
          onChange={(next) => {
            setTouched(true);
            set(next);
          }}
        />
      );
      break;
    case "rank":
      control = (
        <RankControl
          field={field}
          value={value}
          label={label}
          disabled={props.disabled}
          onChange={set}
        />
      );
      break;
    case "file":
      control = <FileControl entry={entry} field={field} value={value} disabled={props.disabled} />;
      break;
    case "secret":
      control = (
        <SecretControl
          label={label}
          value={props.secret ?? ""}
          invalid={invalid}
          disabled={props.disabled}
          onChange={(next) => {
            if (!props.disabled) props.onSecret?.(next);
          }}
        />
      );
      break;
    case "custom":
      control = (
        <CustomControl
          ask={props.ask}
          field={field}
          value={value}
          disabled={props.disabled}
          onChange={set}
        />
      );
      break;
    default:
      control = (
        <AppTextInput
          accessibilityLabel={label}
          autoComplete="off"
          editable={editable}
          value={text}
          onChangeText={set}
          onBlur={onBlur}
          className={cn(
            "min-h-12 rounded-xl bg-card",
            invalid ? "border-danger-border" : "border-transparent",
          )}
        />
      );
  }

  return (
    <View className="gap-1.5">
      {props.bare || ownLabel ? null : (
        <FieldLabel label={label} aside={props.required ? undefined : "Optional"} />
      )}
      {control}
      {field.hint ? <Text className="text-sm text-foreground-muted">{field.hint}</Text> : null}
      {problem ? <Problem>{problem}</Problem> : null}
    </View>
  );
}

const two = (value: number) => String(value).padStart(2, "0");
const dateValue = (at: Date) =>
  `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;

/** A date, or a date and time, picked with the system's own picker. */
function DateControl(props: {
  readonly label: string;
  readonly withTime: boolean;
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` in his own zone; empty when not picked. */
  readonly value: string;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly clearable: boolean;
  readonly onChange: (value: string) => void;
}) {
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  const parsed =
    props.value === "" ? null : new Date(props.withTime ? props.value : `${props.value}T12:00`);
  const at = parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed : null;
  const write = (next: Date) =>
    props.onChange(props.withTime ? localInputValue(next) : dateValue(next));
  const parts = props.withTime ? (["date", "time"] as const) : (["date"] as const);
  return (
    <View className="gap-2">
      <View
        className={cn(
          "overflow-hidden rounded-xl bg-card",
          props.invalid && "border border-danger-border",
        )}
      >
        {parts.map((part, index) => (
          <Pressable
            key={part}
            accessibilityRole="button"
            accessibilityLabel={`${props.label}, ${part === "date" ? "date" : "time"}`}
            accessibilityValue={{
              text:
                at === null
                  ? "Not picked"
                  : part === "date"
                    ? at.toLocaleDateString()
                    : at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
            }}
            accessibilityState={{ expanded: picker === part, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => {
              // The first tap gives the picker a value to start from.
              if (at === null) {
                const start = new Date();
                start.setMinutes(0, 0, 0);
                write(start);
              }
              setPicker(picker === part ? null : part);
            }}
            className={cn(
              "min-h-12 flex-row items-center justify-between gap-3 px-3.5 active:bg-card-alt",
              index > 0 && "border-t border-border",
            )}
          >
            <Text className="text-base text-foreground">{part === "date" ? "Date" : "Time"}</Text>
            <Text
              className={cn("text-base", at === null ? "text-foreground-muted" : "text-foreground")}
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {at === null
                ? "Choose"
                : part === "date"
                  ? at.toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })
                  : at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </Text>
          </Pressable>
        ))}
      </View>
      {picker !== null && at !== null && !props.disabled ? (
        <DateTimePicker
          value={at}
          mode={picker}
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onDismiss={() => setPicker(null)}
          onValueChange={(_, selected) => {
            const next = new Date(at);
            if (picker === "date") {
              next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
            } else {
              next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
            }
            write(next);
            if (Platform.OS !== "ios") setPicker(null);
          }}
        />
      ) : null}
      {props.clearable && at !== null && !props.disabled ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear ${props.label}`}
          hitSlop={8}
          onPress={() => {
            setPicker(null);
            props.onChange("");
          }}
          className="min-h-11 justify-center self-start"
        >
          <Text className="text-sm font-t3-medium text-primary-text">Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A few options are shown as pills; a long list is rows to scan down. */
function SelectControl(props: {
  readonly field: KanbanAskField;
  readonly value: unknown;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (value: unknown) => void;
}) {
  const options = props.field.options ?? [];
  const multi = props.field.multi === true;
  const picked: ReadonlyArray<unknown> = multi
    ? Array.isArray(props.value)
      ? props.value
      : []
    : [props.value];
  const toggle = (id: string, checked: boolean) => {
    tapSelection();
    props.onChange(
      multi
        ? checked
          ? picked.filter((entry) => entry !== id)
          : [...picked, id]
        : checked
          ? ""
          : id,
    );
  };
  const rows = options.length > 5;
  return (
    <View
      accessibilityRole={multi ? undefined : "radiogroup"}
      accessibilityLabel={props.label}
      className={rows ? "overflow-hidden rounded-xl bg-card" : "flex-row flex-wrap gap-2"}
    >
      {options.map((option, index) => {
        const checked = picked.includes(option.id);
        const state = { checked, disabled: props.disabled };
        return rows ? (
          <Pressable
            key={option.id}
            accessibilityRole={multi ? "checkbox" : "radio"}
            accessibilityState={state}
            accessibilityLabel={option.label}
            disabled={props.disabled}
            onPress={() => toggle(option.id, checked)}
            className={cn(
              "min-h-12 flex-row items-center gap-3 px-3.5 py-2 active:bg-card-alt",
              index > 0 && "border-t border-border",
            )}
          >
            <Check checked={checked} round={!multi} />
            <Text className="min-w-0 flex-1 text-base text-foreground">{option.label}</Text>
          </Pressable>
        ) : (
          <Pressable
            key={option.id}
            accessibilityRole={multi ? "checkbox" : "radio"}
            accessibilityState={state}
            accessibilityLabel={option.label}
            disabled={props.disabled}
            onPress={() => toggle(option.id, checked)}
            className={cn(
              "min-h-11 max-w-full flex-row items-center gap-1.5 rounded-full border-2 px-4",
              checked ? "border-primary bg-inline-skill-background" : "border-border bg-screen",
              props.disabled && "opacity-50",
            )}
          >
            {checked && multi ? (
              <SymbolView
                name="checkmark"
                size={12}
                tintColorClassName="accent-inline-skill-foreground"
                type="monochrome"
              />
            ) : null}
            <Text
              numberOfLines={1}
              className={cn(
                "shrink text-base",
                checked ? "font-t3-medium text-inline-skill-foreground" : "text-foreground",
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** An order to set: each row moves up or down one place. */
function RankControl(props: {
  readonly field: KanbanAskField;
  readonly value: unknown;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (value: unknown) => void;
}) {
  const labels = new Map(
    (props.field.options ?? []).map((option) => [option.id as string, option.label as string]),
  );
  const order = rankOrder(props.field, props.value);
  const move = (id: string, to: number) => {
    const next = moveRank(order, id, to);
    tapSelection();
    props.onChange(next);
    AccessibilityInfo.announceForAccessibility(
      `${labels.get(id)} is now ${next.indexOf(id) + 1} of ${next.length}`,
    );
  };
  return (
    <View accessibilityLabel={props.label} className="overflow-hidden rounded-xl bg-card">
      {order.map((id, index) => (
        <View
          key={id}
          className={cn(
            "min-h-12 flex-row items-center gap-2 py-1 pl-3.5 pr-1",
            index > 0 && "border-t border-border",
          )}
        >
          <Text
            className="w-5 text-center text-sm text-foreground-muted"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {index + 1}
          </Text>
          <Text className="min-w-0 flex-1 text-base text-foreground">{labels.get(id)}</Text>
          <ArrowButton
            label={`Move ${labels.get(id)} up`}
            up
            disabled={props.disabled || index === 0}
            onPress={() => move(id, index - 1)}
          />
          <ArrowButton
            label={`Move ${labels.get(id)} down`}
            disabled={props.disabled || index === order.length - 1}
            onPress={() => move(id, index + 1)}
          />
        </View>
      ))}
    </View>
  );
}

function ArrowButton(props: {
  readonly label: string;
  readonly up?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "size-11 items-center justify-center rounded-full active:bg-card-alt",
        props.disabled && "opacity-30",
      )}
    >
      <SymbolView
        name={props.up ? "arrow.up" : "arrow.down"}
        size={15}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );
}

interface PendingFile {
  readonly local: DraftComposerAttachment;
  readonly failed: boolean;
  readonly controller: AbortController;
}

const storedFiles = (value: unknown): ReadonlyArray<AskAnswerFile> =>
  Array.isArray(value) ? (value as ReadonlyArray<AskAnswerFile>) : [];

/**
 * Files for the answer, from the photo library or the document picker. Each
 * one uploads as it is picked; a finished upload becomes part of the answer.
 */
function FileControl(props: {
  readonly entry: KanbanAskFeedItem;
  readonly field: KanbanAskField;
  readonly value: unknown;
  readonly disabled: boolean;
}) {
  // Uploads go to the server this ask was read from, and land in its store.
  const scope = useAskScope();
  const { asks, cell } = scope;
  const { entry, field } = props;
  const environmentId = scope.environmentId as EnvironmentId | null;
  const configs = useServerConfigs();
  const capabilities =
    environmentId === null ? undefined : configs.get(environmentId)?.environment.capabilities;
  const canUpload = capabilities?.attachmentUploads === true;
  const takesFiles = capabilities?.fileAttachments !== undefined;
  const maxFileBytes = capabilities?.fileAttachments?.maxUploadBytes;
  const [pending, setPending] = useState<ReadonlyArray<PendingFile>>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const files = storedFiles(props.value);
  const max = field.maxFiles ?? 1;
  const room = max - files.length - pending.length;
  const mediaOnly = acceptsOnlyMedia(field.accepts) || !takesFiles;
  const takesMedia =
    field.accepts === undefined ||
    field.accepts.some((entry) => /^(image|video)\//i.test(entry.trim()));

  // What is still uploading when he leaves the ask is dropped; what finished stays in the answer.
  const live = useRef(true);
  const pendingNow = useRef(pending);
  useEffect(() => {
    pendingNow.current = pending;
  }, [pending]);
  // An upload that finishes after the answer was locked does not join it.
  const lockedNow = useRef(props.disabled);
  useEffect(() => {
    lockedNow.current = props.disabled;
  }, [props.disabled]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const file of pendingNow.current) file.controller.abort();
      void releaseUnusedComposerAttachmentFiles(pendingNow.current.map((file) => file.local));
    };
  }, []);

  const upload = (file: PendingFile, environment: EnvironmentId) => {
    const { local, controller } = file;
    const drop = () =>
      setPending((current) => current.filter((other) => other.local.id !== local.id));
    void prepareTurnAttachments({
      environmentId: environment,
      attachments: [local],
      supportsImageUploads: true,
      signal: controller.signal,
    })
      .then((result) => {
        const stored = result.status === "ready" ? result.attachments[0] : undefined;
        const id = stored !== undefined && "id" in stored ? stored.id : undefined;
        if (stored === undefined || id === undefined) throw new Error("Upload cancelled.");
        if (controller.signal.aborted || !live.current || lockedNow.current || !scope.live()) {
          // Removed, left, locked or the server changed while uploading: the server copy has no owner, so drop it.
          void releasePendingAttachmentUploads(environment, [id]);
          if (live.current) drop();
          return;
        }
        // Read now, not when the upload began: another file may have finished meanwhile.
        const current = storedFiles(askFormOf(cell.getState(), entry).values[field.id]);
        asks.setAskValue(entry, field.id, [
          ...current,
          {
            type: stored.type,
            id,
            name: stored.name,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
          } satisfies AskAnswerFile,
        ]);
        drop();
        void releaseUnusedComposerAttachmentFiles([local]);
      })
      .catch(() => {
        if (controller.signal.aborted || !live.current) return;
        setPending((current) =>
          current.map((other) =>
            other.local.id === local.id ? { ...other, failed: true } : other,
          ),
        );
      });
  };

  const pick = async (from: "media" | "files") => {
    if (props.disabled || !canUpload || environmentId === null) return;
    if (room <= 0) {
      setRefused(max === 1 ? "One file only" : `At most ${max} files`);
      return;
    }
    setRefused(null);
    const existingCount = files.length + pending.length;
    const result =
      from === "files"
        ? await pickComposerFiles({ existingCount, maxBytes: maxFileBytes })
        : await pickComposerMedia({ existingCount, maxVideoBytes: maxFileBytes });
    const picked: ReadonlyArray<DraftComposerAttachment> =
      "files" in result ? result.files : result.attachments;
    if (!live.current || lockedNow.current || !scope.live()) {
      // Left, locked or the server changed while the picker was open: nothing is uploaded.
      void releaseUnusedComposerAttachmentFiles(picked);
      return;
    }
    if (result.error) setRefused(result.error);
    const fresh: Array<PendingFile> = [];
    const dropped: Array<DraftComposerAttachment> = [];
    picked.forEach((local, index) => {
      const wrong =
        index >= room
          ? max === 1
            ? "One file only"
            : `At most ${max} files`
          : askFieldProblem(
              { ...field, maxFiles: undefined },
              [
                {
                  type: local.type,
                  id: "",
                  name: local.name,
                  mimeType: local.mimeType,
                  sizeBytes: 0,
                },
              ],
              false,
            );
      if (wrong !== null) {
        setRefused(wrong);
        dropped.push(local);
        return;
      }
      fresh.push({ local, failed: false, controller: new AbortController() });
    });
    if (dropped.length > 0) void releaseUnusedComposerAttachmentFiles(dropped);
    if (fresh.length === 0) return;
    setPending((current) => [...current, ...fresh]);
    for (const file of fresh) upload(file, environmentId);
  };

  const retry = (file: PendingFile) => {
    if (props.disabled || environmentId === null) return;
    const again = { ...file, failed: false, controller: new AbortController() };
    setPending((current) =>
      current.map((other) => (other.local.id === file.local.id ? again : other)),
    );
    upload(again, environmentId);
  };
  const removePending = (file: PendingFile) => {
    file.controller.abort();
    setPending((current) => current.filter((other) => other.local.id !== file.local.id));
    void releaseUnusedComposerAttachmentFiles([file.local]);
  };
  const remove = (file: AskAnswerFile) => {
    if (props.disabled) return;
    if (environmentId !== null) void releasePendingAttachmentUploads(environmentId, [file.id]);
    asks.setAskValue(
      entry,
      field.id,
      files.filter((other) => other.id !== file.id),
    );
  };

  const some = files.length + pending.length > 0;
  return (
    <View className="gap-2">
      {files.map((file) => (
        <FileLine
          key={file.id}
          name={file.name}
          detail={formatAttachmentSize(file.sizeBytes)}
          state="ready"
        >
          <XButton
            label={`Remove ${file.name}`}
            disabled={props.disabled}
            onPress={() => remove(file)}
          />
        </FileLine>
      ))}
      {pending.map((file) => (
        <FileLine
          key={file.local.id}
          name={file.local.name}
          detail={file.failed ? "Upload failed" : "Uploading"}
          state={file.failed ? "failed" : "uploading"}
        >
          {file.failed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Try ${file.local.name} again`}
              accessibilityState={{ disabled: props.disabled }}
              disabled={props.disabled}
              onPress={() => retry(file)}
              className="min-h-11 justify-center rounded-full px-3 active:bg-card-alt"
            >
              <Text className="text-sm font-t3-medium text-primary-text">Retry</Text>
            </Pressable>
          ) : null}
          <XButton label={`Remove ${file.local.name}`} onPress={() => removePending(file)} />
        </FileLine>
      ))}
      {room > 0 && canUpload ? (
        <View className="flex-row flex-wrap gap-2">
          {mediaOnly ? null : (
            <PickButton
              label={some ? "Add a file" : "Choose a file"}
              disabled={props.disabled}
              onPress={() => void pick("files")}
            />
          )}
          {takesMedia ? (
            <PickButton
              label={some ? "Add a photo" : "Choose a photo"}
              disabled={props.disabled}
              onPress={() => void pick("media")}
            />
          ) : null}
        </View>
      ) : null}
      {field.accepts && room > 0 ? (
        <Text className="text-2xs text-foreground-muted">{acceptsInWords(field.accepts)}</Text>
      ) : null}
      {canUpload ? null : (
        <Text className="text-sm text-foreground-muted">This connection can't take uploads.</Text>
      )}
      {refused ? <Problem>{refused}</Problem> : null}
    </View>
  );
}

function PickButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-12 flex-row items-center gap-2 rounded-full bg-secondary px-4 active:opacity-70",
        props.disabled && "opacity-50",
      )}
    >
      <SymbolView name="plus" size={13} tintColorClassName="accent-icon" type="monochrome" />
      <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function XButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="size-11 items-center justify-center rounded-full active:bg-card-alt"
    >
      <SymbolView name="xmark" size={12} tintColorClassName="accent-icon-muted" type="monochrome" />
    </Pressable>
  );
}

function FileLine(props: {
  readonly name: string;
  readonly detail: string;
  readonly state: "ready" | "uploading" | "failed";
  readonly children: ReactNode;
}) {
  return (
    <View className="min-h-12 flex-row items-center gap-2.5 rounded-xl bg-card py-0.5 pl-3.5 pr-0.5">
      <SymbolView name="doc" size={15} tintColorClassName="accent-icon-muted" type="monochrome" />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base font-t3-medium text-foreground">
          {props.name}
        </Text>
        <Text
          accessibilityRole={props.state === "failed" ? "alert" : undefined}
          className={cn(
            "text-2xs",
            props.state === "failed" ? "text-danger-foreground" : "text-foreground-muted",
          )}
        >
          {props.detail}
        </Text>
      </View>
      {props.state === "ready" ? <Pill label="Added" tone="accent" /> : null}
      {props.children}
    </View>
  );
}

/**
 * A secret, typed masked. Its value lives in the reader's component state and
 * nowhere else: not the form, the store, the send queue or the disk. It leaves
 * the phone once, with the answer, over the app's private channel, and is
 * never drawn back.
 */
function SecretControl(props: {
  readonly label: string;
  readonly value: string;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <View className="gap-1.5">
      <AppTextInput
        accessibilityLabel={props.label}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        spellCheck={false}
        importantForAutofill="no"
        textContentType="none"
        keyboardType="default"
        editable={!props.disabled}
        value={props.value}
        onChangeText={props.onChange}
        className={cn(
          "min-h-12 rounded-xl bg-card",
          props.invalid ? "border-danger-border" : "border-transparent",
        )}
      />
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name={{ ios: "lock", android: "lock" }}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
          Sent privately, at once: no undo. Never shown again.
        </Text>
      </View>
    </View>
  );
}

/** A value picked inside the ask's own page (a chart, a slider), handed back by message. */
function CustomControl(props: {
  readonly ask: KanbanOwnerAsk;
  readonly field: KanbanAskField;
  readonly value: unknown;
  /** The page still shows, but takes no touches, and a value it posts is dropped. */
  readonly disabled: boolean;
  readonly onChange: (value: unknown) => void;
}) {
  const { field, value, disabled } = props;
  const block = field.block === undefined ? undefined : props.ask.blocks?.[field.block];
  const page = block?._tag === "html" && block.truncated !== true ? block : null;
  const picked = !isBlank(value);
  return (
    <View className="gap-2">
      {page ? (
        <AskHtml
          html={page.html}
          title={page.title}
          height={page.height}
          disabled={disabled}
          onValue={(next) => {
            if (customValueTaken(field, next, disabled)) props.onChange(next);
          }}
        />
      ) : block?._tag === "html" ? (
        <View className="h-40 rounded-2xl bg-card" />
      ) : null}
      <View accessibilityLiveRegion="polite" className="flex-row items-baseline gap-2">
        {picked ? (
          <>
            <Text className="text-sm text-foreground-muted">Picked</Text>
            <Text
              className="text-sm font-t3-medium text-foreground"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {shownValue(value)}
              {field.unit ? ` ${field.unit}` : ""}
            </Text>
          </>
        ) : (
          <Text className="text-sm text-foreground-muted">
            {page && !disabled ? "Pick a value in the page above" : "Nothing picked yet"}
          </Text>
        )}
      </View>
    </View>
  );
}
