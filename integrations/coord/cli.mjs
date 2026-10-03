#!/usr/bin/env node
// coord CLI. Prints JSON. Exit 0 on success, 1 on refusal ({ok:false,error:{code,message}}), 2 on usage.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as C from './lib/coord.mjs';
import * as E from './lib/evidence.mjs';
import { deliver, pump, controlConfig, threadState } from './lib/pump.mjs';

const USAGE = `coord <command> [args] (JSON output; see README.md)
  init                                             (idempotent seed: crw process actor)
  actor set ID [--thread T] [--kind thread|process]
  channel create ID --owner A [--purpose P] | channel archive ID --note N
  member add|rm CHANNEL ACTOR [--wake]
  post CHANNEL --as A --kind K --key KEY --summary S [--to a,b] [--work W] [--env E] [--rev R] [--authority X] [--body-file F] [--reply-to SEQ] [--no-deliver]
  inbox --as A [--unacked] [--after SEQ]          ack --as A SEQ|KEY ...
  deliver [--once]                                 (deliveries only)
  pump                                             (deliveries + observe running releases; for launchd)
  claim RES --as A [--ttl 30m] [--purpose P] [--op REF]
  renew RES --as A --fence N [--ttl] [--op REF]    release RES --as A --fence N [--note]
  check RES --as A --fence N                       reconcile RES --as A --outcome O --evidence TEXT
  claims [--owner A] [--state S]
  dep add WORK NEED REF | dep set ID --state S --evidence E | ready WORK
  release request --as A --key K --kind K --env E --footprint a,b [--risk R] [--batch B]
      deploys:  --repo R --binary B --sha S --runtime-sha S (--content-prs a,b | --content-prs '' --range-evidence X) [--tag T --digest D]
      tf_apply: --plan saved:<run>|scope:<name> --tf-root ROOT (--targets a,b | --full-root) --root-gen N     ddl/migration: --plan FILE.sql[@sum]
  tf gen ROOT                                      (root generation to record at plan time)
  release admit ID --as A [--force-manual] | release start ID --as A --fence N [--tag T --sha S --digest D --plan P --release-run X --deploy-run Y --tf-run Z]
  release record ID (--fence N | --as ADMITTER --evidence E) [--release-run X --deploy-run Y --tf-run Z --digest D]
  release observe ID | release cancel ID --as A [--note]
  release list [--state S] [--env E]
  qa open --as A --env E --footprint a,b [--ttl 4h] | qa close ID --as A [--note]
  arch request --as A --kind K [--key K] [--repos a,b] [--pins-file F] [--packet P] [--summary S]
  arch take ID --as A --fence N | arch done ID --as A --fence N --commits a,b [--note] | arch reject ID --as A --fence N --note N [--superseded]
  arch transfer ID --as A --fence N | arch list [--state S]
  pause|drain|resume [--scope S] --as A --reason R
  flag KEY on|off --as A [--reason R]              gate [SCOPE]
  attention | status`;

const OPTS = {
  as: { type: 'string' }, thread: { type: 'string' }, kind: { type: 'string' }, owner: { type: 'string' }, purpose: { type: 'string' },
  note: { type: 'string' }, wake: { type: 'boolean' }, key: { type: 'string' }, summary: { type: 'string' }, to: { type: 'string' },
  work: { type: 'string' }, env: { type: 'string' }, rev: { type: 'string' }, authority: { type: 'string' }, 'body-file': { type: 'string' },
  'reply-to': { type: 'string' }, 'no-deliver': { type: 'boolean' }, unacked: { type: 'boolean' }, after: { type: 'string' }, once: { type: 'boolean' },
  ttl: { type: 'string' }, op: { type: 'string' }, fence: { type: 'string' }, outcome: { type: 'string' }, evidence: { type: 'string' },
  state: { type: 'string' }, repo: { type: 'string' }, binary: { type: 'string' }, sha: { type: 'string' }, 'runtime-sha': { type: 'string' },
  'content-prs': { type: 'string' }, tag: { type: 'string' }, digest: { type: 'string' }, plan: { type: 'string' }, footprint: { type: 'string' },
  risk: { type: 'string' }, batch: { type: 'string' }, 'force-manual': { type: 'boolean' }, 'release-run': { type: 'string' },
  'deploy-run': { type: 'string' }, 'tf-run': { type: 'string' }, repos: { type: 'string' }, 'pins-file': { type: 'string' }, packet: { type: 'string' },
  commits: { type: 'string' }, 'tf-root': { type: 'string' }, targets: { type: 'string' }, 'full-root': { type: 'boolean' },
  'root-gen': { type: 'string' }, 'range-evidence': { type: 'string' }, superseded: { type: 'boolean' }, scope: { type: 'string' }, reason: { type: 'string' }, help: { type: 'boolean', short: 'h' },
};

