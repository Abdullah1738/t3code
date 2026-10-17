import type { TranscriptEvent } from "./transcriptText.ts";

/**
 * Claim-of-done evidence. "Done" never comes from language: when a lane says
 * something shipped, code pairs the claim with what collectors saw. Today the
 * collectors are the lane thread's linked PR snapshots (state, checks) and
 * tool output the lane itself observed (gh, git, CI and deploy readback
 * commands in its transcript). The verdict is:
 *
 * - `mismatch` when any named ref contradicts the claim (claimed merged, PR
 *   is open; claimed green, the run failed),
 * - `matched` when every named ref is confirmed,
 * - `missing` when the claim names nothing checkable or a ref can't be found.
 *
 * Pure and type-import only: the scribe proof scripts import it directly.
 */

export type EvidenceRefKind = "pull-request" | "ci-run" | "commit" | "deploy";

export interface EvidenceRef {
  readonly kind: EvidenceRefKind;
  /** PR number, run id, sha or digest. */
  readonly key: string;
  /** `owner/repo` or `repo` when the claim named one. */
  readonly repository: string | null;
}

export interface PullRequestFact {
  readonly repository: string;
  readonly number: number;
  readonly url: string | null;
  /** Lower-case: open, merged, closed. */
  readonly state: string;
  readonly checksState: string | null;
}

export interface EvidenceFacts {
  readonly pullRequests: ReadonlyArray<PullRequestFact>;
  /** Tool output the lane observed; only `observed` events are considered. */
  readonly events: ReadonlyArray<TranscriptEvent>;
}

export interface EvidenceLink {
  readonly kind: "pull-request" | "commit" | "ci-run" | "deploy";
  readonly label: string;
  readonly url: string | null;
  readonly ref: string | null;
}

export type RefVerdict = "matched" | "mismatch" | "missing";

export interface RefCheck {
  readonly ref: EvidenceRef;
  readonly verdict: RefVerdict;
  readonly reason: string;
}

export interface EvidenceCheck {
  readonly evidence: "matched" | "mismatch" | "missing";
  readonly refs: ReadonlyArray<RefCheck>;
  readonly links: ReadonlyArray<EvidenceLink>;
}

const PR_PATTERNS: ReadonlyArray<RegExp> = [
  /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,6})/giu,
  /\b([\w.-]+\/[\w.-]+)#(\d{1,6})\b/giu,
  /\b([A-Za-z][\w.-]*)#(\d{1,6})\b/gu,
  /\bPRs?\s*#?(\d{1,6})\b/giu,
];
const RUN_PATTERN = /\b(?:actions\/runs\/|runs?\s*(?:id\s*)?#?)(\d{8,12})\b/giu;
const DIGEST_PATTERN = /\bsha256:([0-9a-f]{12,64})\b/giu;
const SHA_PATTERN = /\b(?:commit|head|sha|merged at|@)\s*[:=]?\s*([0-9a-f]{7,40})\b/giu;

const CLAIMS_MERGED = /\bmerged?\b|\blanded\b/iu;
const CLAIMS_GREEN = /\bgreen\b|\bpass(?:ed|ing|es)?\b|\bsucce(?:ss|eded)\b|\bclean\b/iu;

const NOT_REPOS = new Set(["pr", "prs", "pull", "issue", "seq", "incident", "rule", "item"]);

/** Every checkable ref a claim names, deduplicated, in order of appearance. */
export const extractRefs = (text: string): ReadonlyArray<EvidenceRef> => {
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();
  const add = (ref: EvidenceRef) => {
    const id = `${ref.kind}:${ref.key}`;
    if (seen.has(id)) {
      // Prefer the variant that names the repository.
      if (ref.repository !== null) {
        const index = refs.findIndex((r) => `${r.kind}:${r.key}` === id && r.repository === null);
        if (index >= 0) refs[index] = ref;
      }
      return;
    }
    seen.add(id);
    refs.push(ref);
  };
  for (const pattern of PR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const number = match[2] ?? match[1];
      const repo = match[2] === undefined ? null : (match[1] ?? null);
      if (number === undefined) continue;
      if (repo !== null && NOT_REPOS.has(repo.toLowerCase())) {
        if (repo.toLowerCase() === "pr" || repo.toLowerCase() === "prs") {
          add({ kind: "pull-request", key: number, repository: null });
        }
        continue;
      }
      add({ kind: "pull-request", key: number, repository: repo });
    }
  }
  for (const match of text.matchAll(RUN_PATTERN)) {
    if (match[1] !== undefined) add({ kind: "ci-run", key: match[1], repository: null });
  }
  for (const match of text.matchAll(DIGEST_PATTERN)) {
    if (match[1] !== undefined) {
      add({ kind: "deploy", key: `sha256:${match[1].toLowerCase()}`, repository: null });
    }
  }
  for (const match of text.matchAll(SHA_PATTERN)) {
    const sha = match[1]?.toLowerCase();
    if (sha === undefined || !/\d/u.test(sha) || !/[a-f]/u.test(sha)) continue;
    add({ kind: "commit", key: sha, repository: null });
  }
  return refs;
};

