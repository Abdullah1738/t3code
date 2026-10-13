import { ComposerContextId, PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Alert } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { ComposerEditor as NativeComposerEditor } from "../native/T3ComposerEditor";
import type {
  ComposerEditorHandle as NativeComposerEditorHandle,
  ComposerEditorProps as NativeComposerEditorProps,
} from "../native/T3ComposerEditor";
import {
  appendComposerDraftAttachments,
  createComposerDraftContextHistory,
  getComposerDraftAfterSelection,
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  insertComposerDraftText,
  rememberComposerDraftSelection,
  setComposerDraftContext,
  setComposerContextImporting,
  useComposerDraft,
} from "../state/use-composer-drafts";
import { importComposerContextClipboard } from "../lib/composerContextClipboard";
import { mobilePreferencesAtom } from "../state/preferences";
import { AssistantCitationSheet } from "./AssistantCitationSheet";
import { ComposerContextSheet } from "./ComposerContextSheet";
import { AppText as Text } from "./AppText";
import {
  composerDocumentAttachment,
  composerMentionPath,
  type ComposerDocumentAttachment,
} from "../lib/composerContext";

type ComposerChip = { source: string; start: number; end: number };

export interface ComposerEditorHandle extends NativeComposerEditorHandle {
  /**
   * Opens a just-inserted quote's sheet with its comment field focused. Returns false when the
   * editor has moved on to another draft since the quote went into `draftKey`.
   */
  openNewCitation: (draftKey: string, chip: ComposerChip) => boolean;
}

export type ComposerEditorProps = Omit<NativeComposerEditorProps, "ref"> & {
  readonly ref?: Ref<ComposerEditorHandle>;
  readonly draftKey?: string | null;
  readonly environmentId?: EnvironmentId;
  readonly onOpenMention?: (path: string) => void;
  /** Documents open in the file screen; pictures, video and PDF keep their native viewers. */
  readonly onOpenAttachment?: (attachment: ComposerDocumentAttachment) => void;
  /**
   * A resting composer is a target to type in, not a document to navigate. Its chips go inert
   * so a draft full of them can still be tapped anywhere to start writing; the caller focuses
   * the editor instead. Chips become live again once the composer is open.
   */
  readonly chipsInert?: boolean;
  /** Called instead of opening a chip while `chipsInert` is set. */
  readonly onInertChipPress?: () => void;
};

