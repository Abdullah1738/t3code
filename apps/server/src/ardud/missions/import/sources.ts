/**
 * Parsers for the Crpko status files the coord import reads. They are pure
 * (text in, plain data out) and keep owner text verbatim: rule quotes and
 * deferred rows are copied character for character, only split into fields.
 */

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})(?:[ T]~?(\d{1,2}):(\d{2})(?::(\d{2}))?Z?)?/;

/** First `YYYY-MM-DD[ ~HH:MMZ]` in the text as an ISO instant (UTC), or null. */
export const firstDate = (text: string): string | null => {
  const m = DATE_RE.exec(text);
  if (m === null) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  const hour = (hh ?? "00").padStart(2, "0");
  if (Number(hour) > 23) return `${y}-${mo}-${d}T00:00:00.000Z`;
  return `${y}-${mo}-${d}T${hour}:${mm ?? "00"}:${ss ?? "00"}.000Z`;
};

const lines = (text: string) => text.replace(/\r\n/g, "\n").split("\n");

const trimBlankEdges = (block: ReadonlyArray<string>): Array<string> => {
  let start = 0;
  let end = block.length;
  while (start < end && block[start]!.trim() === "") start++;
  while (end > start && block[end - 1]!.trim() === "") end--;
  return block.slice(start, end);
};

// ---------------------------------------------------------------------------
// STANDING-RULES.md

export interface ParsedRule {
  readonly number: number;
  readonly title: string;
  /** Owner text, verbatim. Master annotations are moved to `masterReading`. */
  readonly quote: string;
  readonly masterReading: string;
  readonly quotedAt: string | null;
  readonly status: "active" | "retired";
  /** Section heading for rules 1-14, which sit under topic headings. */
  readonly section: string | null;
  readonly source: "STANDING-RULES.md" | "STANDING-RULES-ARCHIVE.md";
  readonly line: number;
}

export interface ParsedRules {
  readonly rules: ReadonlyArray<ParsedRule>;
  readonly warnings: ReadonlyArray<string>;
}

/** Lines that are the master's reading or housekeeping, not the owner's words. */
const isAnnotation = (line: string) => {
  const t = line.trimStart();
  return t.startsWith("->") || t.startsWith("(Housekeeping") || t.startsWith("(Master practice");
};

const parenDepth = (line: string) => {
  let depth = 0;
  for (const ch of line) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
  return depth;
};

const splitQuote = (body: ReadonlyArray<string>) => {
  const quote: Array<string> = [];
  const reading: Array<string> = [];
  // A parenthesised note may wrap over several lines; it stays a note until it closes.
  let open = 0;
  for (const line of body) {
    if (open > 0) {
      reading.push(line);
      open = Math.max(0, open + parenDepth(line));
      continue;
    }
    if (isAnnotation(line)) {
      reading.push(line);
      if (line.trimStart().startsWith("(")) open = Math.max(0, parenDepth(line));
      continue;
    }
    quote.push(line);
  }
  return {
    quote: trimBlankEdges(quote).join("\n"),
    masterReading: trimBlankEdges(reading).join("\n"),
  };
};

