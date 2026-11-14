// @effect-diagnostics nodeBuiltinImport:off - script files live on disk and runs get random ids.
// @effect-diagnostics globalDate:off - runs are stamped like every other board record.
// @effect-diagnostics preferSchemaOverJson:off - child environment values are JSON strings.
/**
 * Board scripts: owner-approved programs the board runs on a schedule, on a
 * board event, or by hand. They run as plain child processes, with no model.
 * The lines they print with a `kanban` key become cards, discussion posts,
 * pool sizes, subtask ticks, hand-backs and card moves (see scripts.ts), and
 * every run keeps its output for the scripts page.
 *
 * A script can also be a wait's check: cards parked with `on: "script"` are
 * handed to their script in one run per pass (`checkWaits`), outside the board
 * lock, and what it prints ends or holds each wait.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { selectionEffort } from "@t3tools/client-runtime/ardud/models/harnessRouting";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  KanbanCardId,
  KanbanDiscussionId,
  KanbanError,
  KanbanScriptId,
  kanbanWaiting,
  KanbanScriptDeliveryRef,
  type KanbanActor,
  type KanbanBoard,
  type KanbanCard,
  type KanbanChange,
  type KanbanDiscussion,
  type KanbanScript,
  type KanbanScriptRun,
  type KanbanScriptAcknowledgeInput,
  type KanbanScriptTrigger,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { runProcess, scriptEnv } from "./scriptRunner.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { KanbanStore } from "../store/KanbanStore.ts";
import { KanbanService, type WaitAnswerFor } from "./KanbanService.ts";
import { modelSelectionResult } from "./defaults.ts";
import { selectionRoutingEnabled } from "./selectionSettings.ts";
import * as SavedWrite from "./savedWrite.ts";
import * as Rules from "./rules.ts";
import * as Scripts from "./scripts.ts";
import * as Text from "./text.ts";
import { KanbanWaitPrs } from "./waitPrs.ts";
import * as Waits from "./waits.ts";

/** A run past this is killed with its whole process group. */
const RUN_TIMEOUT_MS = 10 * 60_000;
/** stdout past this stops the run; commands come from stdout. */
const STDOUT_LIMIT = 4 * 1024 * 1024;
/** The shortest schedule a script can have. */
const MIN_EVERY_MS = 60_000;
const sameCommand = Schema.toEquivalence(Scripts.ScriptCommand);
const sameDelivery = Schema.toEquivalence(KanbanScriptDeliveryRef);

export interface NewScript {
  readonly boardId: KanbanBoard["id"];
  readonly name: string;
  readonly path: string;
  readonly trigger: KanbanScriptTrigger;
  readonly enabled?: boolean | undefined;
}

// Cron lines run in the process's zone (see Scripts.cronProblem), so that's the zone shown.
// Every script record the server returns or publishes goes through this, so a
// client never loses the zone by taking a record from a write or a feed.
const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const withZone = (script: KanbanScript): KanbanScript =>
  script.trigger._tag === "schedule" && script.trigger.cron !== null
    ? { ...script, trigger: { ...script.trigger, timeZone: serverZone } }
    : script;

export interface KanbanScriptsShape {
  readonly scripts: (
    boardId: KanbanBoard["id"],
  ) => Effect.Effect<ReadonlyArray<KanbanScript>, KanbanError>;
  readonly runs: (
    scriptId: KanbanScript["id"],
    limit: number,
  ) => Effect.Effect<ReadonlyArray<KanbanScriptRun>, KanbanError>;
  readonly register: (
    input: NewScript,
    actor: KanbanActor,
  ) => Effect.Effect<KanbanScript, KanbanError>;
  readonly setEnabled: (
    scriptId: KanbanScript["id"],
    enabled: boolean,
  ) => Effect.Effect<KanbanScript, KanbanError>;
  /** Clears operator-checked unresolved outcomes without requeueing or sending them. */
  readonly acknowledge: (
    input: KanbanScriptAcknowledgeInput,
  ) => Effect.Effect<KanbanScript, KanbanError>;
  /** Starts a run now and returns it open; it finishes in the background. */
  readonly run: (
    scriptId: KanbanScript["id"],
    trigger: string,
  ) => Effect.Effect<KanbanScriptRun, KanbanError>;
  /** Starts the scheduled scripts that are due, and the wait checks once waits are live. */
  readonly tick: Effect.Effect<void, KanbanError>;
  /**
   * One pass over the cards waiting on a script: each script whose rest is
   * over runs once with all its cards on stdin, and its output answers them.
   * Runs outside the board lock; `tick` calls it once waits are live.
   */
  readonly checkWaits: Effect.Effect<void, KanbanError>;
  /**
   * Starts event scripts as board changes come in, from the moment this
   * returns until the scope closes.
   */
  readonly listen: Effect.Effect<void, KanbanError, Scope.Scope>;
  /** Closes the runs a stopped server left open. */
  readonly recover: Effect.Effect<void, KanbanError>;
  /** Waits until no script is running. */
  readonly idle: Effect.Effect<void>;
}

export class KanbanScripts extends Context.Service<KanbanScripts, KanbanScriptsShape>()(
  "t3/ardud/kanban/engine/ScriptService/KanbanScripts",
) {}

const isKanbanError = Schema.is(KanbanError);

const asKanbanError = (error: unknown): KanbanError =>
  isKanbanError(error)
    ? error
    : new KanbanError({
        code: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });

const fail = (code: KanbanError["code"], detail: string) =>
  Effect.fail(new KanbanError({ code, detail, saved: false }));

const isFile = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      (stat) => stat.isFile(),
      () => false,
    ),
  );

/** Why a trigger can't be used, or null. */
export const triggerProblem = (trigger: KanbanScriptTrigger, nowMs: number): string | null => {
  if (trigger._tag !== "schedule") return null;
  if ((trigger.everyMs === null) === (trigger.cron === null)) {
    return "A schedule needs either everyMs or cron.";
  }
  if (trigger.everyMs !== null && trigger.everyMs < MIN_EVERY_MS) {
    return "A script runs at most once a minute.";
  }
  return trigger.cron === null ? null : Scripts.cronProblem(trigger.cron, nowMs);
};

interface Pending {
  readonly trigger: string;
  readonly event: string | null;
}

/** The cards one check run was asked about, and what it reads on stdin. */
interface WaitBatch {
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly stdin: string;
}

/** The trigger a wait-check run is recorded with. */
export const WAIT_CHECK_TRIGGER = "wait-check";

