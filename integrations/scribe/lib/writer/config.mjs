// The writer's per-mission settings. They name people, orgs and repos, so they
// live in a local file (not in this repo): $SCRIBE_WRITER_CONFIG or
// ~/.config/scribe/writer.json. writer.example.json shows the shape.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertZone } from './time.mjs';

const HOME = process.env.HOME || homedir();
export const CONFIG_PATH = process.env.SCRIBE_WRITER_CONFIG || join(HOME, '.config/scribe/writer.json');

const DEFAULT_LIMITS = { daily: 60_000, update: 15_000 };
const DEFAULT_MESSAGE_KINDS = ['blocker', 'evidence', 'decision'];

const list = (value, what) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${what} must be a list of strings`);
  }
  return value;
};

const regexes = (value, what) =>
  list(value, what).map((source) => {
    try {
      return new RegExp(source, 'g');
    } catch (error) {
      throw new Error(`${what}: ${error.message}`);
    }
  });

/** One mission's settings with defaults filled in and shapes checked. */
export function missionConfig(raw, missionId) {
  const where = `writer config for ${missionId}`;
  const mission = raw?.missions?.[missionId];
  if (!mission) throw new Error(`${where}: no "missions.${missionId}" entry in ${CONFIG_PATH}`);
  if (!mission.github && !mission.git) throw new Error(`${where}: needs "github" (merged PRs) or "git" (commits)`);
  const areas = (mission.areas ?? []).map((area, index) => {
    if (typeof area?.name !== 'string' || !area.name) throw new Error(`${where}: areas[${index}] needs a name`);
    return {
      name: area.name,
      repos: list(area.repos, `${where}: areas[${index}].repos`),
      scopes: list(area.scopes, `${where}: areas[${index}].scopes`),
      paths: list(area.paths, `${where}: areas[${index}].paths`),
      merges: Boolean(area.merges),
    };
  });
  const github = mission.github
    ? {
        owner: required(mission.github.owner, `${where}: github.owner`),
        ours: list(mission.github.ours, `${where}: github.ours`),
        skipRepos: list(mission.github.skipRepos, `${where}: github.skipRepos`),
      }
    : null;
  return {
    id: missionId,
    title: mission.title || missionId,
    zone: assertZone(mission.zone || 'UTC'),
    github,
    git: mission.git
      ? {
          dir: required(mission.git.dir, `${where}: git.dir`),
          ref: mission.git.ref || 'origin/main',
          // Author names or emails that count as ours; empty means every commit is.
          ours: list(mission.git.ours, `${where}: git.ours`),
          // Refs whose commits are not this mission's work (an upstream it syncs from).
          exclude: list(mission.git.exclude, `${where}: git.exclude`),
        }
      : null,
    model: mission.model || null,
    people: mission.people ?? {},
    // Short repo names people use in titles and messages (tc#12), with the real name.
    aliases: mission.aliases ?? {},
    areas,
    defaultArea: mission.defaultArea || 'Other',
    ticketPrefixes: list(mission.ticketPrefixes, `${where}: ticketPrefixes`),
    linear: mission.linear
      ? { team: required(mission.linear.team, `${where}: linear.team`), triageProject: mission.linear.triageProject || null }
      : null,
    crw: mission.crw ? { db: required(mission.crw.db, `${where}: crw.db`) } : null,
    releases: mission.releases
      ? {
          repo: required(mission.releases.repo, `${where}: releases.repo`),
          workflow: required(mission.releases.workflow, `${where}: releases.workflow`),
          tagPattern: new RegExp(required(mission.releases.tagPattern, `${where}: releases.tagPattern`)),
          serviceRepos: mission.releases.serviceRepos ?? {},
          otherRepos: list(mission.releases.otherRepos, `${where}: releases.otherRepos`),
        }
      : null,
    docs: (mission.docs ?? []).map((doc, index) => ({
      label: doc.label || 'Docs',
      repo: required(doc.repo, `${where}: docs[${index}].repo`),
      branch: doc.branch || 'main',
    })),
    messages: {
      kinds: mission.messages?.kinds ? list(mission.messages.kinds, `${where}: messages.kinds`) : DEFAULT_MESSAGE_KINDS,
      maxChars: Number(mission.messages?.maxChars ?? 60_000),
    },
    banned: regexes(mission.banned, `${where}: banned`),
    limits: { ...DEFAULT_LIMITS, ...(mission.limits ?? {}) },
  };
}

function required(value, what) {
  if (typeof value !== 'string' || !value) throw new Error(`${what} is required`);
  return value;
}

export function loadConfig(missionId, path = CONFIG_PATH) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`writer config ${path}: ${error.code === 'ENOENT' ? 'missing' : error.message}`);
  }
  return missionConfig(raw, missionId);
}

/**
 * The area a repo belongs to; for commits the area of their conventional
 * commit scope, else the area most of their files fall in.
 */
export function areaOf(config, { repo, scope, files, merge }) {
  if (merge) {
    const area = config.areas.find((candidate) => candidate.merges);
    if (area) return area.name;
  }
  if (repo) {
    const area = config.areas.find((candidate) => candidate.repos.includes(repo));
    if (area) return area.name;
  }
  if (scope) {
    const area = config.areas.find((candidate) => candidate.scopes.includes(scope));
    if (area) return area.name;
  }
  if (files?.length) {
    const votes = new Map();
    for (const file of files) {
      let best = null;
      for (const area of config.areas) {
        for (const prefix of area.paths) {
          if (file.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { area: area.name, prefix };
        }
      }
      if (best) votes.set(best.area, (votes.get(best.area) ?? 0) + 1);
    }
    let winner = null;
    for (const [area, count] of votes) if (!winner || count > winner.count) winner = { area, count };
    if (winner) return winner.area;
  }
  return config.defaultArea;
}

/** Area names in config order, then any others in first-seen order. */
export function areaOrder(config, names) {
  const known = config.areas.map((area) => area.name);
  const rest = [...new Set(names.filter((name) => !known.includes(name)))];
  return [...known.filter((name) => names.includes(name)), ...rest];
}
