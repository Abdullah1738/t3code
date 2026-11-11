/**
 * One value to fill in on an ask. The field's type picks the control; a type
 * this build does not know is drawn, checked and sent as text.
 */
import {
  askFieldKind,
  askFieldProblem,
  type AskAnswerFile,
} from "@t3tools/client-runtime/ardud/kanban";
import {
  clampFileAttachmentUploadBytes,
  formatAttachmentSize,
} from "@t3tools/client-runtime/state/attachments";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type KanbanAskFeedItem,
  type KanbanAskField,
  type KanbanOwnerAsk,
} from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  FileIcon,
  GripVerticalIcon,
  LockIcon,
  RotateCcwIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  releaseAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../../lib/attachmentUploadQueue";
import { cn } from "../../../lib/utils";
import { useServerConfigs } from "../../../state/entities";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { prepareDraftFile, revokePreview, type ComposerDraftFile } from "../Chat";
import { GrowingText, Problem } from "./AnswerParts";
import { setAskValue } from "./askStore";
import { AskHtmlFrame } from "./HtmlFrame";
import { IconBtn, Pill, fieldClass } from "./ui";

const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

export function FieldRow(props: {
  entry: KanbanAskFeedItem;
  /** The ask whole, for a field that shows one of its blocks. */
  ask: KanbanOwnerAsk;
  field: KanbanAskField;
  value: unknown;
  /** Required here even when the field itself is not (a task's proof). */
  required: boolean;
  /** What stopped the last send, or what the server refused. */
  problem: string | undefined;
  /** The only field of a plain question: the section's heading is its label. */
  bare?: boolean;
  disabled: boolean;
  /** A secret field's value and its setter: held by the reader, never by the form. */
  secret?: string;
  onSecret?: (value: string) => void;
}) {
  const { entry, field, value } = props;
  const id = useId();
  const kind = askFieldKind(field);
  // A value he has left is checked at once; an empty required one only when he sends.
  const [touched, setTouched] = useState(false);
  const problem =
    props.problem ?? (touched && !isBlank(value) ? askFieldProblem(field, value, false) : null);
  const describedBy =
    [field.hint ? `${id}-hint` : null, problem ? `${id}-problem` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const set = (next: unknown) => setAskValue(entry, field.id, next);
  const common = {
    id,
    "data-ny-at": `field:${field.id}`,
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": props.required || undefined,
    disabled: props.disabled,
    onBlur: () => setTouched(true),
  } as const;
  const text = typeof value === "string" ? value : "";
  const label = field.label || field.id;

  let control: ReactNode;
  let ownLabel = false;
  switch (kind) {
    case "longtext":
      control = (
        <GrowingText
          {...common}
          aria-label={props.bare ? "Your answer" : undefined}
          placeholder={props.bare ? "Type your answer…" : undefined}
          value={text}
          onChange={(event) => set(event.target.value)}
        />
      );
      break;
    case "number":
      control = (
        <span className="flex items-center gap-2">
          <input
            {...common}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={typeof value === "number" ? String(value) : text}
            onChange={(event) => set(event.target.value)}
            className={cn(fieldClass, "w-32 text-end tabular-nums")}
          />
          {field.unit ? <span className="text-sm text-(--m-muted)">{field.unit}</span> : null}
        </span>
      );
      break;
    case "date":
    case "datetime":
      control = (
        <input
          {...common}
          type={kind === "date" ? "date" : "datetime-local"}
          value={text}
          onChange={(event) => set(event.target.value)}
          className={cn(fieldClass, "w-auto tabular-nums")}
        />
      );
      break;
    case "toggle":
      ownLabel = true;
      control = (
        <button
          {...common}
          type="button"
          role="switch"
          aria-checked={value === true}
          onClick={() => set(value !== true)}
          className="group flex min-w-0 items-center gap-3 rounded-lg py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) pointer-coarse:min-h-11"
        >
          <span
            aria-hidden
            className={cn(
              "flex h-5.5 w-9.5 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150",
              value === true ? "bg-(--m-accent)" : "bg-(--ny-edge)",
            )}
          >
            <span
              className={cn(
                "size-4.5 rounded-full bg-(--m-ground) transition-transform duration-150",
                value === true && "translate-x-4",
              )}
            />
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        </button>
      );
      break;
    case "select":
      control = (
        <SelectControl field={field} value={value} common={common} label={label} onChange={set} />
      );
      break;
    case "rank":
      control = (
        <RankControl
          field={field}
          value={value}
          id={id}
          label={label}
          describedBy={describedBy}
          at={common["data-ny-at"]}
          disabled={props.disabled}
          onChange={set}
        />
      );
      break;
    case "file":
      control = (
        <FileControl
          field={field}
          value={value}
          common={common}
          disabled={props.disabled}
          onChange={set}
        />
      );
      break;
    case "secret":
      control = (
        <SecretControl
          value={props.secret ?? ""}
          common={common}
          onChange={(next) => props.onSecret?.(next)}
        />
      );
      break;
    case "custom":
      control = (
        <CustomControl ask={props.ask} field={field} value={value} common={common} onChange={set} />
      );
      break;
    default:
      control = (
        <input
          {...common}
          type="text"
          autoComplete="off"
          value={text}
          onChange={(event) => set(event.target.value)}
          className={fieldClass}
        />
      );
  }

  return (
    <div className="min-w-0">
      {props.bare || ownLabel ? null : (
        <label htmlFor={id} className="mb-1.5 flex items-baseline gap-2 text-sm font-medium">
          {label}
          {props.required ? null : <span className="font-normal text-(--m-muted)">Optional</span>}
        </label>
      )}
      {control}
      {field.hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-(--m-muted)">
          {field.hint}
        </p>
      ) : null}
      {problem ? <Problem id={`${id}-problem`}>{problem}</Problem> : null}
    </div>
  );
}