const { values: o, positionals: p } = parseArgs({ args: process.argv.slice(2), options: OPTS, allowPositionals: true, strict: true });
const read = f => (f === '-' ? readFileSync(0, 'utf8') : readFileSync(f, 'utf8'));
const readJson = f => { const s = read(f); try { return JSON.parse(s); } catch { return s; } };
const csv = s => (s === undefined ? undefined : s.split(',').map(x => x.trim()).filter(Boolean));

// The rollout-gate hook comes from the embedding process; the CLI can load one from COORD_GATE_HOOK
// (a module exporting gateCheck). Without it, admission of a non-empty content range refuses gate_unavailable.
if (process.env.COORD_GATE_HOOK) C.configure({ gateCheck: (await import(process.env.COORD_GATE_HOOK)).gateCheck });

async function tryDeliver(seq) {
  try { return await deliver({ seq }); } catch (e) { return { deferred: e.message }; }
}

async function main() {
  const [cmd, sub, a1, a2] = p;
  switch (cmd) {
    case 'init': return C.init();
    case 'tf': if (sub === 'gen') return C.tfRootGen(a1); break;
    case 'actor': if (sub === 'set') return C.actorSet(a1, { thread: o.thread, kind: o.kind }); break;
    case 'channel':
      if (sub === 'create') return C.channelCreate(a1, { owner: o.owner, purpose: o.purpose });
      if (sub === 'archive') return C.channelArchive(a1, { note: o.note });
      break;
    case 'member':
      if (sub === 'add') return C.memberAdd(a1, a2, { wake: o.wake });
      if (sub === 'rm') return C.memberRm(a1, a2);
      break;
    case 'post': {
      const r = C.post(sub, { as: o.as, kind: o.kind, key: o.key, summary: o.summary, to: o.to, work: o.work, env: o.env, rev: o.rev,
        authority: o.authority, body: o['body-file'] ? readJson(o['body-file']) : undefined, replyTo: o['reply-to'] ? Number(o['reply-to']) : undefined });
      return o['no-deliver'] || r.duplicate ? r : { ...r, delivery: await tryDeliver(r.seq) };
    }
    case 'inbox': return C.inbox({ as: o.as, unacked: o.unacked, after: o.after });
    case 'ack': return C.ack(o.as, p.slice(1));
    case 'deliver': return deliver();
    case 'pump': return pump();
    case 'claim': return C.claim(sub, { as: o.as, ttl: o.ttl, purpose: o.purpose, op: o.op });
    case 'renew': return C.renew(sub, { as: o.as, fence: o.fence, ttl: o.ttl, op: o.op });
    case 'release':
      if (!/^(request|admit|start|record|observe|cancel|list)$/.test(sub ?? '')) return C.release(sub, { as: o.as, fence: o.fence, note: o.note });
      return releaseCmd(sub, a1);
    case 'check': return C.check(sub, { as: o.as, fence: o.fence });
    case 'reconcile': return C.reconcile(sub, { as: o.as, outcome: o.outcome, evidence: o.evidence });
    case 'claims': return C.claims({ owner: o.owner, state: o.state });
    case 'dep':
      if (sub === 'add') return C.depAdd(a1, a2, p[4]);
      if (sub === 'set') return C.depSet(a1, { state: o.state, evidence: o.evidence });
      break;
    case 'ready': return C.ready(sub, { external: d => E.external(d) });
    case 'qa':
      if (sub === 'open') return C.qaOpen({ as: o.as, env: o.env, footprint: o.footprint, ttl: o.ttl, key: o.key });
      if (sub === 'close') return C.qaClose(a1, { as: o.as, note: o.note });
      break;
    case 'arch':
      if (sub === 'request') return C.archRequest({ as: o.as, kind: o.kind, key: o.key, repos: o.repos, pins: o['pins-file'] ? readJson(o['pins-file']) : undefined, packet: o.packet, summary: o.summary });
      if (sub === 'take') return C.archTake(a1, { as: o.as, fence: o.fence });
      if (sub === 'done') return C.archDone(a1, { as: o.as, fence: o.fence, commits: o.commits, note: o.note });
      if (sub === 'reject') return C.archReject(a1, { as: o.as, fence: o.fence, note: o.note, superseded: o.superseded });
      if (sub === 'transfer') return C.archTransfer(a1, { as: o.as, fence: o.fence });
      if (sub === 'list') return C.archList({ state: o.state });
      break;
    case 'pause': case 'drain': case 'resume': {
      const r = C.setMode(cmd === 'resume' ? 'run' : cmd, { scope: o.scope, as: o.as, reason: o.reason });
      if (cmd !== 'drain') return r;
      let ts;
      try { const cfg = controlConfig(); ts = id => threadState(cfg, id); } catch { /* no control API: threads report unknown */ }
      return { ...r, ...(await C.drainReport({ threadState: ts, scope: o.scope })) };
    }
    case 'flag': return C.setFlag(sub, a1 === 'on', { as: o.as, reason: o.reason });
    case 'gate': {
      const g = C.gate(sub);
      if (!g.ok) throw new C.CoordError(g.mode === 'pause' ? 'paused' : 'draining', `${g.key} is ${g.mode}${g.reason ? `: ${g.reason}` : ''}`, { gate: g });
      return g;
    }
    case 'attention': return C.attention();
    case 'status': return C.status();
  }
  usage();
}

