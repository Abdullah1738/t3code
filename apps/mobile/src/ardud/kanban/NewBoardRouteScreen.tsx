import { useNavigation } from "@react-navigation/native";
import type { ModelSelection, ProjectId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { usePairedEnvironmentId } from "../common/environment";
import { kanbanClient } from "./kanbanStore";

/** Same rule as the web dialog: the board's slug is the name, lowercased with dashes. */
export function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * New board on the phone: name, project, the setup evaluator's model and notes.
 * Start setup creates the board, starts the setup evaluator on the picked model
 * and opens its Setup discussion. Nothing is created until then.
 */
export function NewBoardRouteScreen() {
  const navigation = useNavigation();
  const environmentId = usePairedEnvironmentId();
  const config = useEnvironmentServerConfig(environmentId);
  const projects = useProjects();

  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelGroups = useMemo(
    () => groupByProvider(buildModelOptions(config, model, undefined, projectId)),
    [config, model, projectId],
  );
  const canStart = name.trim() !== "" && projectId !== null && model !== null && !busy;

  const start = async () => {
    if (!canStart || model === null || projectId === null) return;
    setBusy(true);
    setError(null);
    try {
      const client = kanbanClient();
      const slug = slugOf(name);
      const created = await client.createBoard({
        slug,
        name: name.trim(),
        defaultProjectId: projectId,
        evaluatorModel: model,
      });
      const started = await client.startSetup(created.id, {
        evaluatorModel: model,
        ...(notes.trim() ? { text: notes.trim() } : {}),
      });
      // The board opens first, then its Setup discussion stacks on top, as nav.openDiscussion does.
      navigation.navigate("KanbanBoard", { boardId: created.id });
      navigation.navigate("KanbanRecord", {
        kind: "discussion",
        boardId: created.id,
        id: started.discussionId,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't start setup");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerClassName="gap-4 p-4">
      <View className="gap-1">
        <Text className="text-sm text-foreground-muted">Name</Text>
        <Text className="text-base text-foreground">{name || "Untitled"}</Text>
      </View>
      <Text className="text-sm text-foreground-muted">Project</Text>
      {projects.map((project) => (
        <Button
          key={project.id}
          label={project.title}
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
