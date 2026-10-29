import { useNavigation } from "@react-navigation/native";
import {
  KANBAN_BOARD_ICONS,
  type KanbanBoardIcon,
  type KanbanBoardId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { usePairedEnvironmentId } from "../common/environment";
import { THEMED } from "./BoardIcon";
import { kanbanClient, useKanbanBoards } from "./kanbanStore";

/** Same rule as the web dialog: the slug is the name, lowercased with dashes. */
export function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * New board on the phone: name and slug, optional icon, project, the setup
 * evaluator's model and notes. Start setup creates the board, saves the icon,
 * starts the setup evaluator on the picked model and opens its Setup discussion.
 */
export function NewBoardRouteScreen() {
  const navigation = useNavigation();
  const environmentId = usePairedEnvironmentId();
  const config = useEnvironmentServerConfig(environmentId);
  // Kanban requests go to the paired environment, so only its projects can be a board's project.
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const boards = useKanbanBoards() ?? [];

  const [name, setName] = useState("");
  const [slugEdit, setSlugEdit] = useState<string | null>(null);
  const [icon, setIcon] = useState<KanbanBoardIcon | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The board this form created, kept so a retry resumes it instead of creating another.
  const [pending, setPending] = useState<{
    boardId: KanbanBoardId;
    discussionId: string | null;
  } | null>(null);

  const slug = slugEdit ?? slugOf(name);
  const modelGroups = useMemo(
    () => groupByProvider(buildModelOptions(config, model, undefined, projectId)),
    [config, model, projectId],
  );
  const canStart =
    name.trim() !== "" && slug !== "" && projectId !== null && model !== null && !busy;

  const start = async () => {
    if (!canStart || model === null || projectId === null) return;
    // A pending board already owns its slug, so a retry skips the duplicate check.
    if (pending === null && boards.some((summary) => summary.board.slug === slug)) {
      setError(`A board with the slug "${slug}" already exists. Pick another name.`);
      return;
    }
    setBusy(true);
    setError(null);
    // Resume the pending board by id; a later failure keeps the id so the retry lands on it.
    let boardId: KanbanBoardId | null = pending?.boardId ?? null;
    let discussionId: string | null = pending?.discussionId ?? null;
    try {
      const client = kanbanClient();
      if (boardId === null) {
        const created = await client.createBoard({
          slug,
          name: name.trim(),
          defaultProjectId: projectId,
          evaluatorModel: model,
        });
        boardId = created.id;
        setPending({ boardId, discussionId: null });
      }
      if (icon) await client.updateBoard({ boardId, icon });
      if (discussionId === null) {
        // A setup that started before a lost reply is on the board already. Open it, and only
        // start one when the board's persisted setup is absent (startSetup refuses a running one).
        const list = client.boards.get();
        if (list === undefined) {
          throw new Error("Board list is still loading. Try again in a moment.");
        }
        const entry = list.find((summary) => summary.board.id === boardId);
        if (entry === undefined) {
          throw new Error("The new board is still syncing. Try again in a moment.");
        }
        if (entry.board.setup?.discussionId) {
          discussionId = entry.board.setup.discussionId;
          setPending({ boardId, discussionId });
        }
      }
      if (discussionId === null) {
        const started = await client.startSetup(boardId, {
          evaluatorModel: model,
          ...(notes.trim() ? { text: notes.trim() } : {}),
        });
        discussionId = started.discussionId;
        setPending({ boardId, discussionId });
      }
      // The board opens first, then its Setup discussion stacks on top, as nav.openDiscussion does.
      navigation.navigate("KanbanBoard", { boardId });
      navigation.navigate("KanbanRecord", { kind: "discussion", boardId, id: discussionId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't start setup");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerClassName="gap-4 p-4">
      <View className="gap-1.5">
        <Text className="text-sm text-foreground-muted">Name</Text>
        <TextInput
          value={name}
          editable={pending === null}
          onChangeText={setName}
          placeholder="Robob"
          placeholderTextColorClassName="accent-placeholder"
          className="rounded-lg border border-input-border bg-input px-3 py-2 text-base text-foreground"
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-sm text-foreground-muted">Slug</Text>
        <TextInput
          value={slug}
          editable={pending === null}
          onChangeText={(value) => setSlugEdit(slugOf(value))}
          autoCapitalize="none"
          className="rounded-lg border border-input-border bg-input px-3 py-2 text-base text-foreground"
        />
      </View>
      <Text className="text-sm text-foreground-muted">Icon (optional)</Text>
      <View className="flex-row flex-wrap gap-2">
        {KANBAN_BOARD_ICONS.map((entry) => {
          const Icon = THEMED[entry];
          const selected = icon === entry;
          return (
            <Pressable
              key={entry}
              accessibilityRole="button"
              accessibilityLabel={entry}
              accessibilityState={{ selected }}
              disabled={pending !== null}
              onPress={() => setIcon(selected ? null : entry)}
              className={
                selected
                  ? "size-11 items-center justify-center rounded-lg bg-primary"
                  : "size-11 items-center justify-center rounded-lg bg-input"
              }
            >
              <Icon size={20} />
            </Pressable>
          );
        })}
      </View>
      <Text className="text-sm text-foreground-muted">Project</Text>
      {projects.map((project) => (
        <Button
          key={project.id}
          label={project.title}
          disabled={pending !== null}
          tone={projectId === project.id ? "primary" : "secondary"}
          onPress={() => setProjectId(project.id)}
        />
      ))}
      <Text className="text-sm text-foreground-muted">Setup evaluator model</Text>
      {modelGroups.flatMap((group) =>
        group.models.map((option) => (
          <Button
            key={option.key}
            label={`${option.providerLabel} · ${option.label}`}
            tone={
              model?.instanceId === option.selection.instanceId &&
              model.model === option.selection.model
                ? "primary"
                : "secondary"
            }
            onPress={() => setModel(option.selection)}
          />
        )),
      )}
      <View className="gap-1.5">
        <Text className="text-sm text-foreground-muted">Notes for the setup evaluator (optional)</Text>
        <TextInput
          value={notes}
          onChangeText={setNotes}
          multiline
          placeholder="Leave empty for the default setup."
          placeholderTextColorClassName="accent-placeholder"
          className="min-h-24 rounded-lg border border-input-border bg-input px-3 py-2 text-base text-foreground"
        />
      </View>
      {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
      <Button
        label="Start setup"
        disabled={!canStart}
        loading={busy}
        tone="primary"
        onPress={() => void start()}
      />
    </ScrollView>
  );
}
