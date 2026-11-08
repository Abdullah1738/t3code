import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
const mode = process.argv[2] ?? 'typecheck';
if (!['typecheck', 'run', 'verify'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
const cases = [
  ['restart', 'step', 'invariant', false],
  ['commands', 'step', 'invariant', false],
  ['boards', 'step', 'invariant', false],
  ['sync', 'step', 'invariant', false],
  ['restart', 'step', 'preparationContinues', false],
  ['restart', 'step', 'nativePreparationContinues', false],
  ['restart', 'step', 'queuedContinues', false],
  ['commands', 'stepCurrent', 'currentRecoverable', true],
];
mkdirSync('traces/latest', { recursive: true });
let failed = false;
const results = [];
const selected = cases.filter(([spec, , invariant]) => !process.env.MODEL_CASE || process.env.MODEL_CASE === `${spec}-${invariant}`);
if (selected.length === 0) throw new Error(`Unknown MODEL_CASE: ${process.env.MODEL_CASE}`);
for (const [spec, step, invariant, expectedFailure] of selected) {
  if (mode === 'typecheck' && expectedFailure) continue;
  const label = `${spec}-${invariant}`;
  const args = [mode, `${spec}.qnt`];
  if (mode !== 'typecheck') args.push('--step', step, '--invariant', invariant, '--max-steps', '10');
  if (mode === 'run') args.push('--seed', '20261108', '--max-samples', '10000', '--out-itf', `traces/latest/${label}.itf.json`);
  if (mode === 'verify') args.push('--apalache-version', '0.62.4');
  if (mode === 'verify' && expectedFailure) args.push('--out-itf', `traces/latest/${label}.itf.json`);
  if (mode !== 'typecheck' && expectedFailure) rmSync(`traces/latest/${label}.itf.json`, { force: true });
  const result = spawnSync('quint', args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(`traces/latest/${mode}-${label}.log`, output);
  // A parse/type/backend error must never count as the expected counterexample.
  let traceViolation = false;
  if (expectedFailure) {
    try {
      const trace = JSON.parse(readFileSync(`traces/latest/${label}.itf.json`, 'utf8'));
      traceViolation = Array.isArray(trace.states) && trace.states.length > 0;
    } catch {}
  }
  const violation = traceViolation || /Invariant violated|invariant.*violat|found a counterexample|invariants? (?:were|was) violated/i.test(output);
  const ok = expectedFailure ? result.status !== 0 && violation : result.status === 0;
  failed ||= !ok;
  results.push({ spec, step, invariant, expectedFailure, status: result.status, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${mode} ${label} (exit ${result.status})`);
  if (!ok) console.log(output.slice(-10000));
}
if (mode === 'run') {
  for (const spec of ['restart', 'commands', 'boards', 'sync']) {
    const result = spawnSync('quint', ['test', `${spec}.qnt`], { encoding: 'utf8' });
    writeFileSync(`traces/latest/test-${spec}.log`, `${result.stdout}${result.stderr}`);
    console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} witnesses ${spec}`);
    if (result.status !== 0) console.log(result.stdout, result.stderr);
    failed ||= result.status !== 0;
  }
}
writeFileSync(`traces/latest/${mode}${process.env.MODEL_CASE ? `-${process.env.MODEL_CASE}` : ""}-results.json`, JSON.stringify(results, null, 2) + '\n');
process.exitCode = failed ? 1 : 0;
