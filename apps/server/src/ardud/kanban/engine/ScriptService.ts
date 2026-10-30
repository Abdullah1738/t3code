// @effect-diagnostics nodeBuiltinImport:off - script files live on disk and runs get random ids.
// @effect-diagnostics globalDate:off - runs are stamped like every other board record.
/**
 * Board scripts: owner-approved programs the board runs on a schedule, on a
 * board event, or by hand. They run as plain child processes, with no model.
 * The lines they print with a `kanban` key become cards, discussion posts,
 * pool sizes, subtask ticks, hand-backs and card moves (see scripts.ts), and
 * every run keeps its output for the scripts page.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  KanbanDiscussionId,
  KanbanError,
  KanbanScriptId,
  type KanbanActor,
  type KanbanBoard,
  type KanbanCard,
  type KanbanChange,
  type KanbanDiscussion,
  type KanbanScript,
  type KanbanScriptRun,
  type KanbanScriptTrigger,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { runProcess, scriptEnv } from "./scriptRunner.ts";
import { KanbanStore } from "../store/KanbanStore.ts";
import { KanbanService } from "./KanbanService.ts";
import * as Scripts from "./scripts.ts";

/** A run past this is killed with its whole process group. */
const RUN_TIMEOUT_MS = 10 * 60_000;
/** stdout past this stops the run; commands come from stdout. */
const STDOUT_LIMIT = 4 * 1024 * 1024;
/** The shortest schedule a script can have. */
const MIN_EVERY_MS = 60_000;

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
  /** Starts a run now and returns it open; it finishes in the background. */
  readonly run: (
    scriptId: KanbanScript["id"],
    trigger: string,
  ) => Effect.Effect<KanbanScriptRun, KanbanError>;
  /** Starts the scheduled scripts that are due. */
  readonly tick: Effect.Effect<void, KanbanError>;
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
  Effect.fail(new KanbanError({ code, detail }));

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

// A script that is running: `done` completes when this run ends, and `next` is
// the one run asked for while it ran (the newest ask wins).
interface Slot {
  readonly done: Deferred.Deferred<void>;
  readonly next: Pending | null;
}

type Slots = ReadonlyMap<KanbanScript["id"], Slot>;

