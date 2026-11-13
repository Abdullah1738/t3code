import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as DateTime from 'effect/DateTime';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';
import * as SqlClient from 'effect/sql/SqlClient';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { CommandId, EventId, ThreadId, ProjectId, ProviderInstanceId } from '@t3tools/contracts';
import * as EventSink from '../../../apps/server/src/orchestration-v2/EventSink.ts';
import * as EventStore from '../../../apps/server/src/orchestration-v2/EventStore.ts';
import * as ProjectionStore from '../../../apps/server/src/orchestration-v2/ProjectionStore.ts';
import * as EffectOutbox from '../../../apps/server/src/orchestration-v2/EffectOutbox.ts';
import * as Receipts from '../../../apps/server/src/orchestration-v2/CommandReceiptStore.ts';
import * as SqlitePersistence from '../../../apps/server/src/persistence/Sqlite.ts';

type Status = 'pending' | 'running' | 'succeeded';
type Model = { alive: boolean; accepted: Set<number>; status: Map<number, Status>;
  inbox: Set<number>; claim: { id: number; worker: string } | null; generation: number; oldClaims: { id: number; worker: string }[]; title: string };
const now = DateTime.makeUnsafe('2026-11-08T00:00:00Z');
const threadId = ThreadId.make('thread:conformance');
const instanceId = ProviderInstanceId.make('codex');
const commandId = (id: number) => CommandId.make(`command:conformance:${id}`);
const effectId = (id: number) => `effect:conformance:${id}`;
const thread = {
  id: threadId, projectId: ProjectId.make('project:conformance'), title: 'initial',
  createdBy: 'user', creationSource: 'web', providerInstanceId: instanceId,
  modelSelection: { instanceId, model: 'synthetic' }, runtimeMode: 'full-access', interactionMode: 'default',
  branch: null, worktreePath: null, activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null, createdAt: now, updatedAt: now, archivedAt: null,
  settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
} as const;
function runtime(filename: string) {
  const database = SqlitePersistence.layerFromPath(filename).pipe(Layer.provideMerge(NodeServices.layer));
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, EffectOutbox.layer, Receipts.layer)
    .pipe(Layer.provideMerge(database));
  return ManagedRuntime.make(EventSink.layer.pipe(Layer.provideMerge(stores), Layer.provide(Logger.layer([], { mergeWithExisting: false }))));
}
class Real {
  rt: ReturnType<typeof runtime> | null;
  trace: string[] = [];
  constructor(readonly filename: string) { this.rt = runtime(filename); }
  run<A, E>(effect: Effect.Effect<A, E, any>): Promise<A> { return this.rt!.runPromise(effect); }
  async inspect(m: Model) {
    if (!m.alive) return;
    await this.run(Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      for (const id of [0, 1]) {
        const receipt = yield* receipts.getByCommandId(commandId(id));
        assert.equal(Option.isSome(receipt), m.accepted.has(id));
        const events = Array.from(yield* Stream.runCollect(sink.readByCommandId({ commandId: commandId(id) })));
        assert.equal(events.length, m.accepted.has(id) ? 1 : 0);
        const row = yield* outbox.get(effectId(id));
        assert.equal(Option.isSome(row), m.accepted.has(id));
        if (Option.isSome(row)) assert.equal(row.value.status, m.status.get(id));
      }
      assert.equal((yield* projection.getThreadProjection(threadId)).thread.title, m.title);
      const inbox = yield* sql<{ id: number }>`SELECT id FROM conformance_inbox ORDER BY id`;
      assert.deepEqual(inbox.map(x => x.id), [...m.inbox].sort());
    }));
  }
}
class Command implements fc.AsyncCommand<Model, Real> {
  constructor(readonly op: string, readonly id = 0) {}
  check(m: Readonly<Model>) { return this.op === 'restart' ? !m.alive : m.alive && (this.op !== 'claim' || m.claim === null) && (this.op !== 'stale' || m.oldClaims.length > 0); }
  toString() { return `${this.op}(${this.id})`; }
  async run(m: Model, r: Real) {
    r.trace.push(this.toString());
    if (['commit', 'rollback', 'rollbackLate'].includes(this.op)) {
      const shouldFail = this.op.startsWith('rollback') && !m.accepted.has(this.id);
      const id = this.id;
      const op = this.op;
      const result = await r.run(Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        return yield* Effect.exit(sink.commitCommand({
          commandId: commandId(id), threadId, commandType: 'conformance.update', acceptedAt: now,
          events: [{ id: EventId.make(`event:${id}`), type: 'thread.metadata-updated', threadId,
            occurredAt: now, payload: { ...thread, title: `command ${id}` } }],
          effects: [{ id: effectId(id), commandId: commandId(id), threadId, availableAt: DateTime.add(now, { milliseconds: id }),
            request: { type: 'provider-runtime.continue', sourceRunId: `run:${id}` as any } }, ...(shouldFail && op === 'rollbackLate' ? [{ id: 'effect:invalid', commandId: commandId(id), threadId, request: { type: 'invalid' } } as any] : [])],
          ...(shouldFail && op === 'rollback' ? { recheck: Effect.fail('injected before append') } : {}),
        }));
      }));
      assert.equal(result._tag, shouldFail ? 'Failure' : 'Success');
      if (!shouldFail && !m.accepted.has(id)) {
        m.accepted.add(id); m.status.set(id, 'pending'); m.title = `command ${id}`;
      }
    } else if (this.op === 'claim') {
      const worker = `worker:${++m.generation}`;
      const row = await r.run(Effect.flatMap(EffectOutbox.EffectOutboxV2,
        o => o.claimNext({ workerId: worker, leaseDurationMs: 3600000 })));
      const pending = [...m.accepted].filter(id => m.status.get(id) === 'pending');
      assert.equal(Option.isSome(row), pending.length > 0);
      if (Option.isSome(row)) {
        const id = pending[0]!;
        assert.equal(row.value.id, effectId(id));
        m.status.set(id, 'running'); m.claim = { id, worker };
      }
    } else if (this.op === 'deliver' && m.claim) {
      const { id } = m.claim;
      // Synthetic downstream inbox: unique id implements the explicit dedup assumption.
      await r.run(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO conformance_inbox(id) VALUES (${id}) ON CONFLICT DO NOTHING`;
      }));
      m.inbox.add(id);
    } else if (this.op === 'complete' && m.claim) {
      const { id, worker } = m.claim;
      // Completion can follow a delivery whose ACK was lost; it must not precede delivery.
      if (m.inbox.has(id)) {
        assert.equal(await r.run(Effect.flatMap(EffectOutbox.EffectOutboxV2,
          o => o.succeed({ effectId: effectId(id), workerId: worker }))), true);
        m.status.set(id, 'succeeded'); m.claim = null;
      }
    } else if (this.op === 'stale') {
      const old = m.oldClaims[this.id % m.oldClaims.length]!;
      assert.equal(await r.run(Effect.flatMap(EffectOutbox.EffectOutboxV2,
        o => o.succeed({ effectId: effectId(old.id), workerId: old.worker }))), false);
    } else if (this.op === 'crash') {
      if (m.claim) m.oldClaims.push({ ...m.claim });
      await r.rt!.dispose(); r.rt = null; m.alive = false;
    } else if (this.op === 'restart') {
      r.rt = runtime(r.filename);
      await r.run(Effect.flatMap(EffectOutbox.EffectOutboxV2, o => o.reconcileAfterProcessLoss));
      for (const [id, status] of m.status) if (status === 'running') m.status.set(id, 'pending');
      m.claim = null; m.alive = true;
    }
    await r.inspect(m);
  }
}
const artifactDir = 'traces/latest';
await mkdir(artifactDir, { recursive: true });
let lastTrace: string[] = [];
async function runCase(scheduler: fc.Scheduler | null, commands: Iterable<fc.AsyncCommand<Model, Real>>) {
  const directory = await mkdtemp(join(tmpdir(), 'protocol-conformance-'));
  const r = new Real(join(directory, 'synthetic.sqlite'));
  const m: Model = { alive: true, accepted: new Set(), status: new Map(), inbox: new Set(),
    claim: null, generation: 0, oldClaims: [], title: 'initial' };
  try {
    await r.run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE conformance_inbox (id INTEGER PRIMARY KEY)`;
      const sink = yield* EventSink.EventSinkV2;
      yield* sink.write({ events: [{ id: EventId.make('event:initial'), type: 'thread.created',
        threadId, providerInstanceId: instanceId, occurredAt: now, payload: thread }] });
    }));
    if (scheduler) await fc.scheduledModelRun(scheduler, () => ({ model: m, real: r }), commands);
    else await fc.asyncModelRun(() => ({ model: m, real: r }), commands);
    // Fair suffix: stop crashing and drain all persisted obligations.
    if (!m.alive) await new Command('restart').run(m, r);
    for (let n = 0; n < 3; n++) {
      if (!m.claim) await new Command('claim').run(m, r);
      await new Command('deliver').run(m, r); await new Command('complete').run(m, r);
    }
    assert.deepEqual([...m.inbox].sort(), [...m.accepted].sort());
  } finally {
    lastTrace = [...r.trace];
    await r.rt?.dispose(); await rm(directory, { recursive: true, force: true });
  }
}
const regression = [new Command('rollbackLate', 1), new Command('commit', 1), new Command('commit', 0),
  new Command('commit', 1), new Command('claim'), new Command('deliver'), new Command('crash'),
  new Command('restart'), new Command('claim'), new Command('stale'), new Command('deliver'), new Command('complete')];
