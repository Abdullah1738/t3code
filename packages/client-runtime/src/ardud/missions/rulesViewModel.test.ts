import type { MissionId, Rule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import { actorNames } from "./roomsViewModel.ts";
import {
  auditLine,
  auditTitle,
  editReadingInput,
  editRuleInput,
  newRuleInput,
  quoteAuthor,
  resolveRuleChangeInput,
  ruleAckList,
  ruleAcks,
  ruleBookView,
  ruleFacts,
  ruleList,
  ruleUses,
  scopeLine,
  scopeParts,
  scopeShort,
  setRuleStatusInput,
  useLine,
} from "./rulesViewModel.ts";
import type { MissionRuleBook, MissionTimelineEvent } from "./source.ts";

const CRPKO = "crpko-engineering" as MissionId;
const MASTER = "crpko-master";

function openBook() {
  const source = createFixtureMissionsSource({ now: () => Date.parse(FIXTURE_NOW) + 60_000 });
  let book: MissionRuleBook | undefined;
  const close = source.subscribeRuleBook(CRPKO, (next) => {
    book = next;
  });
  return {
    source,
    get book(): MissionRuleBook {
      if (!book) throw new Error("no rule book");
      return book;
    },
    close,
  };
}

const ruleById = (book: MissionRuleBook, id: string): Rule => {
  const rule = book.rules.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(id);
  return rule;
};

describe("rule book", () => {
  it("puts rules that need a look first and keeps retired rules apart", () => {
    const { book, close } = openBook();
    const view = ruleBookView(book, MASTER);
    close();
    const ids = view.active.map((row) => row.rule.id);
    // Rule 10 has an open change request, a stale finding and a suggestion; rule 19 a conflict.
    expect(ids.slice(0, 2)).toEqual(["rule-10", "rule-19"]);
    expect(view.retired.map((row) => row.rule.id)).toEqual(["rule-18", "rule-26"]);
    expect(view.openChangeRequests).toBe(1);
    expect(view.auditFindings).toBe(2);
    const rule10 = view.active[0];
    expect(rule10?.changeRequests.open).toHaveLength(1);
    expect(rule10?.suggestions.map((suggestion) => suggestion.author)).toEqual(["scribe"]);
  });

  it("counts per-lane acks and reads scope, activation and use", () => {
    const { book, close } = openBook();
    close();
    const rule104 = ruleById(book, "rule-104");
    expect(ruleAcks(rule104).line).toBe("5 of 5 lanes acked");
    expect(ruleAcks(ruleById(book, "rule-105")).line).toBe("8 of 8 lanes acked");
    expect(ruleAcks(ruleById(book, "rule-7")).line).toBeNull();
    expect(scopeLine(rule104.scope)).toBe(
      "Lanes: cell-bo, cell-devops2, cell-fab-devops, cell-fab-svc, cell-fab-tc",
    );
    expect(scopeLine({ subMissionIds: [], roleKinds: [], laneIds: [] })).toBe("Whole mission");
    expect(scopeParts(rule104.scope)).toEqual([
      "Lanes: cell-bo, cell-devops2, cell-fab-devops, cell-fab-svc, cell-fab-tc",
    ]);
    expect(scopeParts({ subMissionIds: [], roleKinds: [], laneIds: [] })).toEqual([]);
    expect(useLine(ruleById(book, "rule-7"))).toBe("Used 149 times");
    expect(useLine({ appliedCount: 1, brokenCount: 2 })).toBe("Used once, broken twice");
    expect(useLine({ appliedCount: 0, brokenCount: 0 })).toBe("Not used yet");
  });

  it("names the other rule in an audit finding", () => {
    const { book, close } = openBook();
    close();
    const finding = book.audit.find((entry) => entry.kind === "conflict");
    expect(finding).toBeDefined();
    expect(auditLine(finding!, "rule-19", book.rules, MASTER)).toMatch(/^Conflict with rule 89: /);
  });
});

describe("rule edits", () => {
  it("edits a rule directly and says who changed it last", async () => {
    const open = openBook();
    const rule104 = ruleById(open.book, "rule-104");
    const input = editRuleInput(rule104, {
      activation: "While Claude has 8 or more usable accounts",
    });
    expect(input.ok).toBe(true);
    if (!input.ok) return;
    await open.source.upsertRule(input.value);
    const row = ruleBookView(open.book, MASTER).active.find(
      (entry) => entry.rule.id === "rule-104",
    );
    expect(row?.activation).toBe("While Claude has 8 or more usable accounts");
    expect(row?.changedBy.activation).toBe("last changed by you");
    expect(row?.rule.version).toBe(rule104.version + 1);
    open.close();
  });

  it("retires and restores a rule, and refuses empty wording", async () => {
    const open = openBook();
    await open.source.upsertRule(setRuleStatusInput(ruleById(open.book, "rule-103")));
    expect(ruleById(open.book, "rule-103").status).toBe("retired");
    expect(ruleBookView(open.book, MASTER).retired.map((row) => row.rule.id)).toContain("rule-103");
    expect(newRuleInput(CRPKO, "Title", "  ")).toEqual({
      ok: false,
      error: "A rule needs its wording.",
    });
    expect(editRuleInput(ruleById(open.book, "rule-7"), { title: " " }).ok).toBe(false);
    open.close();
  });

  it("applies or declines a change request; a decline needs a reason", async () => {
    const open = openBook();
    const request = open.book.changeRequests.find((entry) => entry.status === "open");
    expect(request).toBeDefined();
    expect(resolveRuleChangeInput(request!.id, "decline", " ")).toEqual({
      ok: false,
      error: "Say why the change is declined.",
    });
    const apply = resolveRuleChangeInput(request!.id, "apply", "");
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    await open.source.resolveRuleChange(apply.value);
    expect(open.book.changeRequests.find((entry) => entry.id === request!.id)?.status).toBe(
      "applied",
    );
    await expect(open.source.resolveRuleChange(apply.value)).rejects.toMatchObject({
      code: "conflict",
    });
    open.close();
  });
});

describe("rules page", () => {
  it("lists rules relied on most recently first, with scope, acks, use and problems", () => {
    const { book, close } = openBook();
    close();
    const view = ruleBookView(book, MASTER);
    const list = ruleList(view);
    const relied = list.filter((item) => item.lastRelied !== null).map((item) => item.lastRelied);
    expect(relied).toEqual(relied.toSorted().toReversed());
    // Rules nobody relied on yet come after every relied-on rule.
    const firstUnused = list.findIndex((item) => item.lastRelied === null);
    expect(list.slice(firstUnused).every((item) => item.lastRelied === null)).toBe(true);
    const rule104 = list.find((item) => item.row.rule.id === "rule-104");
    expect(rule104?.line).toBe("5 lanes, 5 of 5 acked. Used twice.");
    expect(list.find((item) => item.row.rule.id === "rule-7")?.line).toBe(
      "All lanes. Used 149 times.",
    );
    expect(list.find((item) => item.row.rule.id === "rule-19")?.problem).toBe(
      "Conflicts with rule 89.",
    );
    expect(list.find((item) => item.row.rule.id === "rule-10")?.problem).toBe(
      "Stale against rule 98.",
    );
    expect(rule104?.problem).toBeNull();
    const stale = book.audit.find((finding) => finding.kind === "stale");
    expect(auditTitle(stale!, book.rules)).toBe("Rule 10 stale against rule 98");
    expect(scopeShort({ subMissionIds: [], roleKinds: [], laneIds: [] })).toBe("All lanes");
  });

  it("names who acked and who relied on a rule, and keeps times in the reader's zone", () => {
    const { book, close } = openBook();
    close();
    const rule104 = ruleById(book, "rule-104");
    const names = actorNames([{ id: "lane-cell-bo" as never, name: "Back office" }], []);
    const acks = ruleAckList(rule104, MASTER, names);
    expect(acks?.line).toBe("Acknowledged by 5 of 5");
    expect(acks?.chips.map((chip) => chip.name)).toContain("Back office");
    expect(acks?.missing).toEqual([]);
    expect(ruleAckList(ruleById(book, "rule-7"), MASTER)).toBeNull();
    expect(quoteAuthor(rule104, MASTER)).toBe("Imported from STANDING-RULES");
    expect(
      quoteAuthor({ provenance: { _tag: "owner-app", surface: "web", sessionId: null } }, MASTER),
    ).toBe("You");

    const row = ruleBookView(book, MASTER).active.find((entry) => entry.rule.id === "rule-104")!;
    const now = Date.parse(rule104.lastReliedAt!) + 60_000;
    const relied = (zone: string) =>
      ruleFacts(row, now, [], zone).find((fact) => fact.label === "Last relied on")?.value;
    expect(relied("UTC")).toBe(rule104.lastReliedAt!.slice(11, 16));
    expect(relied("UTC")).not.toBe(relied("Asia/Dubai"));

    const use: MissionTimelineEvent = {
      id: "ev-use" as never,
      missionId: CRPKO,
      seq: 1,
      kind: "rule.applied",
      actor: { _tag: "role", roleId: MASTER as never },
      provenance: { _tag: "system", component: "test" },
      summary: "Relied on rule 104",
      subject: { kind: "rule", id: "rule-104" },
      causedBy: null,
      payload: null,
      at: rule104.lastReliedAt!,
    };
    const other = { ...use, id: "ev-other" as never, subject: { kind: "rule", id: "rule-7" } };
    expect(ruleUses([use, other as MissionTimelineEvent], "rule-104", MASTER)).toEqual([
      { key: "ev-use", at: use.at, summary: "Relied on rule 104", by: "master", broken: false },
    ]);
  });

  it("edits the master's reading without touching the owner's quote", async () => {
    const open = openBook();
    const rule104 = ruleById(open.book, "rule-104");
    expect(editReadingInput(rule104, rule104.masterReading).ok).toBe(false);
    const input = editReadingInput(rule104, "Run four Haiku workers per lead while usage allows.");
    expect(input.ok).toBe(true);
    if (!input.ok) return;
    await open.source.upsertRule(input.value);
    const after = ruleById(open.book, "rule-104");
    expect(after.masterReading).toBe("Run four Haiku workers per lead while usage allows.");
    expect(after.quote).toBe(rule104.quote);
    expect(after.quotedAt).toBe(rule104.quotedAt);
    // A new reading is not a new version: lanes keep their acks.
    expect(after.version).toBe(rule104.version);
    const row = ruleBookView(open.book, MASTER).active.find(
      (entry) => entry.rule.id === "rule-104",
    );
    expect(row?.changedBy.masterReading).toBe("last changed by you");
    open.close();
  });
});
