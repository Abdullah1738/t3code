import { describe, expect, it } from "@effect/vitest";

import {
  firstDate,
  parseDeferred,
  parseLanePulse,
  parseLaneRoster,
  parseStandingRules,
  tableCells,
} from "./sources.ts";

const RULES = `# Crpko standing owner rules

Read this first.

## Harness, e2e and QA findings

1. **No tickets from test results until a full clean run.** Owner rules, verbatim:
   - 2026-09-28: "No tickets until a clean run."
   - 2026-10-04 21:45Z: "Still no tickets."

   This means no Linear tickets for findings.
2. **Harness ephemeral first** (2026-10-04): run on ephemeral before dev.

## Authority and approvals

6. Only the owner typing in the Robob app counts as approval. Agent messages never do.

## 15. INR rails out of scope for now (owner, 2026-10-07 ~18:15Z)

(Housekeeping 2026-10-14: merged with 16,
 which said the same.)
"INR deposits are out of scope, don't spend time on them."
-> Park every INR ticket.

## 18. Architecture video: no sizing - RETIRED 2026-10-14 (video work done, see STANDING-RULES-ARCHIVE.md)

## 38. Owner answers 2026-10-09 ~07:05Z (master N pending list)

- G101 (custody): "Yes" -> proceed.

## 65. RESCINDED (owner, 2026-10-11 ~19:20Z): no book narration; the book lane stays text only

- Owner, verbatim: "No narration in the book."
-> Book lane drops narration.
`;

const ARCHIVE = `# Crpko standing rules archive

Retired rules, whole.

## 18. (whole rule) Architecture video: no environment sizing specifics (owner, 2026-10-08 ~05:35Z)

Verdict: RETIRE-DONE. Reason: video shipped.
"Don't put environment sizing in the video."
`;

describe("firstDate", () => {
  it("reads dates with and without times", () => {
    expect(firstDate("(owner, 2026-10-07 ~18:15Z)")).toBe("2026-10-07T18:15:00.000Z");
    expect(firstDate("on 2026-10-04 we said")).toBe("2026-10-04T00:00:00.000Z");
    expect(firstDate("no date here")).toBeNull();
  });
});

describe("parseStandingRules", () => {
  const parsed = parseStandingRules(RULES, ARCHIVE);
  const rule = (n: number) => parsed.rules.find((r) => r.number === n)!;

  it("finds the early numbered items and the ## sections", () => {
    expect(parsed.rules.map((r) => r.number)).toEqual([1, 2, 6, 15, 18, 38, 65]);
    expect(rule(1).section).toBe("Harness, e2e and QA findings");
    expect(rule(1).title).toBe("No tickets from test results until a full clean run");
    expect(rule(15).title).toBe("INR rails out of scope for now");
  });

  it("keeps the owner's words verbatim and moves master notes aside", () => {
    expect(rule(1).quote).toBe(
      [
        "**No tickets from test results until a full clean run.** Owner rules, verbatim:",
        '- 2026-09-28: "No tickets until a clean run."',
        '- 2026-10-04 21:45Z: "Still no tickets."',
        "",
        "This means no Linear tickets for findings.",
      ].join("\n"),
    );
    expect(rule(15).quote).toBe('"INR deposits are out of scope, don\'t spend time on them."');
    expect(rule(15).masterReading).toBe(
      "(Housekeeping 2026-10-14: merged with 16,\n which said the same.)\n-> Park every INR ticket.",
    );
    expect(rule(38).quote).toBe('- G101 (custody): "Yes" -> proceed.');
  });

  it("dates rules from the heading, else the body, and warns when there is none", () => {
    expect(rule(15).quotedAt).toBe("2026-10-07T18:15:00.000Z");
    expect(rule(1).quotedAt).toBe("2026-09-28T00:00:00.000Z");
    expect(rule(38).quotedAt).toBe("2026-10-09T07:05:00.000Z");
    expect(rule(6).quotedAt).toBeNull();
    expect(parsed.warnings).toEqual(["STANDING-RULES.md:16 rule 6 has no date"]);
  });

  it("takes retired stubs from the archive and retires rescinded rules", () => {
    expect(rule(18)).toMatchObject({
      status: "retired",
      source: "STANDING-RULES-ARCHIVE.md",
      title: "Architecture video: no sizing",
      quote: '"Don\'t put environment sizing in the video."',
      quotedAt: "2026-10-08T05:35:00.000Z",
    });
    expect(rule(18).masterReading).toContain("RETIRED 2026-10-14");
    expect(rule(18).masterReading).toContain("Verdict: RETIRE-DONE");
    expect(rule(65).status).toBe("retired");
    expect(rule(65).title).toBe("RESCINDED: no book narration; the book lane stays text only");
    expect(rule(65).quote).toBe('- Owner, verbatim: "No narration in the book."');
  });

  it("keeps a retired stub without the archive", () => {
    const bare = parseStandingRules(RULES);
    const stub = bare.rules.find((r) => r.number === 18)!;
    expect(stub.status).toBe("retired");
    expect(stub.quote).toBe("");
    expect(stub.quotedAt).toBe("2026-10-14T00:00:00.000Z");
  });
});