const make = Effect.gen(function* () {
  const store = yield* KanbanStore;
  const service = yield* KanbanService;
  const scope = yield* Effect.scope;
  // One run per script. A slot is taken, and handed to the next run, in one
  // step, so nothing can land between a run ending and the next one starting.
  const slots = yield* Ref.make<Slots>(new Map());
  // Script records are written whole, so a toggle and a run ending take turns.
  const writes = yield* Semaphore.make(1);

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

  // Only resizes a pool the board already has, keeping its variant.
  const resizePool = Effect.fn("KanbanScripts.resizePool")(function* (
    script: KanbanScript,
    command: Scripts.PoolCommand,
  ) {
    const pools = yield* io(store.pools(script.boardId));
    const pool = pools.find(
      (entry) =>
        entry.model.model === command.model &&
        (command.instanceId === undefined || entry.model.instanceId === command.instanceId),
    );
    if (!pool) return `There's no ${command.model} pool on this board.`;
    const resized = yield* Effect.result(
      service.setPool(script.boardId, pool.model, command.slots),
    );
    return Result.isSuccess(resized)
      ? `Set the ${command.model} pool to ${command.slots} ${command.slots === 1 ? "slot" : "slots"}.`
      : `Couldn't resize the ${command.model} pool: ${resized.failure.detail}`;
  });

  // Applies what the script printed, as the script. One bad command doesn't stop the rest.
  const apply = Effect.fn("KanbanScripts.apply")(function* (
    script: KanbanScript,
    commands: ReadonlyArray<Scripts.ScriptCommand>,
  ) {
    const actor: KanbanActor = { _tag: "script", scriptId: script.id };
    const notes: Array<string> = [];
    const cards = [...(yield* io(store.cards(script.boardId)))];
    for (const command of commands) {
      if (command.kanban === "card") {
        const existing = Scripts.duplicateOf(cards, command);
        if (existing) {
          notes.push(`Card #${existing.number} is already on the board.`);
          continue;
        }
        const created = yield* Effect.result(
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
        if (Result.isSuccess(created)) {
          cards.push(created.success);
          notes.push(`Added card #${created.success.number}.`);
        } else {
          notes.push(`Couldn't add a card: ${created.failure.detail}`);
        }
        continue;
      }
      if (command.kanban === "pool") {
        notes.push(yield* resizePool(script, command));
        continue;
      }
      if (command.kanban === "subtask" || command.kanban === "handback" || command.kanban === "move") {
        const card = cards.find((entry) => entry.number === command.card);
        if (!card) {
          notes.push(`Couldn't ${command.kanban === "move" ? "move" : "mark"} card #${command.card}: No card #${command.card} on this board.`);
          continue;
        }
        if (command.kanban === "subtask") {
          const marked = yield* Effect.result(
            service.markSubtask(card.id, command.subtask, command.state, command.note ?? null, actor, "script"),
          );
          notes.push(
            Result.isSuccess(marked)
              ? `Marked ${command.subtask} ${command.state} on card #${command.card}.`
              : `Couldn't mark ${command.subtask} on card #${command.card}: ${marked.failure.detail}`,
          );
        } else if (command.kanban === "handback") {
          const handed = yield* Effect.result(
            service.handBack(card.id, command.subtask, command.note, actor),
          );
          notes.push(
            Result.isSuccess(handed)
              ? `Handed ${command.subtask} on card #${command.card} back to the evaluator.`
              : `Couldn't hand ${command.subtask} on card #${command.card} back: ${handed.failure.detail}`,
          );
        } else {
          const moved = yield* Effect.result(
            service.moveCard(card.id, command.to, "script", actor, { note: command.note ?? null }),
          );
          notes.push(
            Result.isSuccess(moved)
              ? `Moved card #${command.card} to ${command.to}.`
              : `Couldn't move card #${command.card}: ${moved.failure.detail}`,
          );
        }
        continue;
      }
      const posted = yield* Effect.result(
        targetOf(script, command, cards).pipe(
          Effect.flatMap((discussion) =>
            service
              .post(discussion.id, actor, [{ _tag: "md", text: command.text }])
              .pipe(Effect.as(discussion)),
          ),
        ),
      );
      notes.push(
        Result.isSuccess(posted)
          ? `Posted in "${posted.success.title}".`
          : `Couldn't post: ${posted.failure.detail}`,
      );
    }
    return notes;
  });

  // Reads the record again under the lock and changes only what the caller
  // owns, so a toggle can't undo a run's lastRun, or the other way round.
  const update = Effect.fn("KanbanScripts.update")(function* (
    scriptId: KanbanScript["id"],
    change: (script: KanbanScript) => KanbanScript,
  ) {
    return yield* writes.withPermits(1)(
      scriptOf(scriptId).pipe(Effect.flatMap((script) => save(change(script)))),
    );
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
  ) {
    const endedAt = yield* nowIso;
    yield* saveRun(script.boardId, { ...run, endedAt, exitCode, output: Scripts.tail(output) });
    yield* update(script.id, (latest) => ({
      ...latest,
      lastRun: { startedAt: run.startedAt, endedAt, exitCode },
    }));
  });

  const execute = Effect.fn("KanbanScripts.execute")(function* (
    script: KanbanScript,
    run: KanbanScriptRun,
    event: string | null,
  ) {
    const interpreter = Scripts.interpreterFor(script.path);
    if (interpreter === null || !(yield* isFile(script.path))) {
      return yield* close(script, run, null, `There is no script at ${script.path}.`);
    }
    const result = yield* runProcess({
      argv: [interpreter, script.path],
      cwd: NodePath.dirname(script.path),
      env: {
        ...scriptEnv(process.env),
        KANBAN_BOARD_ID: script.boardId,
        KANBAN_SCRIPT_ID: script.id,
        KANBAN_TRIGGER: run.trigger,
        ...(event === null ? {} : { KANBAN_EVENT: event }),
      },
      timeoutMs: RUN_TIMEOUT_MS,
      outputBytes: STDOUT_LIMIT,
    });
    const parsed = Scripts.parseOutput(result.stdout);
    const notes = yield* apply(script, parsed.commands);
    const problems = [
      result.spawnError === null ? null : `It didn't start: ${result.spawnError}`,
      result.timedOut ? `Stopped after ${RUN_TIMEOUT_MS / 60_000} minutes.` : null,
      result.overflow ? "Stopped: it printed too much." : null,
      ...parsed.errors,
    ].filter((line): line is string => line !== null);
    const output = [notes.join("\n"), parsed.text, result.stderr.trim(), problems.join("\n")]
      .filter((part) => part.length > 0)
      .join("\n\n");
    yield* close(script, run, result.exitCode, output);
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
  ): Effect.Effect<KanbanScriptRun, KanbanError> =>
    open(script, trigger).pipe(
      Effect.tap((run) => Effect.forkIn(finish(script, run, event, done), scope)),
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
  ): Effect.Effect<void> =>
    execute(script, run, event).pipe(
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
      const script = yield* scriptOf(scriptId);
      if (script.enabled === enabled) return script;
      if (!enabled) {
        // The run going now finishes; the one asked for after it doesn't happen.
        yield* Ref.update(slots, (map) => {
          const slot = map.get(scriptId);
          if (slot === undefined || slot.next === null) return map;
          return new Map(map).set(scriptId, { ...slot, next: null });
        });
      }
      return yield* update(scriptId, (latest) => ({ ...latest, enabled }));
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
          output: [open.output, "Robob stopped during this run."].filter(Boolean).join("\n\n"),
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
    run,
    tick,
    listen,
    recover,
    idle,
  });
});

export const layer = Layer.effect(KanbanScripts, make);
