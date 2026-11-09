import type {
  ApplicationStoredEvent,
  OrchestrationProjectShell,
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import {
  OrchestrationProjectShell as ProjectShellSchema,
  OrchestrationV2ThreadShell as ThreadShellSchema,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { compactShell } from "../ardud/http/compactShell.ts";

export function buildActiveShellSnapshot(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: OrchestrationV2ThreadShellSnapshot;
  readonly snapshotSequence: number;
}): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: input.threads.schemaVersion,
    snapshotSequence: input.snapshotSequence,
    projects: input.projects,
    threads: input.threads.threads.map(compactShell),
    archivedThreads: [],
  };
}

/**
 * One transaction covers the reads so they agree; the threads are decoded after it commits,
 * because the server shares one SQLite connection and decoding a large shell takes longer than
 * reading it.
 */
export const loadShellSnapshotParts = Effect.fn("ShellStream.loadShellSnapshotParts")(function* <
  E1,
  E2,
  E3,
  E4,
>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly readThreads: Effect.Effect<Effect.Effect<OrchestrationV2ThreadShellSnapshot, E2>, E1>;
  readonly listProjects: Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, E3>;
  readonly latestSequence: Effect.Effect<number, E4>;
}) {
  const read = yield* input.sql
    .withTransaction(
      Effect.all({
        decodeThreads: input.readThreads,
        projects: input.listProjects,
        snapshotSequence: input.latestSequence,
      }),
    )
    .pipe(NodeSqliteClient.readOnly);
  return {
    projects: read.projects,
    threads: yield* read.decodeThreads,
    snapshotSequence: read.snapshotSequence,
  };
});

export type ShellApplicationEvent =
  | Pick<
      Extract<ApplicationStoredEvent, { readonly aggregateKind: "project" }>,
      "aggregateKind" | "aggregateId" | "type" | "sequence"
    >
  | {
      readonly sequence: number;
      readonly event: Pick<OrchestrationV2StoredEvent["event"], "threadId">;
    };

/** Shell updates refetch an aggregate; drop transcript bodies before retaining an event. */
export function toShellApplicationEvent(stored: ApplicationStoredEvent): ShellApplicationEvent {
  return "aggregateKind" in stored
    ? {
        aggregateKind: stored.aggregateKind,
        aggregateId: stored.aggregateId,
        type: stored.type,
        sequence: stored.sequence,
      }
    : { sequence: stored.sequence, event: { threadId: stored.event.threadId } };
}

export function coalesceShellApplicationEvents<A extends ShellApplicationEvent>(
  events: ReadonlyArray<A>,
): ReadonlyArray<A> {
  const latestByAggregate = new Map<string, A>();
  for (const stored of events) {
    const key =
      "aggregateKind" in stored
        ? `project:${stored.aggregateId}`
        : `thread:${stored.event.threadId}`;
    latestByAggregate.set(key, stored);
  }
  return Array.from(latestByAggregate.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

/**
 * Prevents a newer marked enrichment from landing before the unmarked authoritative initial
 * snapshot.
 */
export function composeShellStreamWithEnrichment<A, E, R, A2, E2, R2, A3, E3, R3>(input: {
  readonly initial: Stream.Stream<A, E, R>;
  readonly tail: Stream.Stream<A2, E2, R2>;
  readonly enrichment: Stream.Stream<A3, E3, R3>;
}): Stream.Stream<A | A2 | A3, E | E2 | E3, R | R2 | R3> {
  return Stream.concat(input.initial, Stream.merge(input.tail, input.enrichment));
}

const sameProjects = Schema.toEquivalence(Schema.Array(ProjectShellSchema));

export function dedupeShellEnrichment<E, R>(
  stream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>,
): Stream.Stream<OrchestrationV2ShellStreamItem, E, R> {
  return Stream.suspend(() => {
    let previous:
      | {
          readonly projects: ReadonlyArray<OrchestrationProjectShell>;
          readonly roots: ReadonlySet<string>;
        }
      | undefined;
    return stream.pipe(
      Stream.filter((item) => {
        if (item.kind !== "snapshot") {
          if (item.kind === "project.updated" || item.kind === "project.removed")
            previous = undefined;
          return true;
        }
        if (
          item.resolvedRepositoryIdentityRoots === undefined ||
          item.snapshot.threads.length > 0 ||
          item.snapshot.archivedThreads.length > 0
        ) {
          previous = undefined;
          return true;
        }
        const roots = new Set(item.resolvedRepositoryIdentityRoots);
        const prior = previous;
        if (
          prior !== undefined &&
          roots.size === prior.roots.size &&
          [...roots].every((root) => prior.roots.has(root)) &&
          sameProjects(prior.projects, item.snapshot.projects)
        )
          return false;
        previous = { projects: item.snapshot.projects, roots };
        return true;
      }),
    );
  });
}

export function shellStreamItemFromEnrichmentRefresh(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly changes: ReadonlyArray<{ readonly workspaceRoot: string }>;
}): Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  const resolvedRepositoryIdentityRoots = [
    ...new Set(input.changes.map((change) => change.workspaceRoot)),
  ];
  return {
    kind: "snapshot",
    snapshot: {
      ...input.snapshot,
      projects: input.snapshot.projects.filter((project) =>
        resolvedRepositoryIdentityRoots.includes(project.workspaceRoot),
      ),
      threads: [],
      archivedThreads: [],
    },
    resolvedRepositoryIdentityRoots,
  };
}

