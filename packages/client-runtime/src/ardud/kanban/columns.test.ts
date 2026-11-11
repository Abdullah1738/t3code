import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_GROUP_COLUMN_WIDTH,
  EMPTY_BOARD_COLUMN_PREFS,
  clampColumnWidth,
  clampGroupWidth,
  resetColumnWidths,
  sanitizeBoardColumnPrefs,
  showAllColumns,
  toggleColumn,
} from "./columns.ts";

describe("sanitizeBoardColumnPrefs", () => {
  it("returns the empty prefs for non-object input", () => {
    expect(sanitizeBoardColumnPrefs(null)).toEqual(EMPTY_BOARD_COLUMN_PREFS);
    expect(sanitizeBoardColumnPrefs("nope")).toEqual(EMPTY_BOARD_COLUMN_PREFS);
    expect(sanitizeBoardColumnPrefs(42)).toEqual(EMPTY_BOARD_COLUMN_PREFS);
  });

  it("drops unknown column keys from widths and hidden", () => {
    const prefs = sanitizeBoardColumnPrefs({
      widths: { todo: 300, bogus: 300 },
      hidden: ["shipped", "bogus", "needs_owner"],
      groupWidth: null,
    });
    expect(prefs.widths).toEqual({ todo: 300 });
    expect(prefs.hidden).toEqual(["shipped", "needs_owner"]);
  });

  it("drops NaN, non-numbers and out-of-range widths", () => {
    const prefs = sanitizeBoardColumnPrefs({
      widths: { todo: Number.NaN, working: "300", needs_review: 9999, in_review: 150 },
      hidden: [],
      groupWidth: null,
    });
    expect(prefs.widths).toEqual({ in_review: 150 });
  });

  it("uses the needs_owner range for needs_owner", () => {
    const prefs = sanitizeBoardColumnPrefs({
      widths: { needs_owner: 150 },
      hidden: [],
      groupWidth: null,
    });
    expect(prefs.widths).toEqual({});
  });

  it("drops duplicate hidden keys and out-of-range group widths", () => {
    const prefs = sanitizeBoardColumnPrefs({
      widths: {},
      hidden: ["todo", "todo"],
      groupWidth: 100,
    });
    expect(prefs.hidden).toEqual(["todo"]);
    expect(prefs.groupWidth).toBeNull();
  });

  it("keeps a valid group width", () => {
    expect(
      sanitizeBoardColumnPrefs({ widths: {}, hidden: [], groupWidth: 320 }).groupWidth,
    ).toBe(320);
  });
});

describe("clampColumnWidth", () => {
  it("clamps stage columns to 140-560", () => {
    expect(clampColumnWidth("todo", 10)).toBe(140);
    expect(clampColumnWidth("todo", 900)).toBe(560);
    expect(clampColumnWidth("todo", 300)).toBe(300);
  });

  it("clamps needs_owner to 200-560", () => {
    expect(clampColumnWidth("needs_owner", 150)).toBe(200);
  });

  it("falls back to the minimum for NaN", () => {
    expect(clampColumnWidth("shipped", Number.NaN)).toBe(140);
  });
});

describe("clampGroupWidth", () => {
  it("clamps to 180-560 and defaults NaN to 256", () => {
    expect(clampGroupWidth(50)).toBe(180);
    expect(clampGroupWidth(900)).toBe(560);
    expect(clampGroupWidth(Number.NaN)).toBe(DEFAULT_GROUP_COLUMN_WIDTH);
  });
});

describe("column prefs transforms", () => {
  const base = {
    widths: { todo: 300, shipped: 200 },
    hidden: ["shipped" as const],
    groupWidth: 320,
  };

  it("toggles a column in and out of hidden", () => {
    const hidden = toggleColumn(base, "todo");
    expect(hidden.hidden).toEqual(["shipped", "todo"]);
    expect(toggleColumn(hidden, "shipped").hidden).toEqual(["todo"]);
  });

  it("show all clears hidden and keeps widths", () => {
    const shown = showAllColumns(base);
    expect(shown.hidden).toEqual([]);
    expect(shown.widths).toEqual(base.widths);
  });

  it("reset widths clears widths and groupWidth but keeps hidden", () => {
    const reset = resetColumnWidths(base);
    expect(reset.widths).toEqual({});
    expect(reset.groupWidth).toBeNull();
    expect(reset.hidden).toEqual(["shipped"]);
  });
});
