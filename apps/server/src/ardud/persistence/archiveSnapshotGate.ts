import * as Context from "effect/Context";
import type * as Semaphore from "effect/Semaphore";

export class ArchiveSnapshotGate extends Context.Service<
  ArchiveSnapshotGate,
  Semaphore.Semaphore
>()("t3/ardud/persistence/archiveSnapshotGate") {}