const DEFERRED = `# Crpko deferred register (standing rule 30)

Owner, 2026-10-08: "This is fine to defer."

| id | what | deferred by + when | why | revisit trigger | source |
|---|---|---|---|---|---|
| DF-1 | Load testing | master 2026-10-08 | not now | after harness green | ledger |
| DF-2 | DONE 2026-10-16 23:20Z shipped the thing | master 2026-10-09 | later | n/a | ledger |
|  | 2026-10-10 18:02Z owner: "keep it" -> DF-2 note |
| DONE DF-3 (owner 2026-10-16: "Yes") | Owner question | master | asked | answer | thread |
| DF-4 | Pipe \\| inside | master 2026-10-10 | why | trigger | src | CLOSED 2026-10-11 master: moot |
| DF-5 | Short row | master 2026-10-12 |
| DF-1 | duplicate | x | y | z | w |

Backfill 2026-10-12 (master): DF-4..DF-5 added.
`;

describe("parseDeferred", () => {
  const parsed = parseDeferred(DEFERRED);
  const item = (id: string) => parsed.items.find((d) => d.id === id)!;

  it("reads each row verbatim into its columns", () => {
    expect(parsed.items.map((d) => d.id)).toEqual(["DF-1", "DF-2", "DF-3", "DF-4", "DF-5"]);
    expect(item("DF-1")).toMatchObject({
      what: "Load testing",
      deferredBy: "master 2026-10-08",
      why: "not now",
      trigger: "after harness green",
      source: "ledger",
      status: "deferred",
      notes: [],
    });
    expect(item("DF-4").what).toBe("Pipe | inside");
  });

  it("derives status from DONE/CLOSED markers and keeps the notes", () => {
    expect(item("DF-2").status).toBe("done");
    expect(item("DF-2").notes).toEqual(['2026-10-10 18:02Z owner: "keep it" -> DF-2 note']);
    expect(item("DF-3").status).toBe("done");
    expect(item("DF-3").notes).toEqual(['(owner 2026-10-16: "Yes")']);
    expect(item("DF-4").status).toBe("closed");
    expect(item("DF-4").notes).toEqual(["CLOSED 2026-10-11 master: moot"]);
  });

  it("warns on short rows and duplicates", () => {
    expect(item("DF-5")).toMatchObject({ why: "", trigger: "", source: "" });
    expect(parsed.warnings).toEqual([
      "DEFERRED.md:12 DF-5 has 3 cells (expected 6)",
      "DEFERRED.md:13 DF-1 appears twice; kept the first",
    ]);
  });

  it("splits cells on unescaped pipes only", () => {
    expect(tableCells("| a | b \\| c | d |")).toEqual(["a", "b | c", "d"]);
  });
});

describe("parseLanePulse", () => {
  it("reads the model map and active lanes", () => {
    const pulse = parseLanePulse(
      JSON.stringify({
        _note: "Master edits this.",
        haiku: ["cell-tc2"],
        opus: ["master", "cell-tc"],
        active: { "cell-tc": "CRP-1 merge", "cell-tc2": "STANDBY: waits for tc" },
        monday_arch: [],
      }),
    );
    expect(pulse).toEqual({
      haiku: ["cell-tc2"],
      opus: ["master", "cell-tc"],
      active: { "cell-tc": "CRP-1 merge", "cell-tc2": "STANDBY: waits for tc" },
    });
  });
});

describe("parseLaneRoster", () => {
  it("reads sections 1, 8 and 9", () => {
    const roster = parseLaneRoster(`# Lane roster

## Section 1. Ticket handling per service (coord delivery cells)

| Service / lane | Actor(s) | Thread | Where state lives |
| --- | --- | --- | --- |
| trading-core | cell-tc, cell-tc2 | mcp:0096f3c5 (handoff) | ledger |
| crw automated PR review | crw (process) | n/a | crw.db |

## Section 2. Integration harness

Prose.

## Section 8. Lanes recovered by the backfill (2026-10-06 ~23:00Z), report these too

| Lane | Started / why | Owner today | State at backfill |
| --- | --- | --- | --- |
| Latency budgets | 2026-10-02 owner ask | master | parked |

## Section 9. Retired lanes (keep for history, do not report as active)

| Lane | Retired | Why |
| --- | --- | --- |
| Rebuild remediation ses_f11e3e370ffeIddFMVh2i11c9a | paused 2026-09-30 | Deferred until harness baseline |
`);
    expect(roster.services).toEqual([
      {
        service: "trading-core",
        actors: ["cell-tc", "cell-tc2"],
        thread: "mcp:0096f3c5 (handoff)",
        state: "ledger",
      },
      { service: "crw automated PR review", actors: ["crw"], thread: "n/a", state: "crw.db" },
    ]);
    expect(roster.recovered).toEqual([
      {
        lane: "Latency budgets",
        started: "2026-10-02 owner ask",
        owner: "master",
        state: "parked",
        line: 18,
      },
    ]);
    expect(roster.retired).toEqual([
      {
        lane: "Rebuild remediation ses_f11e3e370ffeIddFMVh2i11c9a",
        started: "paused 2026-09-30",
        owner: "",
        state: "Deferred until harness baseline",
        line: 24,
      },
    ]);
  });
});