export function ComposerEditor({
  ref,
  draftKey,
  environmentId,
  onOpenMention,
  onOpenAttachment,
  chipsInert,
  onInertChipPress,
  ...props
}: ComposerEditorProps) {
  const draft = useComposerDraft(draftKey ?? null);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferredEnterBehavior = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.composerEnterBehavior
    : undefined;
  const contextHistory = useMemo(() => createComposerDraftContextHistory(), [draftKey]);
  useEffect(() => () => contextHistory.dispose(), [contextHistory]);
  const changeText = (text: string) => {
    const restored = contextHistory.restore(
      text,
      draftKey ? getComposerDraftSnapshot(draftKey) : draft,
    );
    props.onChangeText(text);
    if (draftKey) {
      setComposerDraftContext(draftKey, restored.context);
      appendComposerDraftAttachments(draftKey, restored.attachments, { allowOverflow: true });
    }
  };
  const currentDraftKey = draftKey ?? null;
  const [selected, setSelected] = useState<
    (ComposerChip & { draftKey: string | null; comment?: string; isNewCitation?: boolean }) | null
  >(null);
  // A chip's sheet belongs to the draft it was opened from.
  if (selected && selected.draftKey !== currentDraftKey) setSelected(null);
  const nativeRef = useRef<NativeComposerEditorHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => nativeRef.current?.focus(),
      blur: () => nativeRef.current?.blur(),
      setSelection: (selection) => nativeRef.current?.setSelection(selection),
      openNewCitation: (chipDraftKey, chip) => {
        if (chipDraftKey !== currentDraftKey) return false;
        setSelected({ ...chip, draftKey: chipDraftKey, isNewCitation: true });
        return true;
      },
    }),
    [currentDraftKey],
  );
  const importRef = useRef<AbortController | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(
    () => () => {
      importRef.current?.abort();
    },
    [draftKey],
  );
  const pasteContext = async (
    clipboard: Parameters<NonNullable<NativeComposerEditorProps["onPasteContext"]>>[0],
  ) => {
    if (!draftKey || importRef.current || props.readOnly || props.editable === false) return;
    const insertion = { text: clipboard.value, ...clipboard.selection };
    const controller = new AbortController();
    importRef.current = controller;
    setImporting(true);
    setComposerContextImporting(draftKey, true);
    try {
      const retained = getComposerDraftAfterSelection(draftKey, insertion);
      const result = await importComposerContextClipboard(
        clipboard,
        retained.attachments.length,
        controller.signal,
        retained.context?.records.length ?? 0,
      );
      if (!result) {
        insertComposerDraftText(draftKey, clipboard.text, insertion);
        return;
      }
      if (!insertComposerDraftContext(draftKey, result, insertion)) {
        Alert.alert(
          "Could not paste context",
          "Remove some attachments or context items from the draft, then paste again.",
        );
        return;
      }
      if (result.failures.length > 0)
        Alert.alert(
          "Some attachments could not be copied",
          "Reconnect to the source environment and copy them again. References without their files are marked unavailable.",
        );
    } catch (error) {
      if (!controller.signal.aborted)
        Alert.alert(
          "Could not paste context",
          error instanceof Error ? error.message : "Try copying again.",
        );
    } finally {
      setComposerContextImporting(draftKey, false);
      importRef.current = null;
      setImporting(false);
    }
  };
  const clipboardFragment = useMemo(
    () =>
      environmentId && draft.context
        ? encodeComposerContextFragment({
            version: 1,
            source: { environmentId },
            records: draft.context.records.map((record) => {
              if (!("attachmentId" in record)) return record;
              const attachment = draft.attachments.find(
                (entry) => entry.id === record.attachmentId,
              );
              return {
                ...record,
                attachmentId:
                  attachment?.uploadEnvironmentId === environmentId
                    ? (attachment.uploadedAttachmentId ?? record.attachmentId)
                    : record.attachmentId,
              };
            }),
          })
        : "",
    [environmentId, draft.context, draft.attachments],
  );
  const navigation = useNavigation();
  const selectedReference = selected
    ? collectComposerContextReferences(selected.source)[0]
    : undefined;
  const selectedSkillName = selected?.source.match(/^\p{Sc}(.+)$/u)?.[1];
  const selectedSkill = selectedSkillName
    ? props.skills?.find((skill) => skill.name === selectedSkillName)
    : undefined;
  const record = draft.context?.records.find(
    (entry) => entry.contextId === selectedReference?.contextId,
  );
  const selectedCitation = selected
    ? collectAssistantCitations(selected.source).find((entry) => entry.source === selected.source)
        ?.citation
    : undefined;
  const editable = !props.readOnly && props.editable !== false;
  // Edits apply only while the chip still sits where it was opened.
  const replaceSelected = (replacement: string) => {
    if (!selected || props.value.slice(selected.start, selected.end) !== selected.source) return;
    changeText(
      props.value.slice(0, selected.start) + replacement + props.value.slice(selected.end),
    );
    const caret = selected.start + replacement.length;
    props.onSelectionChange?.({ start: caret, end: caret });
  };
  return (
    <>
      <NativeComposerEditor
        {...props}
        ref={nativeRef}
        enterBehavior={props.enterBehavior ?? preferredEnterBehavior}
        onChangeText={changeText}
        readOnly={props.readOnly || importing}
        onSubmit={importing ? undefined : props.onSubmit}
        clipboardFragment={clipboardFragment ?? undefined}
        onPasteContext={(clipboard) => void pasteContext(clipboard)}
        context={draft.context}
        onContextPress={(selection) => {
          if (chipsInert) {
            onInertChipPress?.();
            return;
          }
          const path = composerMentionPath(selection.source, draft.context);
          if (path && onOpenMention) {
            onOpenMention(path);
            return;
          }
          const document = composerDocumentAttachment(selection.source, draft.context);
          if (document && onOpenAttachment) {
            onOpenAttachment(document);
            return;
          }
          setSelected({ ...selection, draftKey: currentDraftKey });
        }}
        onSelectionChange={(selection) => {
          if (draftKey)
            rememberComposerDraftSelection(
              draftKey,
              getComposerDraftSnapshot(draftKey).text,
              selection,
            );
          props.onSelectionChange?.(selection);
        }}
      />
      {importing ? (
        <Text className="py-2 text-xs text-foreground-muted">Copying context…</Text>
      ) : null}
      {selected && selectedCitation ? (
        <AssistantCitationSheet
          key={`${selected.start}:${selected.source}`}
          citation={selectedCitation}
          initialComment={selected.comment}
          autoFocus={selected.isNewCitation === true}
          onClose={(comment) => {
            setSelected(null);
            // After citing, go back to writing around the quote.
            if (selected.isNewCitation) requestAnimationFrame(() => nativeRef.current?.focus());
            if (!editable || comment.trim() === (selectedCitation.comment ?? "")) return;
            const source = serializeAssistantCitation(
              withAssistantCitationComment(selectedCitation, comment),
            );
            if (
              props.value.length - selected.source.length + source.length >
              PROVIDER_SEND_TURN_MAX_INPUT_CHARS
            ) {
              const chip = selected;
              Alert.alert("The draft is too long", "Shorten the draft or the comment.", [
                { text: "OK", onPress: () => setSelected({ ...chip, comment }) },
              ]);
              return;
            }
            replaceSelected(source);
          }}
          {...(editable
            ? {
                onRemove: () => {
                  replaceSelected("");
                  setSelected(null);
                },
              }
            : {})}
        />
      ) : null}
      {selected && (selectedReference || selectedSkill) ? (
        <ComposerContextSheet
          label={
            selectedReference?.label ?? selectedSkill?.displayName ?? selectedSkill?.name ?? "Skill"
          }
          record={
            record ??
            (selectedSkill
              ? {
                  version: 1,
                  kind: "skill",
                  contextId: ComposerContextId.make("skill-preview"),
                  label: selectedSkill.name,
                  name: selectedSkill.name,
                }
              : undefined)
          }
          {...(selectedSkill?.description ? { skillDescription: selectedSkill.description } : {})}
          {...(selectedSkill?.path && onOpenMention
            ? {
                onOpenSkill: () => {
                  setSelected(null);
                  onOpenMention(selectedSkill.path!);
                },
              }
            : {})}
          onOpenThread={(thread) => {
            setSelected(null);
            navigation.navigate("Thread", {
              environmentId: String(thread.environmentId),
              threadId: String(thread.threadId),
            });
          }}
          environmentId={environmentId ?? draft.project?.environmentId}
          projectId={draft.project?.projectId}
          records={draft.context?.records}
          attachments={draft.attachments}
          onClose={() => setSelected(null)}
          onRemove={
            editable
              ? () => {
                  replaceSelected("");
                  setSelected(null);
                }
              : undefined
          }
        />
      ) : null}
    </>
  );
}
export type { ComposerEditorSelection, ComposerTextPaste } from "../native/T3ComposerEditor";
