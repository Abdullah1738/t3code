import type { MissionId, Rule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureMissionsSource, FIXTURE_NOW } from "./fixture/index.ts";
import {
  auditLine,
  editRuleInput,
  newRuleInput,
  resolveRuleChangeInput,
  ruleAcks,
  ruleBookView,
  scopeLine,
  setRuleStatusInput,
  useLine,
} from "./rulesViewModel.ts";
import type { MissionRuleBook } from "./source.ts";

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