const TITLE_MAX = 120;
const clip = (text: string) =>
  text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1).trimEnd()}…`;

/** Title of an early numbered item: its bold lead, else its first sentence. */
const itemTitle = (first: string, fallback: string) => {
  const bold = /^\*\*(.+?)\*\*/.exec(first);
  if (bold !== null) return clip(bold[1]!.replace(/[.:]\s*$/, "").trim());
  const plain = first
    .replace(/^\([^)]*\)\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/^["“]/, "");
  const sentence =
    /^(.+?)(?:\.\s|:\s|\s\(|$)/
      .exec(plain)?.[1]
      ?.replace(/["”]$/, "")
      .trim() ?? "";
  return sentence.length > 0 ? clip(sentence) : fallback;
};

const RETIRED_RE = /\s+-\s+RETIRED\s+(\d{4}-\d{2}-\d{2})\b\s*(.*)$/;

/** Drops the `(owner, date, ...)` attribution from a heading; it may nest parens. */
const withoutOwnerParen = (heading: string) => {
  const start = heading.search(/\((?:owner|Owner)\b/);
  if (start === -1) return heading.trim();
  let depth = 0;
  for (let i = start; i < heading.length; i++) {
    if (heading[i] === "(") depth++;
    if (heading[i] === ")" && --depth === 0) {
      return `${heading.slice(0, start).trimEnd()}${heading.slice(i + 1)}`
        .replace(/\s+:/, ":")
        .trim();
    }
  }
  return heading.slice(0, start).trim();
};

interface ArchivedRule {
  readonly title: string;
  readonly quotedAt: string | null;
  readonly body: ReadonlyArray<string>;
  readonly line: number;
}

/** Whole-rule sections of STANDING-RULES-ARCHIVE.md, by rule number. */
export const parseRulesArchive = (text: string): ReadonlyMap<number, ArchivedRule> => {
  const out = new Map<number, ArchivedRule>();
  const all = lines(text);
  for (let i = 0; i < all.length; i++) {
    const m = /^## (\d+)\. \(whole rule\) (.*)$/.exec(all[i]!);
    if (m === null) continue;
    let j = i + 1;
    while (j < all.length && !all[j]!.startsWith("## ")) j++;
    const heading = m[2]!;
    out.set(Number(m[1]), {
      title: withoutOwnerParen(heading),
      quotedAt: firstDate(heading),
      body: trimBlankEdges(all.slice(i + 1, j)),
      line: i + 1,
    });
  }
  return out;
};

const isVerdict = (line: string) => line.trimStart().startsWith("Verdict:");

/**
 * STANDING-RULES.md: rules 1-14 are numbered list items under topic headings,
 * later rules are `## N. Title (owner, date)` sections. Retired rules are
 * one-line stubs whose text lives in the archive; when the archive is given
 * their quote comes from there.
 */
export const parseStandingRules = (text: string, archiveText?: string): ParsedRules => {
  const all = lines(text);
  const archive =
    archiveText === undefined ? new Map<number, ArchivedRule>() : parseRulesArchive(archiveText);
  const rules: Array<ParsedRule> = [];
  const warnings: Array<string> = [];
  const seen = new Set<number>();
  const add = (rule: ParsedRule) => {
    if (seen.has(rule.number)) {
      warnings.push(
        `STANDING-RULES.md:${rule.line} rule ${rule.number} appears twice; kept the first`,
      );
      return;
    }
    seen.add(rule.number);
    if (rule.quotedAt === null)
      warnings.push(`STANDING-RULES.md:${rule.line} rule ${rule.number} has no date`);
    rules.push(rule);
  };

  const firstNumbered = all.findIndex((l) => /^## \d+\. /.test(l));
  const earlyEnd = firstNumbered === -1 ? all.length : firstNumbered;

  // Rules 1-14: `N. text` items with indented continuation lines.
  let section: string | null = null;
  for (let i = 0; i < earlyEnd; i++) {
    const line = all[i]!;
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      continue;
    }
    const m = /^(\d+)\. (.*)$/.exec(line);
    if (m === null || section === null) continue;
    const indent = m[1]!.length + 2;
    let j = i + 1;
    while (j < earlyEnd && !/^\d+\. /.test(all[j]!) && !all[j]!.startsWith("## ")) j++;
    const body = [
      m[2]!,
      ...all
        .slice(i + 1, j)
        .map((l) => (l.slice(0, indent).trim() === "" ? l.slice(indent) : l.trimStart())),
    ];
    const { quote, masterReading } = splitQuote(body);
    add({
      number: Number(m[1]),
      title: itemTitle(m[2]!, section),
      quote,
      masterReading,
      quotedAt: firstDate(body.join("\n")),
      status: "active",
      section,
      source: "STANDING-RULES.md",
      line: i + 1,
    });
    i = j - 1;
  }

  // Rules 15+: `## N. heading` sections, body until the next `## `.
  for (let i = earlyEnd; i < all.length; i++) {
    const m = /^## (\d+)\. (.*)$/.exec(all[i]!);
    if (m === null) continue;
    const number = Number(m[1]);
    let j = i + 1;
    while (j < all.length && !all[j]!.startsWith("## ")) j++;
    const body = trimBlankEdges(all.slice(i + 1, j));
    let heading = m[2]!.trim();
    const retired = RETIRED_RE.exec(heading);
    const rescinded = heading.startsWith("RESCINDED");
    let retiredNote: string | null = null;
    if (retired !== null) {
      retiredNote = heading.slice(retired.index).replace(/^\s+-\s+/, "");
      heading = heading.slice(0, retired.index).trim();
    }
    const title = withoutOwnerParen(heading);
    let { quote, masterReading } = splitQuote(body);
    let quotedAt = firstDate(heading) ?? firstDate(body.join("\n"));
    let source: ParsedRule["source"] = "STANDING-RULES.md";
    const archived = archive.get(number);
    if (retiredNote !== null && body.length === 0 && archived !== undefined) {
      const kept = archived.body.filter((l) => !isVerdict(l));
      quote = trimBlankEdges(kept).join("\n");
      masterReading = [retiredNote, ...archived.body.filter(isVerdict)].join("\n");
      quotedAt = archived.quotedAt ?? quotedAt;
      source = "STANDING-RULES-ARCHIVE.md";
    } else if (retiredNote !== null) {
      masterReading = [retiredNote, masterReading].filter((s) => s.length > 0).join("\n");
    }
    if (retired !== null && quotedAt === null) quotedAt = firstDate(retired[1]!);
    add({
      number,
      title: title.length > 0 ? clip(title) : `Rule ${number}`,
      quote,
      masterReading,
      quotedAt,
      status: retired !== null || rescinded ? "retired" : "active",
      section: null,
      source,
      line: i + 1,
    });
    i = j - 1;
  }
  return { rules, warnings };
};