export function shellStreamItemsFromInitialSnapshot(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}): ReadonlyArray<Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>> {
  const authoritative = {
    kind: "snapshot" as const,
    snapshot: input.snapshot,
  };
  if (input.resolvedRepositoryIdentityRoots.length === 0) {
    return [authoritative];
  }
  return [
    authoritative,
    {
      kind: "snapshot" as const,
      snapshot: {
        ...input.snapshot,
        projects: input.snapshot.projects.filter((project) =>
          input.resolvedRepositoryIdentityRoots.includes(project.workspaceRoot),
        ),
        threads: [],
        archivedThreads: [],
      },
      resolvedRepositoryIdentityRoots: [...new Set(input.resolvedRepositoryIdentityRoots)],
    },
  ];
}

export function shellStreamItemsFromResumeSnapshot(input: {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}): ReadonlyArray<Extract<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>> {
  return shellStreamItemsFromInitialSnapshot(input).filter(
    (item) => item.resolvedRepositoryIdentityRoots !== undefined,
  );
}

const sameThreadShell = Schema.toEquivalence(ThreadShellSchema);

const UNCHANGED_THREAD_SHELL_RESEND_MS = 5_000;

/**
 * A skipped delta leaves the client cursor behind, and a resume replays the events after that
 * cursor. So an unchanged shell is still sent once its last send is
 * `UNCHANGED_THREAD_SHELL_RESEND_MS` old.
 */
export function skipUnchangedThreadShells<A extends OrchestrationV2ShellStreamItem, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> {
  return Stream.suspend(() => {
    const lastSent = new Map<
      OrchestrationV2ThreadShell["id"],
      { readonly thread: OrchestrationV2ThreadShell; readonly sentAt: number }
    >();
    return stream.pipe(
      Stream.filterEffect((item) =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          if (item.kind === "thread.removed") {
            lastSent.delete(item.threadId);
            return true;
          }
          if (item.kind !== "thread.updated") return true;
          const previous = lastSent.get(item.thread.id);
          if (
            previous !== undefined &&
            now - previous.sentAt < UNCHANGED_THREAD_SHELL_RESEND_MS &&
            sameThreadShell(
              { ...item.thread, updatedAt: previous.thread.updatedAt },
              previous.thread,
            )
          ) {
            return false;
          }
          lastSent.set(item.thread.id, { thread: item.thread, sentAt: now });
          return true;
        }),
      ),
    );
  });
}