const repoMatches = (named: string | null, actual: string): boolean => {
  if (named === null) return true;
  const a = actual.toLowerCase();
  const n = named.toLowerCase();
  return a === n || a.endsWith(`/${n}`) || n.endsWith(`/${a}`);
};

const observedTexts = (facts: EvidenceFacts): ReadonlyArray<TranscriptEvent> =>
  facts.events.filter((event) => event.observed && event.text.length > 0);

const prStateFromOutput = (text: string): string | null => {
  const json = /"state"\s*:\s*"(MERGED|OPEN|CLOSED)"/iu.exec(text);
  if (json?.[1] !== undefined) return json[1].toLowerCase();
  const plain = /\bstate:\s*(MERGED|OPEN|CLOSED)\b/iu.exec(text);
  if (plain?.[1] !== undefined) return plain[1].toLowerCase();
  if (/✓\s*Merged pull request|was already merged|Pull request .* merged/iu.test(text)) {
    return "merged";
  }
  return null;
};

const checkPullRequest = (ref: EvidenceRef, claim: string, facts: EvidenceFacts): RefCheck => {
  const number = Number(ref.key);
  const fact = facts.pullRequests.find(
    (pr) => pr.number === number && repoMatches(ref.repository, pr.repository),
  );
  const claimsMerged = CLAIMS_MERGED.test(claim);
  const claimsGreen = CLAIMS_GREEN.test(claim);
  let state: string | null = fact?.state.toLowerCase() ?? null;
  let source = fact === undefined ? "" : `PR snapshot ${fact.repository}#${fact.number}`;
  if (state === null) {
    const mention = new RegExp(
      `(?:pr\\s+(?:view|merge|checks|status)\\s+#?${number}\\b|/pull/${number}\\b|#${number}\\b)`,
      "iu",
    );
    const seen = observedTexts(facts)
      .filter((event) => mention.test(event.text))
      .map((event) => ({ event, state: prStateFromOutput(event.text) }))
      .filter((entry) => entry.state !== null);
    const latest = seen.at(-1);
    if (latest !== undefined) {
      state = latest.state;
      source = `tool output e${latest.event.event}`;
    }
  }
  if (state === null) return { ref, verdict: "missing", reason: "no PR state seen" };
  if (claimsMerged && state !== "merged") {
    return { ref, verdict: "mismatch", reason: `claimed merged, ${source} says ${state}` };
  }
  const checks = fact?.checksState?.toLowerCase() ?? null;
  if (claimsGreen && !claimsMerged && checks !== null && /fail|error/u.test(checks)) {
    return { ref, verdict: "mismatch", reason: `claimed green, checks are ${checks}` };
  }
  return { ref, verdict: "matched", reason: `${source} says ${state}` };
};

const checkRun = (ref: EvidenceRef, claim: string, facts: EvidenceFacts): RefCheck => {
  const latest = observedTexts(facts).findLast((event) => event.text.includes(ref.key));
  if (latest === undefined)
    return { ref, verdict: "missing", reason: "run not seen in tool output" };
  const text = latest.text;
  const failed = /\b(failure|failed|cancelled|timed_out)\b|✗|X\s+(?:build|test)/iu.test(text);
  const passed = /\b(success|completed\s+success|succeeded)\b|✓/iu.test(text);
  if (failed && !passed && CLAIMS_GREEN.test(claim)) {
    return { ref, verdict: "mismatch", reason: `claimed green, run failed at e${latest.event}` };
  }
  if (passed || failed) {
    return { ref, verdict: "matched", reason: `run status seen at e${latest.event}` };
  }
  return { ref, verdict: "missing", reason: "run seen without a status" };
};