// ---------------------------------------------------------------------------
// DEFERRED.md

export type DeferredStatus = "deferred" | "fired" | "done" | "closed";

export interface ParsedDeferred {
  readonly id: string;
  readonly what: string;
  readonly deferredBy: string;
  readonly why: string;
  readonly trigger: string;
  readonly source: string;
  /** Extra cells, id-cell remarks and continuation rows, verbatim. */
  readonly notes: ReadonlyArray<string>;
  readonly status: DeferredStatus;
  readonly line: number;
}

export interface ParsedDeferredRegister {
  readonly items: ReadonlyArray<ParsedDeferred>;
  readonly warnings: ReadonlyArray<string>;
}

/** Cells of a markdown table row; `\|` stays inside a cell. */
export const tableCells = (line: string): Array<string> => {
  const inner = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};

const statusOf = (cell: string): DeferredStatus | null => {
  const m = /^[[(]?\s*(FIRED\+DONE|TRIGGER FIRED|FIRED|DONE|CLOSED)\b/.exec(cell);
  if (m === null) return null;
  if (m[1] === "CLOSED") return "closed";
  if (m[1] === "TRIGGER FIRED" || m[1] === "FIRED") return "fired";
  return "done";
};

const RANK: Record<DeferredStatus, number> = { deferred: 0, fired: 1, closed: 2, done: 3 };

export const parseDeferred = (text: string): ParsedDeferredRegister => {
  const items: Array<{ -readonly [K in keyof ParsedDeferred]: ParsedDeferred[K] }> = [];
  const warnings: Array<string> = [];
  const seen = new Set<string>();
  const all = lines(text);
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!;
    if (!line.trimStart().startsWith("|")) continue;
    const cells = tableCells(line);
    if (cells.every((c) => /^-*$/.test(c)) || cells[0] === "id") continue;
    const idCell = cells[0] ?? "";
    const m = /^(DONE\s+)?(DF-\d+)\b\s*(.*)$/.exec(idCell);
    if (m === null) {
      const prev = items.at(-1);
      if (idCell === "" && prev !== undefined) {
        prev.notes = [...prev.notes, cells.filter((c) => c.length > 0).join(" | ")];
      } else {
        warnings.push(`DEFERRED.md:${i + 1} row without a DF id skipped`);
      }
      continue;
    }
    const id = m[2]!;
    if (seen.has(id)) {
      warnings.push(`DEFERRED.md:${i + 1} ${id} appears twice; kept the first`);
      continue;
    }
    seen.add(id);
    const [, what = "", deferredBy = "", why = "", trigger = "", source = "", ...extra] = cells;
    const notes = [m[3]!, ...extra].filter((c) => c.length > 0);
    let status: DeferredStatus = m[1] !== undefined ? "done" : "deferred";
    for (const cell of [what, deferredBy, ...extra]) {
      const s = statusOf(cell);
      if (s !== null && RANK[s] > RANK[status]) status = s;
    }
    if (cells.length < 6)
      warnings.push(`DEFERRED.md:${i + 1} ${id} has ${cells.length} cells (expected 6)`);
    items.push({ id, what, deferredBy, why, trigger, source, notes, status, line: i + 1 });
  }
  return { items, warnings };
};

// ---------------------------------------------------------------------------
// lane-pulse.json

export interface LanePulse {
  readonly haiku: ReadonlyArray<string>;
  readonly opus: ReadonlyArray<string>;
  /** actor -> open work; text starting STANDBY means the lane waits by decision. */
  readonly active: Readonly<Record<string, string>>;
}

const stringArray = (v: unknown): Array<string> =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export const parseLanePulse = (text: string): LanePulse => {
  const raw: unknown = JSON.parse(text);
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const activeRaw = typeof obj.active === "object" && obj.active !== null ? obj.active : {};
  const active: Record<string, string> = {};
  for (const [k, v] of Object.entries(activeRaw)) if (typeof v === "string") active[k] = v;
  return { haiku: stringArray(obj.haiku), opus: stringArray(obj.opus), active };
};

// ---------------------------------------------------------------------------
// LANE-ROSTER.md

export interface RosterService {
  readonly service: string;
  readonly actors: ReadonlyArray<string>;
  readonly thread: string;
  readonly state: string;
}

export interface RosterLane {
  readonly lane: string;
  /** Section 8: started/why. Section 9: retired date or note. */
  readonly started: string;
  readonly owner: string;
  readonly state: string;
  readonly line: number;
}

export interface ParsedRoster {
  readonly services: ReadonlyArray<RosterService>;
  readonly recovered: ReadonlyArray<RosterLane>;
  readonly retired: ReadonlyArray<RosterLane>;
}

const sectionRows = (all: ReadonlyArray<string>, number: number) => {
  const start = all.findIndex((l) => l.startsWith(`## Section ${number}.`));
  if (start === -1) return [];
  const rows: Array<{ cells: Array<string>; line: number }> = [];
  let header = true;
  for (let i = start + 1; i < all.length && !all[i]!.startsWith("## "); i++) {
    const l = all[i]!;
    if (!l.trimStart().startsWith("|")) continue;
    const cells = tableCells(l);
    if (cells.every((c) => /^:?-*:?$/.test(c))) continue;
    if (header) {
      header = false;
      continue;
    }
    rows.push({ cells, line: i + 1 });
  }
  return rows;
};

export const parseLaneRoster = (text: string): ParsedRoster => {
  const all = lines(text);
  return {
    services: sectionRows(all, 1).map(
      ({ cells: [service = "", actors = "", thread = "", state = ""] }) => ({
        service,
        actors: actors
          .split(/[,;]/)
          .map((a) => a.replace(/\(.*?\)/g, "").trim())
          .filter((a) => /^[a-z][a-z0-9-]*$/.test(a)),
        thread,
        state,
      }),
    ),
    recovered: sectionRows(all, 8).map(
      ({ cells: [lane = "", started = "", owner = "", state = ""], line }) => ({
        lane,
        started,
        owner,
        state,
        line,
      }),
    ),
    retired: sectionRows(all, 9).map(({ cells: [lane = "", retired = "", why = ""], line }) => ({
      lane,
      started: retired,
      owner: "",
      state: why,
      line,
    })),
  };
};