interface CommonProps {
  readonly id: string;
  readonly "data-ny-at": string;
  readonly "aria-invalid": true | undefined;
  readonly "aria-describedby": string | undefined;
  readonly "aria-required": true | undefined;
  readonly disabled: boolean;
  readonly onBlur: () => void;
}

const pillChoice = (checked: boolean) =>
  cn(
    "inline-flex h-8.5 min-w-0 items-center gap-1.5 rounded-full px-3.5 text-sm outline-none ring-1 ring-inset focus-visible:ring-2 focus-visible:ring-(--m-accent) disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:text-base",
    checked
      ? "bg-(--m-band) font-medium text-(--m-accent-text) ring-2 ring-(--m-accent) focus-visible:ring-(--m-text)"
      : "ring-(--ny-edge) hover:bg-(--m-surface)",
  );

/** A few options are shown as pills; a long list folds into a menu. */
function SelectControl(props: {
  field: KanbanAskField;
  value: unknown;
  common: CommonProps;
  label: string;
  onChange: (value: unknown) => void;
}) {
  const { field, value, common } = props;
  const options = field.options ?? [];
  const multi = field.multi === true;
  if (!multi && options.length > 5) {
    return (
      <select
        {...common}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => props.onChange(event.target.value)}
        className={cn(fieldClass, "w-auto max-w-full pe-8")}
      >
        <option value="">Choose</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  const picked: ReadonlyArray<unknown> = multi ? (Array.isArray(value) ? value : []) : [value];
  const { id, "data-ny-at": at, onBlur, disabled, ...aria } = common;
  return (
    <div
      id={id}
      role={multi ? "group" : "radiogroup"}
      aria-label={props.label}
      {...aria}
      onBlur={onBlur}
      className="flex flex-wrap gap-1.5"
    >
      {options.map((option, index) => {
        const checked = picked.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={checked}
            disabled={disabled}
            data-ny-at={index === 0 ? at : undefined}
            onClick={() =>
              props.onChange(
                multi
                  ? checked
                    ? picked.filter((entry) => entry !== option.id)
                    : [...picked, option.id]
                  : checked
                    ? ""
                    : option.id,
              )
            }
            className={pillChoice(checked)}
          >
            {checked && multi ? <CheckIcon aria-hidden className="size-3.5" /> : null}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** An order to set: drag a row by its grip, or move it with the arrows. */
function RankControl(props: {
  field: KanbanAskField;
  value: unknown;
  id: string;
  label: string;
  describedBy: string | undefined;
  at: string;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const options = props.field.options ?? [];
  const known = new Map(options.map((option) => [option.id as string, option.label as string]));
  const stored = Array.isArray(props.value)
    ? props.value.filter((id): id is string => typeof id === "string" && known.has(id))
    : [];
  const order = [...stored, ...[...known.keys()].filter((id) => !stored.includes(id))];
  const list = useRef<HTMLOListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [said, setSaid] = useState("");

  const move = (id: string, to: number) => {
    const from = order.indexOf(id);
    const target = Math.max(0, Math.min(order.length - 1, to));
    if (from < 0 || from === target) return;
    const next = order.filter((entry) => entry !== id);
    next.splice(target, 0, id);
    props.onChange(next);
    setSaid(`${known.get(id)} is now ${target + 1} of ${order.length}`);
  };
  const indexAt = (clientY: number): number => {
    const rows = [...(list.current?.children ?? [])];
    for (let index = 0; index < rows.length; index += 1) {
      const box = rows[index]!.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) return index;
    }
    return rows.length - 1;
  };

  return (
    <>
      <ol
        ref={list}
        id={props.id}
        tabIndex={-1}
        aria-label={props.label}
        aria-describedby={props.describedBy}
        data-ny-at={props.at}
        className="flex flex-col gap-1.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
      >
        {order.map((id, index) => (
          <li
            key={id}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-xl py-1.5 ps-1.5 pe-1.5 ring-1 ring-inset ring-(--ny-edge)",
              dragging === id ? "bg-(--m-band) ring-(--m-accent)" : "bg-(--m-ground)",
            )}
          >
            <span
              aria-hidden
              onPointerDown={(event) => {
                if (props.disabled) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging(id);
              }}
              onPointerMove={(event) => {
                if (dragging === id) move(id, indexAt(event.clientY));
              }}
              onPointerUp={() => setDragging(null)}
              onPointerCancel={() => setDragging(null)}
              className="grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-lg text-(--m-muted) hover:bg-(--m-chip) active:cursor-grabbing pointer-coarse:size-11"
            >
              <GripVerticalIcon className="size-4" />
            </span>
            <span className="w-5 shrink-0 text-center text-sm text-(--m-muted) tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{known.get(id)}</span>
            <IconBtn
              label={`Move ${known.get(id)} up`}
              disabled={props.disabled || index === 0}
              onClick={() => move(id, index - 1)}
            >
              <ArrowUpIcon />
            </IconBtn>
            <IconBtn
              label={`Move ${known.get(id)} down`}
              disabled={props.disabled || index === order.length - 1}
              onClick={() => move(id, index + 1)}
            >
              <ArrowDownIcon />
            </IconBtn>
          </li>
        ))}
      </ol>
      <span role="status" className="sr-only">
        {said}
      </span>
    </>
  );
}

/** Uploads started on a file field, by attachment id, so a removed file frees its upload. */
/** What a file field takes, in words: "PDF or images", not "application/pdf, image/*". */
const acceptsInWords = (accepts: ReadonlyArray<string>): string => {
  const words = accepts.map((entry) => {
    const type = entry.trim().toLowerCase();
    if (type === "application/pdf" || type === ".pdf") return "PDF";
    if (type === "image/*") return "images";
    if (type === "video/*") return "videos";
    if (type === "audio/*") return "audio";
    if (type === "text/csv" || type === ".csv") return "CSV";
    if (type === "text/plain" || type === ".txt") return "text";
    if (type.startsWith(".")) return type.slice(1).toUpperCase();
    const [, sub = type] = type.split("/");
    return sub === "*" ? type.replace("/*", "") : sub.toUpperCase();
  });
  const unique = [...new Set(words)];
  return unique.length < 2
    ? (unique[0] ?? "")
    : `${unique.slice(0, -1).join(", ")} or ${unique.at(-1)}`;
};

const uploadIdByAttachment = new Map<string, string>();

function FileControl(props: {
  field: KanbanAskField;
  value: unknown;
  common: CommonProps;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const { field, common } = props;
  const environmentId = usePrimaryEnvironmentId();
  const serverConfig = useServerConfigs().get(environmentId ?? ("" as EnvironmentId));
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const [pending, setPending] = useState<ReadonlyArray<ComposerDraftFile>>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const files: ReadonlyArray<AskAnswerFile> = Array.isArray(props.value)
    ? (props.value as ReadonlyArray<AskAnswerFile>)
    : [];
  const max = field.maxFiles ?? 1;
  const room = max - files.length - pending.length;
  const canUpload =
    environmentId !== null && serverConfig?.environment.capabilities.attachmentUploads === true;

  // A finished upload becomes part of the answer.
  const { onChange } = props;
  useEffect(() => {
    const ready = pending.filter((file) => uploads[file.id]?.status === "ready");
    if (ready.length === 0) return;
    const added: Array<AskAnswerFile> = [];
    for (const file of ready) {
      const upload = uploads[file.id];
      if (upload?.status !== "ready") continue;
      uploadIdByAttachment.set(upload.attachmentId, file.id);
      added.push({
        type: file.type,
        id: upload.attachmentId,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      });
      revokePreview(file);
    }
    // oxlint-disable-next-line react/set-state-in-effect -- Moves a finished upload out of the waiting list as the upload store reports it.
    setPending((current) => current.filter((file) => !ready.includes(file)));
    onChange([...files, ...added]);
  }, [pending, uploads, files, onChange]);

  const add = async (picked: ReadonlyArray<File>) => {
    if (!canUpload || environmentId === null || picked.length === 0) return;
    setRefused(room <= 0 ? (max === 1 ? "One file only" : `At most ${max} files`) : null);
    const maxBytes = clampFileAttachmentUploadBytes(
      serverConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ??
        PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    );
    const next: Array<ComposerDraftFile> = [];
    for (const raw of picked.slice(0, Math.max(0, room))) {
      const draft = await prepareDraftFile(raw, maxBytes);
      if (typeof draft === "string") {
        setRefused(draft);
        continue;
      }
      const wrong = askFieldProblem(
        { ...field, maxFiles: undefined },
        [{ type: draft.type, id: "", name: draft.name, mimeType: draft.mimeType, sizeBytes: 0 }],
        false,
      );
      if (wrong !== null) {
        setRefused(wrong);
        revokePreview(draft);
        continue;
      }
      next.push(draft);
    }
    if (next.length === 0) return;
    setPending((current) => [...current, ...next]);
    for (const image of next) startAttachmentUpload({ environmentId, image });
  };
  const removePending = (file: ComposerDraftFile) => {
    releaseAttachmentUpload(file.id);
    revokePreview(file);
    setPending((current) => current.filter((entry) => entry.id !== file.id));
  };
  const remove = (file: AskAnswerFile) => {
    const uploadId = uploadIdByAttachment.get(file.id);
    if (uploadId !== undefined) releaseAttachmentUpload(uploadId);
    uploadIdByAttachment.delete(file.id);
    props.onChange(files.filter((entry) => entry.id !== file.id));
  };

  const { id, "data-ny-at": at, onBlur, disabled: _disabled, ...aria } = common;
  return (
    <div className="flex max-w-[520px] flex-col gap-2">
      {files.map((file) => (
        <FileRow key={file.id} name={file.name} size={file.sizeBytes} state="ready">
          <IconBtn
            label={`Remove ${file.name}`}
            disabled={props.disabled}
            onClick={() => remove(file)}
          >
            <XIcon />
          </IconBtn>
        </FileRow>
      ))}
      {pending.map((file) => {
        const upload = uploads[file.id];
        const failed = upload?.status === "failed";
        return (
          <FileRow
            key={file.id}
            name={file.name}
            size={file.sizeBytes}
            state={failed ? "failed" : "uploading"}
            progress={upload?.status === "uploading" ? upload.progress : 0}
          >
            {failed && environmentId !== null ? (
              <IconBtn
                label={`Try ${file.name} again`}
                onClick={() => retryAttachmentUpload({ environmentId, image: file })}
              >
                <RotateCcwIcon />
              </IconBtn>
            ) : null}
            <IconBtn label={`Remove ${file.name}`} onClick={() => removePending(file)}>
              <XIcon />
            </IconBtn>
          </FileRow>
        );
      })}
      {room > 0 ? (
        <button
          {...aria}
          id={id}
          type="button"
          data-ny-at={at}
          disabled={props.disabled || !canUpload}
          onBlur={onBlur}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            void add([...event.dataTransfer.files]);
          }}
          className={cn(
            "flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent) disabled:opacity-50",
            over
              ? "border-(--m-accent) bg-(--m-band)"
              : "border-(--ny-edge) hover:bg-(--m-surface)",
            common["aria-invalid"] && "border-(--m-negative)",
          )}
        >
          <UploadIcon aria-hidden className="size-4 text-(--m-muted)" />
          <span>
            <span className="font-medium">
              {files.length + pending.length > 0 ? (
                "Add another"
              ) : (
                <>
                  <span className="pointer-coarse:hidden">Drop the file here</span>
                  <span className="pointer-fine:hidden">Choose a file</span>
                </>
              )}
            </span>
            <span className="text-(--m-muted) pointer-coarse:hidden">, or choose one</span>
          </span>
          {field.accepts ? (
            <span className="text-xs text-(--m-muted)">{acceptsInWords(field.accepts)}</span>
          ) : null}
        </button>
      ) : null}
      <input
        ref={input}
        type="file"
        hidden
        multiple={max > 1}
        accept={field.accepts?.join(",")}
        onChange={(event) => {
          void add([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      {canUpload ? null : (
        <p className="text-sm text-(--m-muted)">This connection can't take uploads.</p>
      )}
      {refused ? <Problem>{refused}</Problem> : null}
    </div>
  );
}

function FileRow(props: {
  name: string;
  size: number;
  state: "ready" | "uploading" | "failed";
  progress?: number;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl bg-(--m-surface) py-1.5 ps-3 pe-1.5 text-sm">
      <FileIcon aria-hidden className="size-4 shrink-0 text-(--m-muted)" />
      <span className="min-w-0 flex-1 truncate font-medium">{props.name}</span>
      <span
        role={props.state === "failed" ? "alert" : undefined}
        className="shrink-0 text-xs text-(--m-muted) tabular-nums"
      >
        {props.state === "uploading"
          ? `${Math.round((props.progress ?? 0) * 100)}%`
          : props.state === "failed"
            ? "Upload failed"
            : formatAttachmentSize(props.size)}
      </span>
      {props.state === "ready" ? <Pill tone="accent">Added</Pill> : null}
      {props.children}
    </div>
  );
}

/**
 * A secret, typed masked. Its value lives in the reader's component state and
 * nowhere else: not the form, the store or the undo queue. It leaves the page
 * once, with the answer, over the app's private channel.
 */
function SecretControl(props: {
  value: string;
  common: CommonProps;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex max-w-[520px] flex-col gap-1.5">
      <input
        {...props.common}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className={cn(fieldClass, "font-mono")}
      />
      <p className="flex items-center gap-1.5 text-sm text-(--m-muted)">
        <LockIcon aria-hidden className="size-3.5" />
        Sent privately, at once: no undo. Never shown again.
      </p>
    </div>
  );
}

const shownValue = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);

/** A value picked inside the ask's own page (a chart, a slider), handed back by message. */
function CustomControl(props: {
  ask: KanbanOwnerAsk;
  field: KanbanAskField;
  value: unknown;
  common: CommonProps;
  onChange: (value: unknown) => void;
}) {
  const { field, value } = props;
  const block = field.block === undefined ? undefined : props.ask.blocks?.[field.block];
  const page = block?._tag === "html" && block.truncated !== true ? block : null;
  const picked = !isBlank(value);
  const { onBlur: _onBlur, disabled: _disabled, ...common } = props.common;
  const accept = (next: unknown) => {
    if (typeof next === "number") {
      if (!Number.isFinite(next)) return;
      if (field.min !== undefined && next < field.min) return;
      if (field.max !== undefined && next > field.max) return;
    }
    props.onChange(next);
  };
  return (
    <div className="flex flex-col gap-2.5">
      {page ? (
        <AskHtmlFrame html={page.html} title={page.title} height={page.height} onValue={accept} />
      ) : block?._tag === "html" ? (
        <div className="h-40 rounded-2xl bg-(--m-surface)" aria-hidden />
      ) : null}
      <p
        {...common}
        tabIndex={-1}
        aria-live="polite"
        className="flex items-baseline gap-2 rounded-lg text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--m-accent)"
      >
        {picked ? (
          <>
            <span className="text-(--m-muted)">Picked</span>
            <span className="font-medium tabular-nums">
              {shownValue(value)}
              {field.unit ? ` ${field.unit}` : ""}
            </span>
          </>
        ) : (
          <span className="text-(--m-muted)">
            {page ? "Pick a value in the page above" : "Nothing picked yet"}
          </span>
        )}
      </p>
    </div>
  );
}
