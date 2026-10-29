import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  KANBAN_BOARD_ICONS,
  type KanbanBoardIcon,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";

import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { usePrimarySettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { BOARD_ICONS } from "./boardIcon";
import { kanban, runAction } from "./kanbanStore";

/** A board slug: lowercase words joined by dashes, the way the server keys boards. */
export function slugOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Self-service board creation. The board is created and its setup evaluator starts
 * only when "Start setup" is pressed, on the picked model. The app then opens the
 * board's Setup discussion.
 */
export function NewBoardDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const providersByEnvironment = useEnvironmentProviders();
  const settings = usePrimarySettings();
  const projects = useProjects();
  const providers =
    (environmentId ? providersByEnvironment.get(environmentId) : undefined) ?? EMPTY_SERVER_PROVIDERS;

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [icon, setIcon] = useState<KanbanBoardIcon | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    model?.instanceId,
    model?.model,
  );
  const effectiveSlug = slugTouched ? slug : slugOf(name);
  const canStart =
    name.trim() !== "" &&
    effectiveSlug !== "" &&
    projectId !== null &&
    model !== null &&
    environmentId !== null &&
    !busy;

  const reset = () => {
    setName("");
    setSlug("");
    setSlugTouched(false);
    setIcon(null);
    setProjectId(null);
    setModel(null);
    setNotes("");
  };

  const start = async () => {
    if (!canStart || model === null) return;
    setBusy(true);
    await runAction("Couldn't start setup", async () => {
      const created = await kanban.createBoard({
        slug: effectiveSlug,
        name: name.trim(),
        defaultProjectId: projectId,
        evaluatorModel: model,
      });
      if (icon) await kanban.updateBoard({ boardId: created.id, icon });
      const started = await kanban.startSetup(created.id, {
        evaluatorModel: model,
        ...(notes.trim() ? { text: notes.trim() } : {}),
      });
      props.onOpenChange(false);
      reset();
      await navigate({
        to: "/boards/$boardId",
        params: { boardId: created.id },
        search: { discussion: started.discussionId },
      });
    });
    setBusy(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New board</DialogTitle>
          <DialogDescription>
            Pick the setup evaluator's model, then press Start setup. It opens a Setup discussion.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span>Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Robob"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Slug</span>
            <Input
              value={effectiveSlug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(slugOf(event.target.value));
              }}
            />
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span>Icon (optional)</span>
            <div className="flex flex-wrap gap-1.5">
              {KANBAN_BOARD_ICONS.map((entry) => {
                const Icon = BOARD_ICONS[entry];
                const selected = icon === entry;
                return (
                  <button
                    key={entry}
                    type="button"
                    aria-label={entry}
                    aria-pressed={selected}
                    onClick={() => setIcon(selected ? null : entry)}
                    className={
                      selected
                        ? "flex size-8 items-center justify-center rounded-lg bg-accent"
                        : "flex size-8 items-center justify-center rounded-lg hover:bg-accent"
                    }
                  >
                    <Icon aria-hidden className="size-4" />
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span>Project</span>
            <select
              className="rounded-md border bg-background px-2 py-1.5"
              value={projectId ?? ""}
              onChange={(event) =>
                setProjectId(event.target.value ? (event.target.value as ProjectId) : null)
              }
            >
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1 text-sm">
            <span>Setup evaluator model</span>
            {environmentId && entries[0] ? (
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={model?.instanceId ?? entries[0].instanceId}
                model={model?.model ?? ""}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptions}
                {...(model ? {} : { triggerLabel: "Pick a model" })}
                onInstanceModelChange={(instanceId, modelId) =>
                  setModel({ instanceId, model: modelId })
                }
              />
            ) : (
              <span className="text-muted-foreground">No environment connected.</span>
            )}
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span>Notes for the setup evaluator (optional)</span>
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Leave empty for the default setup."
              rows={4}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={!canStart} onClick={() => void start()}>
            Start setup
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