// A script that is running: `done` completes when this run ends, and `next` is
// the one run asked for while it ran (the newest ask wins).
interface Slot {
  readonly done: Deferred.Deferred<void>;
  readonly next: Pending | null;
}

type Slots = ReadonlyMap<KanbanScript["id"], Slot>;

const make = Effect.gen(function* () {
  const context = yield* Effect.context<ServerSettings.ServerSettingsService>();
  const routingEnabled = selectionRoutingEnabled.pipe(Effect.provideContext(context));
  const settings = yield* ServerSettings.ServerSettingsService;
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const bridgeEntry = import.meta.url.endsWith(".ts")
    ? NodeURL.fileURLToPath(new URL("../../../bin.ts", import.meta.url))
    : NodeURL.fileURLToPath(new URL("./bin.mjs", import.meta.url));
  const bridgeCommand = [
    executable,
    ...(isExecutable ? [] : [bridgeEntry]),
    "__kanban-resolve-selection",
  ];
  const store = yield* KanbanStore;
  const service = yield* KanbanService;
  // Host readings for the PRs script waits point at; without the reader a
  // check still gets the states on the card's own links.
  const waitPrs = yield* Effect.serviceOption(KanbanWaitPrs);
  if (Waits.WAITS_ENGINE_WIRED && Option.isNone(waitPrs)) {
    yield* Effect.logWarning(
      "board scripts: no wait PR reader is provided, so script checks only see PR states already on their cards",
    );
  }
  // When each script last ran its checks, by board and name. In memory: a
  // restart checks once more, which costs one run.
  const waitChecks = new Map<string, number>();
  const scope = yield* Effect.scope;
  // One run per script. A slot is taken, and handed to the next run, in one
  // step, so nothing can land between a run ending and the next one starting.
  const slots = yield* Ref.make<Slots>(new Map());
  // Whole-record writes take turns on their board, without blocking other boards.
  const writes = new Map<KanbanBoard["id"], Semaphore.Semaphore>();

  const io = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(asKanbanError));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const scriptOf = Effect.fn("KanbanScripts.scriptOf")(function* (scriptId: KanbanScript["id"]) {
    const script = yield* io(store.script(scriptId));
    return script ?? (yield* fail("not-found", `No script ${scriptId}.`));
  });

  const save = Effect.fn("KanbanScripts.save")(function* (script: KanbanScript) {
    yield* io(store.putScript(script));
    const shown = withZone(script);
    yield* service.announce(script.boardId, { _tag: "script", script: shown });
    return shown;
  });

  const saveRun = Effect.fn("KanbanScripts.saveRun")(function* (
    boardId: KanbanBoard["id"],
    run: KanbanScriptRun,
  ) {
    yield* io(store.putScriptRun(run));
    yield* service.announce(boardId, { _tag: "scriptRun", run });
  });

  // The script's own discussion, for posts that name no other one.
  const ownDiscussion = Effect.fn("KanbanScripts.ownDiscussion")(function* (script: KanbanScript) {
    const all = yield* service.discussions(script.boardId);
    const own = all.find(
      (discussion) =>
        discussion.archivedAt === null &&
        discussion.createdBy._tag === "script" &&
        discussion.createdBy.scriptId === script.id,
    );
    return (
      own ??
      (yield* service.createDiscussion(script.boardId, `Script: ${script.name}`, {
        _tag: "script",
        scriptId: script.id,
      }))
    );
  });

  const targetOf = Effect.fn("KanbanScripts.targetOf")(function* (
    script: KanbanScript,
    command: Scripts.PostCommand,
    cards: ReadonlyArray<KanbanCard>,
  ) {
    if (command.discussion !== undefined) {
      const id = command.discussion.trim();
      if (id.length === 0) return yield* fail("invalid", "The discussion id is empty.");
      const discussion: KanbanDiscussion = yield* service.discussion(KanbanDiscussionId.make(id));
      if (discussion.boardId !== script.boardId) {
        return yield* fail("invalid", `Discussion ${id} is on another board.`);
      }
      return discussion;
    }
    if (command.card !== undefined) {
      const card = cards.find((entry) => entry.number === command.card);
      if (!card) return yield* fail("not-found", `No card #${command.card} on this board.`);
      return yield* service.cardDiscussion(card.id);
    }
    return yield* ownDiscussion(script);
  });

  // Only resizes a pool the board already has, keeping its full selection.
  const resizePool = Effect.fn("KanbanScripts.resizePool")(function* (
    script: KanbanScript,
    command: Scripts.PoolCommand,
  ) {
    const pools = yield* io(store.pools(script.boardId));
    const exact = pools.filter((entry) => entry.key === command.model);
    if (exact.length > 1) return `More than one pool has key ${command.model}.`;
    const keyedPool = exact[0];
    const apply = yield* routingEnabled;
    // A stored pool key names its captured selection, not an OpenCode model id.
    const selected = modelSelectionResult(
      keyedPool === undefined
        ? command
        : {
            ...command,
            model: keyedPool.model.model,
            instanceId: command.instanceId ?? keyedPool.model.instanceId,
          },
      apply,
    );
    if (selected.kind === "conflict") {
      return `Couldn't resize the ${command.model} pool: ${selected.reason}`;
    }
    const namedLevel = selectionEffort(selected.selection);
    if (
      keyedPool &&
      ((command.instanceId !== undefined && command.instanceId !== keyedPool.model.instanceId) ||
        (namedLevel !== null && namedLevel !== Rules.modelLevel(keyedPool.model)))
    ) {
      return `The pool key ${command.model} conflicts with its instance or effort.`;
    }
    const mapped =
      apply &&
      (selected.selection.instanceId !== (command.instanceId ?? "opencode") ||
        selected.selection.model !== command.model);
    const same = pools.filter(
      (entry) =>
        entry.model.model === selected.selection.model &&
        (mapped
          ? entry.model.instanceId === selected.selection.instanceId
          : command.instanceId === undefined || entry.model.instanceId === command.instanceId),
    );
    if (!keyedPool && namedLevel === null && same.length > 1) {
      const levels = same.map((entry) => Rules.modelLevel(entry.model) ?? "no level").join(", ");
      return `The ${command.model} pools run at ${levels}; name the variant.`;
    }
    const matching =
      namedLevel === null
        ? same
        : same.filter((entry) => Rules.modelLevel(entry.model) === namedLevel);
    if (!keyedPool && matching.length > 1) {
      return `More than one pool matches ${command.model} ${namedLevel ?? ""}.`;
    }
    const pool = keyedPool ?? matching[0];
    if (!pool) {
      return `There's no ${command.model}${namedLevel ? ` ${namedLevel}` : ""} pool on this board.`;
    }
    const resized = yield* Effect.result(
      service.setPool(script.boardId, pool.model, command.slots),
    );
    return Result.isSuccess(resized)
      ? `Set the ${command.model} pool to ${command.slots} ${command.slots === 1 ? "slot" : "slots"}.`
      : `Couldn't resize the ${command.model} pool: ${resized.failure.detail}`;
  });

  // A malformed command cannot become valid by replaying it after board configuration changes.
  class InvalidScriptCommand extends Schema.TaggedError<InvalidScriptCommand>()(
    "InvalidScriptCommand",
    {
      detail: Schema.String,
    },
  ) {}
  const invalidCommand = (detail: string) => Effect.fail(new InvalidScriptCommand({ detail }));

  // Share the same commit-start and receipt evidence as savedReply. A known or possible
  // save wins over an error's earlier admission result, including a later follow-up failure.
  const observeWrite = Effect.fn("KanbanScripts.observeWrite")(function* <A, R>(
    effect: Effect.Effect<A, KanbanError | InvalidScriptCommand, R>,
  ) {
    const parent = yield* SavedWrite.observer;
    const parentCommitting = yield* SavedWrite.commitObserver;
    let receipt = false;
    let commitStarted = false;
    return yield* effect.pipe(
      Effect.provideService(SavedWrite.observer, (saved) => {
        receipt = true;
        parent(saved);
      }),
      Effect.provideService(SavedWrite.commitObserver, () => {
        commitStarted = true;
        parentCommitting();
      }),
      Effect.mapError((error) =>
        error._tag === "InvalidScriptCommand"
          ? error
          : new KanbanError({
              ...error,
              saved:
                receipt || error.saved === true
                  ? true
                  : commitStarted || error.saved === null
                    ? null
                    : false,
            }),
      ),
    );
  });

  const retryWrite = Effect.fn("KanbanScripts.retryWrite")(function* <A, R>(
    effect: Effect.Effect<A, KanbanError | InvalidScriptCommand, R>,
    budget = 4,
  ) {
    const delays = [3_000, 10_000, 30_000];
    let attempts = 0;
    while (true) {
      const result = yield* Effect.result(effect);
      attempts += 1;
      if (
        Result.isSuccess(result) ||
        result.failure._tag !== "KanbanError" ||
        result.failure.code !== "conflict" ||
        result.failure.saved !== false ||
        attempts >= Math.min(budget, 4)
      )
        return { result, attempts };
      yield* Effect.sleep(delays[attempts - 1]!);
    }
  });

  // Even rejected input must be safe to include in the delivery notice.
  // eslint-disable-next-line no-control-regex -- Rejected command text must be printable in a board message.
  const labelText = (text: string) => text.slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, " ");
  const commandLabel = (command: Scripts.ScriptCommand) => {
    switch (command.kanban) {
      case "card":
        return `card: ${labelText(command.title || command.prompt)}`;
      case "post":
        return `post: ${labelText(command.text)}`;
      case "pool":
        return `pool: ${command.model}`;
      default:
        return `${command.kanban}: card #${command.card}`;
    }
  };

  const writeCommand = Effect.fn("KanbanScripts.writeCommand")(function* (
    script: KanbanScript,
    command: Exclude<Scripts.ScriptCommand, Scripts.PoolCommand>,
  ) {
    const actor: KanbanActor = { _tag: "script", scriptId: script.id };
    // Re-read on every attempt: another writer may have delivered the card during backoff.
    const cards =
      command.kanban === "post" && command.card === undefined
        ? []
        : yield* observeWrite(io(store.cards(script.boardId)));
    if (command.kanban === "card") {
      const problem = Text.textProblem([
        ["title", command.title],
        ["description", command.description],
        ["prompt", command.prompt],
      ]);
      if (problem) return yield* invalidCommand(problem);
      if (!command.prompt.trim() && !command.title?.trim()) {
        return yield* invalidCommand("a card needs a prompt or a title");
      }
      const existing = Scripts.duplicateOf(cards, command);
      if (existing) return `Card #${existing.number} is already on the board.`;
      const created = yield* observeWrite(
        service.createCard(
          script.boardId,
          {
            prompt: command.prompt,
            title: command.title,
            description: command.description,
            priority: command.priority,
            projects: command.projects,
            links: command.links,
          },
          actor,
        ),
      );
      return `Added card #${created.number}.`;
    }
    if (command.kanban === "post") {
      const problem = Text.textProblem([["message", command.text]]);
      if (problem) return yield* invalidCommand(problem);
      const discussion = yield* observeWrite(targetOf(script, command, cards)).pipe(
        Effect.catchIf(
          (error) => error._tag === "KanbanError" && error.code === "invalid",
          (error) => invalidCommand(error.detail),
        ),
      );
      yield* observeWrite(service.post(discussion.id, actor, [{ _tag: "md", text: command.text }]));
      return `Posted in "${discussion.title}".`;
    }
    const card = cards.find((entry) => entry.number === command.card);
    if (!card) return yield* fail("not-found", `No card #${command.card} on this board.`);
    if (command.kanban === "subtask") {
      yield* observeWrite(
        service.markSubtask(
          card.id,
          command.subtask,
          command.state,
          command.note ?? null,
          actor,
          "script",
        ),
      );
      return `Marked ${command.subtask} ${command.state} on card #${command.card}.`;
    }
    if (command.kanban === "handback") {
      yield* observeWrite(service.handBack(card.id, command.subtask, command.note, actor));
      return `Handed ${command.subtask} on card #${command.card} back to the evaluator.`;
    }
    yield* observeWrite(
      service.moveCard(card.id, command.to, "script", actor, { note: command.note ?? null }),
    );
    return `Moved card #${command.card} to ${command.to}.`;
  });

  // Applies held work first, then what the child printed. A bad command never stops its siblings.
  const apply = Effect.fn("KanbanScripts.apply")(function* (
    script: KanbanScript,
    commands: ReadonlyArray<Scripts.ScriptCommand>,
  ) {
    type Held = NonNullable<KanbanScript["held"]>[number];
    const notes: Array<string> = [];
    const notices: Array<string> = [];
    type Unresolved = NonNullable<KanbanScript["unresolved"]>[number];
    const latest = yield* scriptOf(script.id);
    let held = [...(latest.held ?? [])];
    let unresolved = [...(latest.unresolved ?? [])];
    const saveDelivery = () =>
      update(script.id, (record) => ({
        ...record,
        held: [...held],
        unresolved: [...unresolved],
      }));
    const limitHeld = () => {
      held.sort((a, b) => a.firstFailedAt.localeCompare(b.firstFailedAt));
      while (held.length > 100) {
        const dropped = held.shift()!;
        const note = `Dropped ${commandLabel(dropped.command)}: ${dropped.lastError} (100 command limit; will not retry).`;
        notes.push(note);
        notices.push(note);
      }
    };
    for (const entry of unresolved) {
      if (!entry.reported) {
        notices.push(
          `Unresolved ${commandLabel(entry.command)}: ${entry.lastError} Will not retry; check the board.`,
        );
      }
    }
    const pending = [
      ...held.map((entry) => ({ command: entry.command, previous: entry as Held | null })),
      ...commands.map((command) => ({ command, previous: null as Held | null })),
    ];
    for (const { command, previous } of pending) {
      const label = commandLabel(command);
      if (unresolved.some((entry) => sameCommand(entry.command, command))) {
        if (previous !== null) {
          held = held.filter((entry) => entry !== previous);
          yield* saveDelivery();
        }
        notes.push(`Skipped unresolved ${label}: check the board before retrying.`);
        continue;
      }
      if (previous !== null) {
        if (!held.includes(previous)) continue;
        const age =
          DateTime.toEpochMillis(yield* DateTime.now) - Date.parse(previous.firstFailedAt);
        if (age >= 24 * 60 * 60_000 || previous.attempts >= 10) {
          held = held.filter((entry) => entry !== previous);
          yield* saveDelivery();
          const note = `Dropped ${label}: ${previous.lastError} (${age >= 24 * 60 * 60_000 ? "24 hours old" : "10 attempts"}; will not retry).`;
          notes.push(note);
          notices.push(note);
          continue;
        }
      }
      if (command.kanban === "pool") {
        notes.push(yield* resizePool(script, command));
        continue;
      }
      const firstFailedAt = previous?.firstFailedAt ?? (yield* nowIso);
      if ((command.kanban === "card" || command.kanban === "post") && unresolved.length >= 100) {
        const error = "100 unresolved deliveries need reconciliation before sending more commands.";
        if (previous === null) held.push({ command, firstFailedAt, lastError: error, attempts: 0 });
        limitHeld();
        yield* saveDelivery();
        notes.push(`Held ${label}: ${error}`);
        notices.push(`Held ${label}: ${error} Will retry next run.`);
        continue;
      }
      let current = previous;
      let attempted = 0;
      const write = writeCommand(script, command);
      const trackedWrite =
        command.kanban === "card" || command.kanban === "post"
          ? Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                attempted += 1;
                held = held.filter((entry) => entry !== current);
                const active: Unresolved = {
                  command,
                  firstFailedAt,
                  lastError: "Delivery started; its outcome is unknown.",
                  attempts: (previous?.attempts ?? 0) + attempted,
                };
                unresolved.push(active);
                // Persist before sending; an interrupted call stays visible but cannot be replayed.
                yield* saveDelivery();
                const result = yield* Effect.result(restore(write));
                if (
                  Result.isFailure(result) &&
                  result.failure._tag === "KanbanError" &&
                  result.failure.saved === null
                ) {
                  const error = result.failure;
                  unresolved = unresolved.map((entry) =>
                    entry === active ? { ...active, lastError: error.detail } : entry,
                  );
                } else {
                  unresolved = unresolved.filter((entry) => entry !== active);
                  if (
                    Result.isFailure(result) &&
                    result.failure._tag !== "InvalidScriptCommand" &&
                    result.failure.saved === false
                  ) {
                    current = { ...active, lastError: result.failure.detail };
                    held.push(current);
                    limitHeld();
                  } else current = null;
                }
                // Mask settlement only: a known not-written result is durable before any sleep/interrupt.
                yield* saveDelivery();
                if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
                return result.success;
              }),
            )
          : write;
      const { result, attempts } = yield* retryWrite(trackedWrite, 10 - (previous?.attempts ?? 0));
      if (Result.isSuccess(result)) {
        notes.push(
          attempts > 1
            ? `${result.success.replace(/\.$/, "")} after ${attempts - 1} ${attempts === 2 ? "retry" : "retries"}.`
            : result.success,
        );
        if (previous !== null) notices.push(`Delivered held ${label}.`);
        continue;
      }
      const error = result.failure;
      if (error._tag === "KanbanError" && error.saved === true) {
        notes.push(`Saved ${label}; follow-up failed: ${error.detail} Will not retry.`);
        if (previous !== null) notices.push(`Delivered held ${label}.`);
        continue;
      }
      const prefix =
        command.kanban === "card"
          ? "add a card"
          : command.kanban === "post"
            ? "post"
            : command.kanban === "move"
              ? `move card #${command.card}`
              : command.kanban === "handback"
                ? `hand ${command.subtask} on card #${command.card} back`
                : `mark ${command.subtask} on card #${command.card}`;
      notes.push(`Couldn't ${prefix}: ${error.detail}`);
      if (command.kanban !== "card" && command.kanban !== "post") continue;
      if (error._tag === "KanbanError" && error.saved !== false) {
        notices.push(`${label}: ${error.detail} Will not retry; check the board.`);
        continue;
      }
      const total = (previous?.attempts ?? 0) + attempts;
      if (error._tag === "InvalidScriptCommand" || total >= 10) {
        held = held.filter((entry) => entry !== current);
        yield* saveDelivery();
        const note = `Dropped ${label}: ${error.detail} (${total >= 10 ? "10 attempts" : "invalid command"}; will not retry).`;
        notes.push(note);
        notices.push(note);
        continue;
      }
      notices.push(`Held ${label}: ${error.detail} Will retry next run.`);
    }
    if (notices.length > 0) {
      const notice = yield* retryWrite(
        ownDiscussion(script).pipe(
          Effect.flatMap((discussion) =>
            service.post(discussion.id, { _tag: "script", scriptId: script.id }, [
              { _tag: "md", text: notices.join("\n") },
            ]),
          ),
        ),
      );
      if (Result.isFailure(notice.result)) {
        notes.push(`Couldn't post delivery notice: ${notice.result.failure.detail}`);
      } else if (unresolved.length > 0) {
        unresolved = unresolved.map((entry) => ({ ...entry, reported: true }));
        yield* saveDelivery();
      }
    }
    return { notes, heldCount: held.length };
  });

  // Applies what the script printed about waits. A check run also answers for
  // the cards it printed nothing about: no line is a hold, and a run that
  // failed is a failed check for each of them. The answers go to the board in
  // one write (`answerWaits`), which reads the board once however many cards
  // wait on the script; a park line is its own write, so the answers printed
  // before it are applied first.
  const applyWaits = Effect.fn("KanbanScripts.applyWaits")(function* (
    script: KanbanScript,
    lines: ReadonlyArray<Scripts.WaitLine>,
    check: WaitBatch | null,
    failed: string | null,
  ) {
    const notes: Array<string> = [];
    if (lines.length === 0 && check === null) return notes;
    const actor: KanbanActor = { _tag: "script", scriptId: script.id };
    const answered = new Set<string>();
    // The waits this check was asked about, as they were when its input was built.
    // An answer is for that wait: if the card waits on another one by now (the
    // same script with other args, say), it is dropped.
    const asked = new Map(
      (check?.cards ?? []).flatMap((card) =>
        card.wait === undefined ? [] : [[card.id as string, Waits.waitIdentity(card.wait)]],
      ),
    );
    const askedByNumber = new Map((check?.cards ?? []).map((card) => [card.number, card.id]));
    // Answers not yet sent, each with the card number its note names (null: no note).
    // One refused before it is sent has no answer, only the reason.
    let pending: Array<
      | { readonly answer: WaitAnswerFor; readonly line: number | null }
      | { readonly answer: null; readonly line: number; readonly refused: string }
    > = [];
    const flush = Effect.gen(function* () {
      if (pending.length === 0) return;
      const sending = pending;
      pending = [];
      const answers = sending.flatMap((entry) => (entry.answer === null ? [] : [entry.answer]));
      const result =
        answers.length === 0
          ? null
          : yield* Effect.result(service.answerWaits(script.boardId, answers, actor));
      let sent = 0;
      for (const entry of sending) {
        if (entry.answer === null) {
          notes.push(`Refused for card #${entry.line}: ${entry.refused}`);
          continue;
        }
        const index = sent;
        sent += 1;
        if (result === null) continue;
        const outcome = Result.isSuccess(result) ? result.success[index] : undefined;
        // The card may have moved on while the script ran; for a card the script
        // printed nothing about, that refusal is not news.
        if (entry.line === null) continue;
        notes.push(
          outcome?.ok === true
            ? outcome.text
            : `Refused for card #${entry.line}: ${
                outcome?.detail ??
                (Result.isFailure(result) ? result.failure.detail : "nothing changed")
              }`,
        );
      }
    });
    for (const line of lines) {
      if (line._tag === "park") {
        yield* flush;
        const card = yield* io(store.cardByNumber(script.boardId, line.card));
        if (!card) {
          notes.push(`Refused for card #${line.card}: No card #${line.card} on this board.`);
          continue;
        }
        const target =
          line.waitsOn === null
            ? null
            : yield* io(store.cardByNumber(script.boardId, line.waitsOn));
        if (line.waitsOn !== null && target === null) {
          notes.push(`Couldn't park card #${line.card}: No card #${line.waitsOn} on this board.`);
          continue;
        }
        const parked = yield* Effect.result(
          service.waitCard(card.id, { ...line.request, card: target?.id ?? null }, actor),
        );
        notes.push(
          Result.isSuccess(parked)
            ? `Card #${line.card} now waits (${line.request.on}).`
            : `Couldn't park card #${line.card}: ${parked.failure.detail}`,
        );
        continue;
      }
      const askedId = askedByNumber.get(line.card);
      // A check answers for the cards it was asked about and no other. A card that
      // started waiting on this script while the check ran was never in its input, so
      // whatever the script printed for it (a cached line, say) says nothing about its
      // wait. A wake line is the way to end a wait from outside its check.
      if (line._tag === "answer" && check !== null && askedId === undefined) {
        pending.push({
          line: line.card,
          answer: null,
          refused: `this check was not asked about card #${line.card}, so it cannot answer for it. Its wait, if it has one on this script, is checked on the next run; a wake line ends a wait from outside its check.`,
        });
        continue;
      }
      // Answered, as far as the rest of this run goes, whatever the board makes of it.
      if (line._tag === "answer" && askedId !== undefined) answered.add(askedId);
      pending.push({
        line: line.card,
        answer:
          line._tag === "wake"
            ? { card: line.card, answer: line.answer, script: null, expect: line.wait }
            : {
                card: line.card,
                answer: line.answer,
                script: script.name,
                expect: askedId === undefined ? null : (asked.get(askedId) ?? null),
              },
      });
    }
    for (const card of check?.cards ?? []) {
      if (answered.has(card.id)) continue;
      pending.push({
        line: null,
        answer: {
          card: card.id,
          answer: failed === null ? { result: "hold" } : { result: "fail", reason: failed },
          script: script.name,
          expect: asked.get(card.id) ?? null,
        },
      });
    }
    yield* flush;
    return notes;
  });

  // Reads the record again under the lock and changes only what the caller
  // owns, so a toggle can't undo a run's lastRun, or the other way round.
  const update = Effect.fn("KanbanScripts.update")(function* (
    scriptId: KanbanScript["id"],
    change: (script: KanbanScript) => KanbanScript,
  ) {
    // A script stays on its registered board; this read only chooses the lock.
    const { boardId } = yield* scriptOf(scriptId);
    let lock = writes.get(boardId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      writes.set(boardId, lock);
    }
    const { script, changed } = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const latest = yield* scriptOf(scriptId);
        const next = change(latest);
        if (next !== latest) yield* io(store.putScript(next));
        return { script: withZone(next), changed: next !== latest };
      }),
    );
    // Publishing must not extend the read/modify/write critical section.
    if (changed) yield* service.announce(boardId, { _tag: "script", script });
    return script;
  });

  const open = Effect.fn("KanbanScripts.open")(function* (script: KanbanScript, trigger: string) {
    const startedAt = yield* nowIso;
    const run = yield* io(
      store.addScriptRun({
        scriptId: script.id,
        startedAt,
        endedAt: null,
        exitCode: null,
        output: "",
        trigger,
      }),
    );
    yield* service.announce(script.boardId, { _tag: "scriptRun", run }).pipe(
      Effect.andThen(
        update(script.id, (latest) => ({
          ...latest,
          lastRun: { startedAt, endedAt: null, exitCode: null },
        })),
      ),
      // The row exists now; don't leave it showing as running.
      Effect.onError(() =>
        nowIso.pipe(
          Effect.flatMap((endedAt) =>
            saveRun(script.boardId, { ...run, endedAt, output: "Robob couldn't start this run." }),
          ),
          Effect.ignore,
        ),
      ),
    );
    return run;
  });

  const close = Effect.fn("KanbanScripts.close")(function* (
    script: KanbanScript,
    run: KanbanScriptRun,
    exitCode: number | null,
    output: string,
    heldCount = 0,
  ) {
    const endedAt = yield* nowIso;
    const summary = heldCount > 0 ? `Held ${heldCount} command(s) for retry\n` : "";
    yield* saveRun(script.boardId, {
      ...run,
      endedAt,
      exitCode,
      output:
        summary + Scripts.tail(output, Scripts.OUTPUT_TAIL_BYTES - Buffer.byteLength(summary)),
    });
    yield* update(script.id, (latest) => ({
      ...latest,
      lastRun: { startedAt: run.startedAt, endedAt, exitCode },
    }));
  });

  const execute = Effect.fn("KanbanScripts.execute")(function* (
    script: KanbanScript,
    run: KanbanScriptRun,
    event: string | null,
    check: WaitBatch | null,
  ) {
    const interpreter = Scripts.interpreterFor(script.path);
    if (interpreter === null || !(yield* isFile(script.path))) {
      yield* applyWaits(script, [], check, `There is no script at ${script.path}`);
      return yield* close(script, run, null, `There is no script at ${script.path}.`);
    }
    const current = yield* settings.getSettings.pipe(Effect.mapError(asKanbanError));
    const result = yield* runProcess({
      argv: [interpreter, script.path],
      cwd: NodePath.dirname(script.path),
      env: {
        ...scriptEnv(process.env),
        KANBAN_BOARD_ID: script.boardId,
        KANBAN_SCRIPT_ID: script.id,
        KANBAN_TRIGGER: run.trigger,
        KANBAN_HARNESS_MIGRATION: JSON.stringify(current.ardudHarnessMigration ?? {}),
        KANBAN_HARNESS_ROUTING_COMMAND: JSON.stringify(bridgeCommand),
        ...(event === null ? {} : { KANBAN_EVENT: event }),
      },
      timeoutMs: RUN_TIMEOUT_MS,
      outputBytes: STDOUT_LIMIT,
      stdin: check?.stdin,
    });
    const parsed = Scripts.parseOutput(result.stdout);
    const broke = Scripts.checkRunProblem(script.name, result, RUN_TIMEOUT_MS);
    const { notes, heldCount } = yield* apply(script, parsed.commands);
    notes.push(...(yield* applyWaits(script, parsed.waits, check, broke)));
    const problems = [
      result.spawnError === null ? null : `It didn't start: ${result.spawnError}`,
      result.timedOut ? `Stopped after ${RUN_TIMEOUT_MS / 60_000} minutes.` : null,
      result.overflow ? "Stopped: it printed too much." : null,
      ...parsed.errors,
    ].filter((line): line is string => line !== null);
    const output = [notes.join("\n"), parsed.text, result.stderr.trim(), problems.join("\n")]
      .filter((part) => part.length > 0)
      .join("\n\n");
    yield* close(script, run, result.exitCode, output, heldCount);
  });

  const claim = (scriptId: KanbanScript["id"], done: Deferred.Deferred<void>) =>
    Ref.modify(slots, (map): readonly [boolean, Slots] =>
      map.has(scriptId) ? [false, map] : [true, new Map(map).set(scriptId, { done, next: null })],
    );

  // Frees the slot if this run still holds it.
  const release = (scriptId: KanbanScript["id"], done: Deferred.Deferred<void>) =>
    Ref.update(slots, (map) => {
      if (map.get(scriptId)?.done !== done) return map;
      const next = new Map(map);
      next.delete(scriptId);
      return next;
    }).pipe(Effect.andThen(Deferred.succeed(done, undefined)));

  // The slot is already this run's. Callers keep this uninterruptible, so a
  // slot is never taken without a run that will free it.
  const launch = (
    script: KanbanScript,
    trigger: string,
    event: string | null,
    done: Deferred.Deferred<void>,
    check: WaitBatch | null = null,
  ): Effect.Effect<KanbanScriptRun, KanbanError> =>
    open(script, trigger).pipe(
      Effect.tap((run) =>
        Effect.forkIn(SavedWrite.background(finish(script, run, event, done, check)), scope),
      ),
      Effect.onError(() => release(script.id, done)),
    );

  // The run is over: the run asked for meanwhile takes the slot over, or the
  // slot is freed. One step, so an event can't land in between and be lost.
  const handOff = Effect.fn("KanbanScripts.handOff")(function* (
    scriptId: KanbanScript["id"],
    done: Deferred.Deferred<void>,
  ) {
    const nextDone = yield* Deferred.make<void>();
    const next = yield* Ref.modify(slots, (map): readonly [Pending | null, Slots] => {
      const slot = map.get(scriptId);
      if (slot === undefined || slot.done !== done) return [null, map];
      const rest = new Map(map);
      if (slot.next === null) {
        rest.delete(scriptId);
        return [null, rest];
      }
      rest.set(scriptId, { done: nextDone, next: null });
      return [slot.next, rest];
    });
    yield* Deferred.succeed(done, undefined);
    if (next === null) return;
    yield* scriptOf(scriptId).pipe(
      Effect.flatMap((script) =>
        script.enabled
          ? Effect.asVoid(launch(script, next.trigger, next.event, nextDone))
          : release(scriptId, nextDone),
      ),
      Effect.onError(() => release(scriptId, nextDone)),
      Effect.catchCause((cause) =>
        Effect.logWarning("board script did not start", {
          scriptId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  }, Effect.uninterruptible);

  // Runs in the background. A failure closes the run with what went wrong.
  const finish = (
    script: KanbanScript,
    run: KanbanScriptRun,
    event: string | null,
    done: Deferred.Deferred<void>,
    check: WaitBatch | null,
  ): Effect.Effect<void> =>
    execute(script, run, event, check).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board script run failed", {
          scriptId: script.id,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.andThen(close(script, run, null, `The run failed: ${Cause.pretty(cause)}`)),
          Effect.ignore,
        ),
      ),
      Effect.andThen(handOff(script.id, done)),
      // Only does anything when the run was cut short; handOff already let go.
      Effect.ensuring(release(script.id, done)),
    );

  /** Opens a run and lets it finish in the background; conflict while one is going. */
  const start = Effect.fn("KanbanScripts.start")(function* (
    scriptId: KanbanScript["id"],
    trigger: string,
    event: string | null,
  ) {
    const script = yield* scriptOf(scriptId);
    const done = yield* Deferred.make<void>();
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (!(yield* claim(scriptId, done))) {
          return yield* fail("conflict", `${script.name} is already running.`);
        }
        return yield* launch(script, trigger, event, done);
      }),
    );
  });

  // Event runs never fail the caller. A busy script runs once more when it
  // ends, with the newest event.
  const fire = Effect.fn("KanbanScripts.fire")(function* (script: KanbanScript, event: string) {
    const done = yield* Deferred.make<void>();
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const claimed = yield* Ref.modify(slots, (map): readonly [boolean, Slots] => {
          const slot = map.get(script.id);
          if (slot === undefined) {
            return [true, new Map(map).set(script.id, { done, next: null })];
          }
          return [
            false,
            new Map(map).set(script.id, { ...slot, next: { trigger: "event", event } }),
          ];
        });
        if (claimed) yield* launch(script, "event", event, done);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board script did not start", {
          scriptId: script.id,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const scripts: KanbanScriptsShape["scripts"] = (boardId) =>
    io(store.scripts(boardId)).pipe(Effect.map((list) => list.map(withZone)));

  const runs: KanbanScriptsShape["runs"] = (scriptId, limit) =>
    io(store.scriptRuns(scriptId, Math.max(1, Math.min(limit, 200))));

  const register: KanbanScriptsShape["register"] = Effect.fn("KanbanScripts.register")(
    function* (input, actor) {
      const boards = yield* io(store.boards);
      if (!boards.some((board) => board.id === input.boardId)) {
        return yield* fail("not-found", `No board ${input.boardId}.`);
      }
      const name = input.name.trim();
      const path = input.path.trim();
      if (name.length === 0) return yield* fail("invalid", "A script needs a name.");
      if (!NodePath.isAbsolute(path)) return yield* fail("invalid", "Give the script's full path.");
      if (Scripts.interpreterFor(path) === null) {
        return yield* fail("invalid", "Scripts run by extension: .ts, .js, .py, .sh or .zsh.");
      }
      if (!(yield* isFile(path))) return yield* fail("invalid", `There is no file at ${path}.`);
      const problem = triggerProblem(input.trigger, DateTime.toEpochMillis(yield* DateTime.now));
      if (problem !== null) return yield* fail("invalid", problem);
      return yield* save({
        id: KanbanScriptId.make(`script-${NodeCrypto.randomUUID()}`),
        boardId: input.boardId,
        name,
        path,
        trigger: input.trigger,
        enabled: input.enabled ?? true,
        createdBy: actor,
        createdAt: yield* nowIso,
        lastRun: null,
      });
    },
  );

  const setEnabled: KanbanScriptsShape["setEnabled"] = Effect.fn("KanbanScripts.setEnabled")(
    function* (scriptId, enabled) {
      if (!enabled) {
        // The run going now finishes; the one asked for after it doesn't happen.
        yield* Ref.update(slots, (map) => {
          const slot = map.get(scriptId);
          if (slot === undefined || slot.next === null) return map;
          return new Map(map).set(scriptId, { ...slot, next: null });
        });
      }
      return yield* update(scriptId, (latest) =>
        latest.enabled === enabled ? latest : { ...latest, enabled },
      );
    },
  );

  const acknowledge: KanbanScriptsShape["acknowledge"] = Effect.fn("KanbanScripts.acknowledge")(
    function* ({ scriptId, deliveries }) {
      if (deliveries.length === 0 || deliveries.length > 100) {
        return yield* fail("invalid", "Acknowledge between 1 and 100 checked deliveries.");
      }
      const done = yield* Deferred.make<void>();
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          // Own the script's slot so apply cannot overwrite the acknowledged set from its snapshot.
          if (!(yield* claim(scriptId, done))) {
            return yield* fail(
              "conflict",
              "The script is running. Wait for it to finish before acknowledging deliveries.",
            );
          }
          return yield* Effect.gen(function* () {
            const script = yield* scriptOf(scriptId);
            if (
              deliveries.some(
                (ref) => !script.unresolved?.some((entry) => sameDelivery(entry, ref)),
              )
            ) {
              return yield* fail(
                "conflict",
                "Unresolved deliveries changed. Read the script again before acknowledging them.",
              );
            }
            return yield* update(scriptId, (latest) => ({
              ...latest,
              unresolved: (latest.unresolved ?? []).filter(
                (entry) => !deliveries.some((ref) => sameDelivery(entry, ref)),
              ),
            }));
          }).pipe(Effect.ensuring(handOff(scriptId, done)));
        }),
      );
    },
  );

  const run: KanbanScriptsShape["run"] = Effect.fn("KanbanScripts.run")(
    function* (scriptId, trigger) {
      // The owner can still run a script that is off; a webhook caller can't.
      if (trigger === "webhook") {
        const script = yield* scriptOf(scriptId);
        if (!script.enabled) return yield* fail("conflict", `${script.name} is turned off.`);
      }
      return yield* start(scriptId, trigger, null);
    },
  );

  const tick: KanbanScriptsShape["tick"] = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const live = new Set(
      (yield* io(store.boards))
        .filter((board) => board.archivedAt === null)
        .map((board) => board.id),
    );
    const all = yield* io(store.allScripts);
    const busy = yield* Ref.get(slots);
    for (const script of all) {
      if (!live.has(script.boardId) || busy.has(script.id)) continue;
      // Each script on its own, so one bad record can't stop the ones after it.
      yield* Effect.suspend(() =>
        Scripts.isDue(script, now)
          ? Effect.asVoid(start(script.id, "schedule", null))
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board script did not start", {
            scriptId: script.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    // Inert until the board's own wait pass is live: a wait a script ended
    // would otherwise wake a card the planner doesn't yet hold back.
    if (Waits.WAITS_ENGINE_WIRED) yield* checkWaits;
  });

  // One script's checks for one board: the cards waiting on it, and the run that asks about them.
  const checkScript = Effect.fn("KanbanScripts.checkScript")(function* (
    board: KanbanBoard,
    name: string,
    cards: ReadonlyArray<KanbanCard>,
    scripts: ReadonlyArray<KanbanScript>,
    now: number,
  ) {
    const batch = cards.filter(
      (card) => kanbanWaiting(card) && card.wait?.on === "script" && card.wait.script === name,
    );
    const key = `${board.id}\n${name}`;
    const last = waitChecks.get(key);
    if (last !== undefined && now - last < Waits.scriptCheckEveryMs(batch)) return;
    const found = scripts.filter((script) => script.name === name);
    const script = found.length === 1 ? found[0] : undefined;
    if (script === undefined || !script.enabled) {
      waitChecks.set(key, now);
      const reason =
        script !== undefined
          ? `The ${name} script is turned off`
          : found.length === 0
            ? `This board has no script named ${name}`
            : `This board has ${found.length} scripts named ${name}`;
      yield* Effect.result(
        service.answerWaits(
          board.id,
          batch.map((card) => ({
            card: card.id,
            answer: { result: "fail" as const, reason },
            script: name,
            expect: card.wait === undefined ? null : Waits.waitIdentity(card.wait),
          })),
          { _tag: "system", component: "wait-checks" },
        ),
      );
      return;
    }
    const done = yield* Deferred.make<void>();
    const byId = new Map(cards.map((card) => [card.id as string, card]));
    // Script inputs include named settled dependencies, without scanning board history.
    for (const id of new Set(
      batch.flatMap((card) => [
        ...(card.wait?.card == null ? [] : [card.wait.card]),
        ...card.blockedBy,
      ]),
    )) {
      if (byId.has(id)) continue;
      const dependency = yield* io(store.card(KanbanCardId.make(id)));
      if (dependency?.boardId === board.id) byId.set(id, dependency);
    }
    const links = batch.flatMap((card) =>
      card.links.flatMap((link) =>
        link.kind === "pr" && link.state !== null
          ? [{ url: link.url, state: link.state, at: link.checkedAt }]
          : [],
      ),
    );
    const prs = Option.isSome(waitPrs)
      ? (yield* waitPrs.value.read(Waits.waitPrRequests(batch, board, links))).readings
      : [];
    const inputs = batch.flatMap((card) => {
      const input = Waits.checkInput(
        card,
        { nowMs: now, prs, cards: byId },
        { chainLength: Rules.chainFor(board, card)?.steps.length ?? 1 },
      );
      return input === null ? [] : [input];
    });
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        // Its own run is going: the checks wait for the next pass rather than queue behind it.
        if (!(yield* claim(script.id, done))) return;
        waitChecks.set(key, now);
        yield* launch(script, WAIT_CHECK_TRIGGER, null, done, {
          cards: batch,
          stdin: JSON.stringify(inputs),
        });
      }),
    );
  });

  const checkWaits: KanbanScriptsShape["checkWaits"] = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const board of yield* io(store.boards)) {
      if (board.archivedAt !== null) continue;
      const cards = yield* io(store.openCards(board.id));
      const names = new Set(
        cards.flatMap((card) =>
          kanbanWaiting(card) && card.wait?.on === "script" ? [card.wait.script ?? ""] : [],
        ),
      );
      if (names.size === 0) continue;
      const scripts = yield* io(store.scripts(board.id));
      for (const name of names) {
        // Each script on its own, so one bad record can't stop the ones after it.
        yield* checkScript(board, name, cards, scripts, now).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("board script wait check did not run", {
              boardId: board.id,
              script: name,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
    }
  });

  const listen: KanbanScriptsShape["listen"] = Effect.gen(function* () {
    const changes = yield* service.changes;
    const stages: Array<readonly [string, KanbanCard["stage"]]> = [];
    for (const board of yield* io(store.boards)) {
      for (const card of yield* io(store.cards(board.id))) stages.push([card.id, card.stage]);
    }
    const eventOf = Scripts.eventTracker(stages);
    // Not traced: it runs for every change on every board.
    const handle = Effect.fnUntraced(function* (entry: {
      readonly boardId: KanbanBoard["id"];
      readonly change: KanbanChange;
    }) {
      const event = eventOf(entry.change);
      if (event === null) return;
      const listening = (yield* io(store.scripts(entry.boardId))).filter((script) =>
        Scripts.listensTo(script, event),
      );
      if (listening.length === 0) return;
      if (entry.change._tag === "message") {
        // In a discussion a script posts in, scripts hear only the owner. A
        // script's post wakes an agent, and the agent's reply would wake the
        // script again.
        const discussion = yield* io(store.discussion(entry.change.message.discussionId));
        if (
          discussion !== null &&
          Scripts.isScriptDiscussion(discussion) &&
          event.by?._tag !== "owner"
        ) {
          return;
        }
      }
      const json = Scripts.eventJson(entry.boardId, event);
      for (const script of listening) yield* fire(script, json);
    });
    yield* Effect.forkScoped(
      Stream.runForEach(changes, (entry) =>
        handle(entry).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("board script event failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    );
  });

  const recover: KanbanScriptsShape["recover"] = Effect.gen(function* () {
    const at = yield* nowIso;
    const busy = yield* Ref.get(slots);
    // Only runs that began before now: one started since then is this server's.
    const leftOpen = (startedAt: string, endedAt: string | null) =>
      endedAt === null && startedAt < at;
    for (const script of yield* io(store.allScripts)) {
      if (busy.has(script.id)) continue;
      for (const open of yield* io(store.scriptRuns(script.id, 5))) {
        if (!leftOpen(open.startedAt, open.endedAt)) continue;
        yield* saveRun(script.boardId, {
          ...open,
          endedAt: at,
          output: [
            script.held?.length ? `Held ${script.held.length} command(s) for retry` : null,
            open.output,
            "Robob stopped during this run.",
            ...(script.unresolved ?? []).map(
              (entry) =>
                `Unresolved ${commandLabel(entry.command)}: ${entry.lastError} Will not retry; check the board.`,
            ),
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
      }
      if (script.lastRun !== null && leftOpen(script.lastRun.startedAt, script.lastRun.endedAt)) {
        yield* update(script.id, (latest) =>
          latest.lastRun !== null && leftOpen(latest.lastRun.startedAt, latest.lastRun.endedAt)
            ? { ...latest, lastRun: { ...latest.lastRun, endedAt: at } }
            : latest,
        );
      }
    }
  });

  const idle: KanbanScriptsShape["idle"] = Effect.gen(function* () {
    while (true) {
      const next = (yield* Ref.get(slots)).values().next();
      if (next.done) return;
      yield* Deferred.await(next.value.done);
    }
  });

  return KanbanScripts.of({
    scripts,
    runs,
    register,
    setEnabled,
    acknowledge,
    run,
    tick,
    checkWaits,
    listen,
    recover,
    idle,
  });
});

export const layer = Layer.effect(KanbanScripts, make);