const checkSeen = (ref: EvidenceRef, facts: EvidenceFacts, what: string): RefCheck => {
  const key = ref.key.toLowerCase();
  const latest = observedTexts(facts).findLast((event) => event.text.toLowerCase().includes(key));
  return latest === undefined
    ? { ref, verdict: "missing", reason: `${what} not seen in tool output` }
    : { ref, verdict: "matched", reason: `${what} read back at e${latest.event}` };
};

const linkFor = (check: RefCheck, facts: EvidenceFacts): EvidenceLink => {
  const { ref } = check;
  switch (ref.kind) {
    case "pull-request": {
      const fact = facts.pullRequests.find(
        (pr) => pr.number === Number(ref.key) && repoMatches(ref.repository, pr.repository),
      );
      const repository = fact?.repository ?? ref.repository;
      return {
        kind: "pull-request",
        label: `${repository === null ? "PR " : repository}#${ref.key}`,
        url: fact?.url ?? null,
        ref: repository === null ? `#${ref.key}` : `${repository}#${ref.key}`,
      };
    }
    case "ci-run":
      return { kind: "ci-run", label: `CI run ${ref.key}`, url: null, ref: ref.key };
    case "commit":
      return { kind: "commit", label: `commit ${ref.key.slice(0, 10)}`, url: null, ref: ref.key };
    case "deploy":
      return { kind: "deploy", label: `deploy ${ref.key.slice(0, 19)}`, url: null, ref: ref.key };
  }
};

/**
 * Check a claim-of-done note. `claim` is the note summary plus its quotes;
 * other note types are `not-applicable` and never reach this function.
 */
export const checkEvidence = (claim: string, facts: EvidenceFacts): EvidenceCheck => {
  const refs = extractRefs(claim);
  if (refs.length === 0) return { evidence: "missing", refs: [], links: [] };
  const checks = refs.map((ref): RefCheck => {
    switch (ref.kind) {
      case "pull-request":
        return checkPullRequest(ref, claim, facts);
      case "ci-run":
        return checkRun(ref, claim, facts);
      case "commit":
        return checkSeen(ref, facts, "commit");
      case "deploy":
        return checkSeen(ref, facts, "digest");
    }
  });
  const evidence = checks.some((check) => check.verdict === "mismatch")
    ? "mismatch"
    : checks.every((check) => check.verdict === "matched")
      ? "matched"
      : "missing";
  return {
    evidence,
    refs: checks,
    links: checks
      .filter((check) => check.verdict !== "missing")
      .map((check) => linkFor(check, facts)),
  };
};

/** Turn a Robob thread's `pullRequests` payload into PR facts. */
export const pullRequestFacts = (threadPayload: unknown): ReadonlyArray<PullRequestFact> => {
  if (threadPayload === null || typeof threadPayload !== "object") return [];
  const list = (threadPayload as { pullRequests?: unknown }).pullRequests;
  if (!Array.isArray(list)) return [];
  const facts: PullRequestFact[] = [];
  for (const entry of list as ReadonlyArray<Record<string, unknown>>) {
    const repository = typeof entry.repository === "string" ? entry.repository : null;
    const number = typeof entry.number === "number" ? entry.number : null;
    if (repository === null || number === null) continue;
    const snapshot =
      entry.snapshot !== null && typeof entry.snapshot === "object"
        ? (entry.snapshot as Record<string, unknown>)
        : {};
    facts.push({
      repository,
      number,
      url: typeof entry.url === "string" ? entry.url : null,
      state: typeof snapshot.state === "string" ? snapshot.state.toLowerCase() : "unknown",
      checksState: typeof snapshot.checksState === "string" ? snapshot.checksState : null,
    });
  }
  return facts;
};