export function coalesceStoredThreadEvents(
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
): ReadonlyArray<OrchestrationV2StoredEvent> {
  const latestByThreadId = new Map<string, OrchestrationV2StoredEvent>();
  for (const stored of events) {
    latestByThreadId.set(stored.event.threadId, stored);
  }
  return Array.from(latestByThreadId.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function shellStreamItemFromThreadShell(input: {
  readonly stored: Extract<ShellApplicationEvent, { readonly event: unknown }>;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }> {
  if (input.shell !== null) {
    if (input.shell.archivedAt !== null) {
      return {
        kind: "thread.removed",
        sequence: input.stored.sequence,
        location: "active",
        threadId: input.shell.id,
      };
    }
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      location: "active",
      thread: compactShell(input.shell),
    };
  }

  return {
    kind: "thread.removed",
    sequence: input.stored.sequence,
    location: "active",
    threadId: input.stored.event.threadId,
  };
}

export function archivedShellStreamItemFromThreadShell(input: {
  readonly stored: OrchestrationV2StoredEvent;
  readonly shell: OrchestrationV2ThreadShell | null;
}): Exclude<OrchestrationV2ArchivedShellStreamItem, { readonly kind: "snapshot" }> | null {
  if (input.shell !== null && input.shell.archivedAt !== null) {
    return {
      kind: "thread.updated",
      sequence: input.stored.sequence,
      thread: compactShell(input.shell),
    };
  }
  if (
    input.stored.event.type === "thread.unarchived" ||
    (input.stored.event.type === "thread.deleted" && input.stored.event.payload.archivedAt !== null)
  ) {
    return {
      kind: "thread.removed",
      sequence: input.stored.sequence,
      threadId: input.stored.event.threadId,
    };
  }
  return null;
}

const SUBAGENT_ANCESTOR_DEPTH_LIMIT = 16;

/**
 * Client shells omit idle subagents, but a pending request on a nested subagent is carried to
 * its root row through the subagent ancestors between them (pendingSubagentRequestsByThread,
 * child inputs). The initial snapshot keeps that chain; a live update of the asking subagent
 * would not, so its missing subagent ancestors are sent with it. Only updates that carry a
 * pending request walk the chain, so streaming updates add no reads.
 *
 * Ancestors follow their triggering update and reuse its sequence: the client applies the
 * update first, then takes an equal-sequence update only for a thread it does not have
 * (applyShellStreamEvent), so no update in the batch is skipped. Only for subscriptions that
 * asked for omitIdleSubagents.
 */
export const withSubagentRequestAncestors = Effect.fn("ShellStream.withSubagentRequestAncestors")(
  function* <E>(
    items: ReadonlyArray<Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>>,
    getThreadShell: (
      threadId: OrchestrationV2ThreadShell["id"],
    ) => Effect.Effect<OrchestrationV2ThreadShell | null, E>,
  ) {
    // Rows the batch already carries are not resent, but the walk continues through them.
    const inBatch = new Map<string, OrchestrationV2ThreadShell | null>();
    for (const item of items) {
      if (item.kind === "thread.updated")
        inBatch.set(item.thread.id, item.location === "active" ? item.thread : null);
      else if (item.kind === "thread.removed") inBatch.set(item.threadId, null);
    }
    const read = new Map<string, OrchestrationV2ThreadShell | null>();
    const emitted = new Set<string>();
    const out: Array<Exclude<OrchestrationV2ShellStreamItem, { readonly kind: "snapshot" }>> = [];
    let added = false;
    for (const item of items) {
      out.push(item);
      if (
        item.kind !== "thread.updated" ||
        item.thread.lineage.relationshipToParent !== "subagent" ||
        item.thread.pendingRuntimeRequest == null
      ) {
        continue;
      }
      const visited = new Set<string>([item.thread.id]);
      let parentId = item.thread.lineage.parentThreadId;
      for (
        let depth = 0;
        parentId !== null && !visited.has(parentId) && depth < SUBAGENT_ANCESTOR_DEPTH_LIMIT;
        depth++
      ) {
        visited.add(parentId);
        const batched = inBatch.has(parentId);
        let shell = batched ? inBatch.get(parentId)! : read.get(parentId);
        if (shell === undefined) {
          shell = yield* getThreadShell(parentId);
          read.set(parentId, shell);
        }
        // A top-level parent is always in the client shell; only subagents can be missing.
        if (
          shell === null ||
          shell.archivedAt !== null ||
          shell.lineage.relationshipToParent !== "subagent"
        ) {
          break;
        }
        if (!batched && !emitted.has(parentId)) {
          emitted.add(parentId);
          added = true;
          out.push({
            kind: "thread.updated",
            sequence: item.sequence,
            location: "active",
            thread: compactShell(shell),
          });
        }
        parentId = shell.lineage.parentThreadId;
      }
    }
    return added ? out : items;
  },
);
