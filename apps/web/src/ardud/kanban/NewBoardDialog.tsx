import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  KANBAN_BOARD_ICONS,
  type KanbanBoardIcon,
  type KanbanBoardId,
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
import { kanban, runAction, useBoards } from "./kanbanStore";

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
  // Kanban requests go to the primary environment, so only its projects can be a board's project.
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const boards = useBoards() ?? [];
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
  // The board this form created, kept so a retry resumes it instead of creating another.
  const [pending, setPending] = useState<{
    boardId: KanbanBoardId;
    discussionId: string | null;
  } | null>(null);

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
    setPending(null);
  };

  const start = async () => {
    if (!canStart || model === null) return;
    // Refuse a taken slug before anything is created or changed. The server refuses it too.
    // A pending board already owns its slug, so a retry skips this check.
    if (pending === null && boards.some((summary) => summary.board.slug === effectiveSlug)) {
      await runAction("Couldn't create the board", async () => {
        throw new Error(`A board with the slug "${effectiveSlug}" already exists. Pick another name.`);
      });
      return;
    }
    setBusy(true);
    // A board this form already created is resumed by id, never looked up by slug: a retry after
    // a later icon or setup failure must not create or adopt another board.
    let boardId = pending?.boardId ?? null;
    let discussionId = pending?.discussionId ?? null;
    const ok = await runAction("Couldn't start setup", async () => {
      if (boardId === null) {
        const created = await kanban.createBoard({
          slug: effectiveSlug,
          name: name.trim(),
          defaultProjectId: projectId,
          evaluatorModel: model,
        });
        boardId = created.id;
        setPending({ boardId, discussionId: null });
      }
      if (icon) await kanban.updateBoard({ boardId, icon });
      if (discussionId === null) {
        // A setup that started before a lost reply is on the board already. Open it, and only
        // start one when the board has none (startSetup would refuse a running setup anyway).
        const list = kanban.boards.get();
        if (list === undefined) {
          // The board list has not loaded, so the setup state is unknown. Starting setup now could
          // double-start after a lost reply; ask the owner to retry once the list has loaded.
          throw new Error("Board list is still loading. Try again in a moment.");
        }
        const entry = list.find((summary) => summary.board.id === boardId);
        if (entry === undefined) {
          // The board was created but the list has not caught up yet, so its setup is unknown.
          throw new Error("The new board is still syncing. Try again in a moment.");
        }
        if (entry.board.setup?.discussionId) {
          discussionId = entry.board.setup.discussionId;
          setPending({ boardId, discussionId });
        }
      }
      if (discussionId === null) {
        const started = await kanban.startSetup(boardId, {
          evaluatorModel: model,
          ...(notes.trim() ? { text: notes.trim() } : {}),
        });
        discussionId = started.discussionId;
        setPending({ boardId, discussionId });
      }
    });
    setBusy(false);
    if (!ok || boardId === null || discussionId === null) return;
    props.onOpenChange(false);
    reset();
    await navigate({
      to: "/boards/$boardId",
      params: { boardId },
      // The board opens on its columns by default, so the discussions view is named explicitly.
      search: { view: "discussions", discussion: discussionId },
    });
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
              disabled={pending !== null}
              onChange={(event) => setName(event.target.value)}
              placeholder="Robob"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Slug</span>
            <Input
              value={effectiveSlug}
              disabled={pending !== null}
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
              disabled={pending !== null}
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