function releaseCmd(sub, id) {
  switch (sub) {
    case 'request': return C.releaseRequest({ as: o.as, key: o.key, kind: o.kind, env: o.env, repo: o.repo, binary: o.binary, sha: o.sha,
      runtimeSha: o['runtime-sha'], contentPrs: csv(o['content-prs']), rangeEvidence: o['range-evidence'], tag: o.tag, digest: o.digest, plan: o.plan,
      footprint: o.footprint, risk: o.risk, batch: o.batch, tfRoot: o['tf-root'], targets: o.targets, fullRoot: o['full-root'],
      rootGen: o['root-gen'] === undefined ? undefined : Number(o['root-gen']) });
    case 'admit': return C.releaseAdmit(id, { as: o.as, manual: o['force-manual'], verify: r => E.verifyHead(r) });
    case 'start': return C.releaseStart(id, { as: o.as, fence: o.fence, tag: o.tag, sha: o.sha, digest: o.digest, plan: o.plan,
      releaseRun: o['release-run'], deployRun: o['deploy-run'], tfRun: o['tf-run'], verify: r => E.verifyHead(r) });
    case 'record': return C.releaseRecord(id, { as: o.as, evidence: o.evidence, fence: o.fence, releaseRun: o['release-run'], deployRun: o['deploy-run'], tfRun: o['tf-run'], digest: o.digest });
    case 'observe': return C.releaseObserve(id, { observe: r => E.observeRelease(r) });
    case 'cancel': return C.releaseCancel(id, { as: o.as, note: o.note });
    case 'list': return C.releaseList({ state: o.state, env: o.env });
  }
}

class Usage extends Error {}
function usage() { throw new Usage(); }

if (o.help || !p.length) { console.log(USAGE); process.exit(0); }
try {
  const r = await main();
  console.log(JSON.stringify({ ok: true, ...r }, null, 2));
} catch (e) {
  if (e instanceof Usage) { console.error(USAGE); process.exit(2); }
  const code = e instanceof C.CoordError ? e.code : 'error';
  console.log(JSON.stringify({ ok: false, error: { code, message: e.message, ...e.extra } }, null, 2));
  process.exit(1);
} finally {
  C.close();
}
