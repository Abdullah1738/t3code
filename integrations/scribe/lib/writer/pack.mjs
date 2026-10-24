// The facts pack: everything a report may say, gathered read-only for one
// window. The model writes from its text form; the checks and the fallback
// render read the object. It is saved with the report.
import { areaOrder } from './config.mjs';
import { openCrw, deploys as crwDeploys, reviewedRefs, reviews as crwReviews } from './crw.mjs';
import { previousFollowUps } from './followups.mjs';
import { commits } from './git.mjs';
import { docsCommits, mergedPrs, releases, workflowCounts } from './github.mjs';
import { tickets as linearTickets, triageMoves } from './linear.mjs';
import { carriedKnown, unpin } from './lines.mjs';
import { missionFacts, openItems } from './mission.mjs';
import { expand } from './scrub.mjs';
import { clock, stamp } from './time.mjs';

export const PACK_SCHEMA = 'scribe.writer.pack.v1';

/**
 * Gathers the pack for [from, to). The merged work (PRs or commits) is
 * required: without it the report would undercount, so a failure there
 * throws. Any other source that fails is listed in `errors` and the report
 * says so.
 */
export async function gatherPack({ config, kind, from, to, db, exec, previous = null, log = () => {} }) {
  const errors = [];
  const optional = async (source, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      errors.push({ source, message: String(error.message ?? error).slice(0, 300) });
      log(`pack: ${source} failed: ${error.message}`);
      return fallback;
    }
  };

  const units = config.github ? await mergedPrs({ config, from, to, exec }) : await commits({ config, from, to, exec });

  const ticketIds = [...new Set(units.flatMap((unit) => unit.tickets))];
  const tickets = config.linear && ticketIds.length ? await optional('linear tickets', () => linearTickets({ config, ids: ticketIds, exec }), {}) : {};

  let reviews = [];
  let deploys = [];
  if (config.crw) {
    await optional('review workflow DB', () => {
      const crw = openCrw(config.crw.db);
      try {
        reviews = crwReviews(crw, { config, from, to });
        deploys = crwDeploys(crw, { config, from, to });
        // Team PRs the workflow reviewed (some repos are outside its review).
        const seen = reviewedRefs(crw, { config, refs: units.filter((unit) => !unit.ours).map((unit) => unit.ref), to });
        for (const unit of units) if (!unit.ours) unit.reviewed = seen.has(unit.ref);
      } finally {
        crw.close();
      }
    });
  }

  const releaseRuns = config.releases ? await optional('release runs', () => releases({ config, from, to, exec, log }), []) : [];
  const workflows = [];
  if (config.releases) {
    for (const repo of [config.releases.repo, ...config.releases.otherRepos]) {
      const counts = await optional(`workflow runs in ${repo}`, () => workflowCounts({ config, repo, from, to, exec }), []);
      for (const count of counts) workflows.push({ repo: repo.replace(/^[^/]+\//, ''), ...count });
    }
  }

  const docs = [];
  for (const doc of config.docs) {
    const list = await optional(`${doc.label} commits`, () => docsCommits({ doc, from, to, exec }), []);
    docs.push({ label: doc.label, commits: list });
  }

  const triage = config.linear?.triageProject ? await optional('triage moves', () => triageMoves({ config, from, to, exec }), []) : [];

  const mission = missionFacts(db, { config, from, to });
  const open = openItems(mission);

  const reviewedPrs = new Set(reviews.map((review) => review.ref));
  return {
    schema: PACK_SCHEMA,
    mission: { id: config.id, title: config.title },
    kind,
    window: { from, to, zone: config.zone },
    unitKind: config.github ? 'pr' : 'commit',
    units,
    counts: {
      merged: units.length,
      ours: units.filter((unit) => unit.ours).length,
      team: units.filter((unit) => !unit.ours).length,
      reviews: reviews.length,
      reviewedPrs: reviewedPrs.size,
      releases: releaseRuns.length,
      releasesOk: releaseRuns.filter((run) => run.conclusion === 'success').length,
    },
    tickets,
    reviews,
    deploys,
    releases: releaseRuns,
    workflows,
    docs,
    triage,
    work: mission,
    open,
    previous: previous
      ? { coversFrom: previous.coversFrom, coversTo: previous.coversTo, followUps: kind === 'daily' ? previousFollowUps(previous).map((item) => ({ ...item, what: expand(unpin(item.what), config.aliases) })) : [], open: previous.open ?? [] }
      : null,
    errors,
  };
}

/** Units grouped by area, areas in configured order. */
export function byArea(config, units) {
  const groups = new Map();
  for (const unit of units) {
    const list = groups.get(unit.area) ?? [];
    list.push(unit);
    groups.set(unit.area, list);
  }
  return areaOrder(config, [...groups.keys()]).map((area) => ({ area, units: groups.get(area) }));
}

const ticketLine = (pack, id) => {
  const ticket = pack.tickets[id];
  if (!ticket) return id;
  const parent = ticket.parent ? `; parent ${ticket.parent.id} "${ticket.parent.title}"` : '';
  return `${id} "${ticket.title}" [${ticket.state ?? 'unknown'}${parent}]`;
};

/** The pack as compact text for the model. Times are in the mission's zone. */
export function packText(config, pack) {
  const zone = config.zone;
  const at = (iso) => (iso ? clock(iso, zone) : '?');
  const when = (iso) => (iso ? stamp(iso, zone) : '?');
  const out = [];
  const { counts } = pack;
  const noun = pack.unitKind === 'pr' ? 'PRs' : 'commits';
  out.push(`MISSION: ${pack.mission.title}. Window ${when(pack.window.from)} to ${when(pack.window.to)} (${zone}). All times below are ${zone} HH:MM.`);
  out.push(`COUNTS: merged ${counts.merged} ${noun} (${counts.ours} ours, ${counts.team} team).${pack.reviews.length ? ` Team reviews: ${counts.reviews} decisions on ${counts.reviewedPrs} PRs.` : ''}${pack.releases.length ? ` Release runs: ${counts.releases} (${counts.releasesOk} succeeded).` : ''}`);
  if (pack.errors.length) out.push(`SOURCES THAT FAILED (say so where it matters): ${pack.errors.map((error) => `${error.source}: ${error.message}`).join(' | ')}`);

  out.push('', `## MERGED ${noun.toUpperCase()} by area (every one must appear exactly once in the report)`);
  for (const group of byArea(config, pack.units)) {
    out.push(`### ${group.area} (${group.units.length})`);
    for (const unit of group.units) {
      const who = unit.ours ? 'ours' : `team: ${unit.person}${unit.reviewed ? ', reviewed by us' : ''}`;
      const scope = unit.scope ? ` scope ${unit.scope}, ${unit.files} files` : '';
      out.push(`- ${unit.ref} [${who}] ${at(unit.mergedAt)} :: ${unit.title}${scope}`);
      if (unit.tickets.length) out.push(`  tickets: ${unit.tickets.map((id) => ticketLine(pack, id)).join('; ')}`);
      if (unit.body) out.push(`  body: ${unit.body.replace(/\s+/g, ' ')}`);
    }
  }

  if (pack.releases.length || pack.deploys.length) {
    out.push('', '## RELEASES (deploy runs, in order)');
    for (const run of pack.releases) {
      const carried = !carriedKnown(run)
        ? `carried PRs unknown (${run.carryError ? `lookup failed: ${run.carryError}` : 'no previous tag found'})`
        : run.carried.length
          ? `carried ${run.carried.join(', ')} (${run.commits} commits since ${run.previousTag})`
          : `no PR commits since ${run.previousTag}`;
      // A run that did not succeed proves nothing, whatever its artifact's check of the live service says.
      const runtime =
        run.conclusion !== 'success'
          ? 'proves nothing (the run did not succeed)'
          : run.runtimeChecked === null
            ? 'runtime check: none'
            : run.runtimeChecked
              ? 'runtime check: passed'
              : `runtime check: FAILED ${run.runtimeFailures.join(', ')}`;
      out.push(`- ${at(run.at)} ${run.tag ?? (run.service ? `${run.service} (no tag recorded)` : 'run with no tag or service recorded')} ${run.conclusion}; ${carried}; ${runtime}${run.evidenceError ? `; evidence unreadable: ${run.evidenceError}` : ''}`);
    }
    if (pack.deploys.length) {
      out.push('### Review workflow deploy records updated in the window');
      for (const deploy of pack.deploys) {
        out.push(
          `- ${at(deploy.at)} ${deploy.repo} ${deploy.status}${deploy.tag ? ` ${deploy.tag}` : ''} PRs ${deploy.prs.join(', ') || 'none'}${deploy.outcome ? ` :: ${deploy.outcome}` : ''}${deploy.failure ? ` :: failure: ${deploy.failure}` : ''} :: read back: ${deploy.observed ?? 'not recorded'}`,
        );
      }
    }
  }
  if (pack.workflows.length) {
    out.push('', '## OTHER WORKFLOW RUNS (counts)');
    for (const flow of pack.workflows) out.push(`- ${flow.repo} "${flow.workflow}": ${flow.runs} runs, ${flow.success} ok, ${flow.failure} failed, ${flow.other} other, last ${at(flow.last)}`);
  }

  if (pack.reviews.length) {
    out.push('', '## TEAM REVIEWS (review decisions on the team\'s PRs; every PR here must appear in Reviews for the team with its verdict)');
    for (const review of pack.reviews) {
      out.push(`- ${at(review.at)} ${review.ref} (${review.person ?? 'unknown author'}) ${review.verdict} [${review.state}${review.prState ? `, PR ${review.prState}` : ''}] :: ${review.title ?? ''}${review.gist ? ` :: ${review.gist}` : ''}`);
    }
  }
  if (pack.triage.length) {
    out.push('', '## HUMAN QA TRIAGE (tickets moved in or out of the triage queue)');
    for (const issue of pack.triage) {
      const moves = issue.moves.map((move) => `${at(move.at)} ${move.from ?? 'none'} -> ${move.to ?? 'none'}`).join(', ');
      const state = issue.state ? `${issue.state}, ` : '';
      out.push(`- ${issue.id} "${issue.title}" at the window's end: ${state}${issue.project ?? 'no project'}${moves ? `; moves ${moves}` : `; created ${at(issue.createdAt)}`}`);
    }
  }

  for (const doc of pack.docs) {
    if (!doc.commits.length) continue;
    out.push('', `## ${doc.label.toUpperCase()} COMMITS`);
    for (const commit of doc.commits) out.push(`- ${at(commit.at)} ${commit.subject}`);
  }

  const work = pack.work;
  if (work.workItems.length) {
    out.push('', '## WORK ITEMS that moved (for story arcs; stage order ticket, pr, review, merge, deploy, readback, exercised, done)');
    for (const item of work.workItems) {
      const moves = item.moves.map((move) => `${at(move.at)} ${move.stage}`).join(', ');
      const extra = [item.blockedBy.length ? `blocked: ${item.blockedBy.join('; ')}` : '', item.readback ? `readback: ${item.readback}` : '', item.exercised ? `exercised: ${item.exercised}` : '']
        .filter(Boolean)
        .join(' | ');
      out.push(`- ${item.title}${item.pr && !item.title.includes(item.pr) ? ` (${item.pr})` : ''} [at the end: ${item.stage}]${moves ? ` moves ${moves}` : ''}${extra ? ` | ${extra}` : ''}`);
    }
  }
  if (work.milestones.length) {
    out.push('', '## MILESTONES');
    for (const milestone of work.milestones) out.push(`- ${milestone.title} [${milestone.status}]${milestone.note ? ` :: ${milestone.note}` : ''}`);
  }
  if (work.asks.length || work.requests.length) {
    out.push('', "## OWNER'S ASKS AND REQUESTS");
    for (const ask of work.asks) out.push(`- ask [${ask.status}] ${ask.question}${ask.answer ? ` -> answered: ${ask.answer}` : ''}`);
    for (const request of work.requests) out.push(`- request [${request.status}] "${request.title}"${request.lastReply ? ` -> last reply: ${request.lastReply}` : ''}`);
  }
  const { approvals, drafts } = work;
  out.push('', '## APPROVALS AND DRAFTS');
  out.push(`- approvals decided ${approvals.decided} (${approvals.approved} approved, ${approvals.rejected} rejected), ${approvals.pending.length} pending`);
  out.push(`- outward drafts: ${drafts.opened} opened, ${drafts.sent} sent, ${drafts.approved} approved, ${drafts.dropped} dropped, ${drafts.pending.length} waiting`);
  if (work.messages.kept.length) {
    out.push('', `## LANE MESSAGES (${work.messages.kept.length}${work.messages.dropped ? `, ${work.messages.dropped} older ones left out` : ''}; context only, never cite their wording)`);
    for (const message of work.messages.kept) out.push(`- ${at(message.at)} ${message.kind}: ${message.text}`);
  }
  if (pack.open.length) {
    out.push('', '## WAITING ON THE OWNER OR BLOCKED AT THE END OF THE WINDOW');
    for (const item of pack.open) out.push(`- ${item.label} (since ${when(item.since)})`);
  }
  if (pack.previous?.followUps?.length) {
    out.push('', "## YESTERDAY'S FOLLOW-UPS (account for every one: closed, dropped, carried or still open, with the reason)");
    for (const item of pack.previous.followUps) out.push(`- ${item.id}. ${item.what}`);
  }
  out.push('', '## USAGE');
  out.push(`- scribe: ${work.usage.batches} note batches, ${work.usage.inputTokens} tokens in, ${work.usage.outputTokens} out`);
  return out.join('\n');
}