try {
  await runCase(null, regression);
  await writeFile(join(artifactDir, 'conformance-regression.json'), JSON.stringify({ passed: true, trace: lastTrace }, null, 2) + '\n');
} catch (error) {
  await writeFile(join(artifactDir, 'conformance-regression.json'), JSON.stringify({ passed: false, trace: lastTrace, error: inspect(error, { depth: 10 }) }, null, 2) + '\n');
  throw error;
}
const property = fc.asyncProperty(fc.scheduler(), fc.commands([
  ...['commit', 'rollback', 'rollbackLate', 'stale'].map(op => fc.integer({ min: 0, max: 1 }).map(id => new Command(op, id))),
  ...['claim', 'deliver', 'complete', 'crash', 'restart'].map(op => fc.constant(new Command(op))),
], { maxCommands: 50, ...(process.env.FC_REPLAY_PATH ? { replayPath: process.env.FC_REPLAY_PATH } : {}) }),
runCase);
const details = await fc.check(property, { seed: Number(process.env.FC_SEED ?? 20261108),
  numRuns: Number(process.env.FC_RUNS ?? 100), ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}) });
const report = { failed: details.failed, seed: details.seed, runs: details.numRuns,
  shrinks: details.numShrinks, path: details.counterexamplePath,
  counterexample: details.counterexample?.map(String), trace: lastTrace,
  error: details.failed ? inspect(details.errorInstance, { depth: 10 }) : null };
await writeFile(join(artifactDir, 'conformance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (details.failed) process.exitCode = 1;
