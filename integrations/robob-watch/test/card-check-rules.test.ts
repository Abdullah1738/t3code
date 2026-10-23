import { expect, test } from "bun:test";
import { evaluate, inCorner, ink, previewFindings, VIEWS } from "../helpers/card-check/rules.mjs";

const bubble = VIEWS.find((v) => v.id === "bubble-iphone")!;
const page = VIEWS.find((v) => v.id === "page-390")!;

// A text line box: rect plus what the clip chain leaves of it.
const line = (l: number, t: number, r: number, b: number, extra: Record<string, unknown> = {}) => ({
  l,
  t,
  r,
  b,
  vis: { l, t, r, b },
  size: b - t,
  sel: "main > p",
  text: "text",
  node: Math.random(),
  ...extra,
});

const measure = (over: Record<string, unknown> = {}) => ({
  vw: 275,
  vh: 266,
  sw: 275,
  sh: 266,
  main: { l: 0, t: 0, r: 275, b: 266 },
  lines: [],
  keep: [],
  meta: { viewport: "width=device-width, initial-scale=1, viewport-fit=cover" },
  ...over,
});

const rules = (m: ReturnType<typeof measure>, view = bubble, family = "page") =>
  evaluate(m, view, family).map((f: { rule: string; level: string }) => `${f.level} ${f.rule}`);

test("clean card has no findings", () => {
  expect(rules(measure({ lines: [line(46, 10, 200, 30), line(16, 100, 250, 120)] }))).toEqual([]);
});

test("text under the app icon fails, text beside it passes", () => {
  expect(rules(measure({ lines: [line(10, 8, 120, 28)] }))).toContain("FAIL icon");
  expect(rules(measure({ lines: [line(36, 8, 120, 28)] }))).toEqual([]);
});

test("a line cut by the bubble bottom fails, a hairline of ascent padding does not", () => {
  const cut = line(40, 250, 120, 270, { vis: { l: 40, t: 250, r: 120, b: 262 } });
  expect(rules(measure({ lines: [cut] }))).toContain("FAIL cut");
  // Only the empty ascent area above the glyphs is clipped.
  const pad = line(40, 100, 120, 120, { vis: { l: 40, t: 102, r: 120, b: 120 } });
  expect(rules(measure({ lines: [pad] }))).toEqual([]);
});

test("a side slice fails unless the line ends in an ellipsis", () => {
  const sliced = line(16, 100, 320, 120, { vis: { l: 16, t: 100, r: 259, b: 120 } });
  expect(rules(measure({ lines: [sliced] }))).toContain("FAIL slice");
  expect(rules(measure({ lines: [{ ...sliced, ell: "r" }] }))).toEqual([]);
  // The ellipsis covers one edge only: text lost off the other edge still fails.
  const both = line(-64, 100, 320, 120, { vis: { l: 16, t: 100, r: 259, b: 120 }, ell: "r" });
  expect(rules(measure({ lines: [both] }))).toContain("FAIL slice");
  // Right-to-left text ends on the left, so its ellipsis covers that edge.
  const rtl = line(-64, 100, 259, 120, { vis: { l: 16, t: 100, r: 259, b: 120 }, ell: "l" });
  expect(rules(measure({ lines: [rtl] }))).toEqual([]);
  expect(rules(measure({ lines: [{ ...sliced, ell: "l" }] }))).toContain("FAIL slice");
});

test("text in a masked corner fails", () => {
  expect(rules(measure({ lines: [line(240, 250, 275, 266)] }))).toContain("FAIL corner");
  expect(inCorner({ l: 100, t: 100, r: 150, b: 120 }, 275, 266)).toBe(false);
});

test("sideways scroll and an off-centre card fail", () => {
  expect(rules(measure({ sw: 300 }))).toContain("FAIL width");
  expect(rules(measure({ main: { l: 0, t: 0, r: 260, b: 266 } }))).toContain("FAIL frame");
});

test("keep: missing, hidden and clamped", () => {
  const item = (lines: unknown[], vis = true) => ({ rendered: true, box: {}, vis, lines, text: "Arrives" });
  const hidden = line(16, 280, 200, 300, { vis: null });
  expect(rules(measure({ keep: [{ sel: "h1", items: [] }] }))).toContain("FAIL keep");
  expect(rules(measure({ keep: [{ sel: "?.note", optional: true, items: [] }] }))).toEqual([]);
  expect(rules(measure({ keep: [{ sel: "h1", items: [item([hidden])] }] }))).toContain("FAIL keep");
  // An ellipsis style does not excuse a heading that is gone altogether.
  expect(rules(measure({ keep: [{ sel: "h1", items: [item([{ ...hidden, ell: true }])] }] }))).toContain("FAIL keep");
  // A working clamp: first line shows, the dropped line sits below a clamp box that is whole on screen.
  const clamp = { t: 100, b: 140 };
  const first = line(16, 100, 200, 120, { clamp });
  const dropped = line(16, 140, 200, 160, { clamp, vis: null });
  expect(rules(measure({ keep: [{ sel: "h1", items: [item([first, dropped])] }] }))).toContain("WARN keep");
  // Without a clamp box (or with nothing left on screen) the same loss is a FAIL.
  expect(rules(measure({ keep: [{ sel: "h1", items: [item([{ ...first, clamp: null }, { ...dropped, clamp: null }])] }] }))).toContain("FAIL keep");
  expect(rules(measure({ keep: [{ sel: "h1", items: [item([{ ...first, vis: null }, dropped])] }] }))).toContain("FAIL keep");
  // A required element with no visible text in it (empty, zero-size, transparent) fails; an
  // optional one may be shapes only.
  const blank = { rendered: true, box: { l: 50, t: 60, r: 225, b: 85 }, vis: { l: 50, t: 60, r: 225, b: 85 }, lines: [], text: "Missing headline" };
  expect(rules(measure({ keep: [{ sel: "h1", items: [blank] }] }))).toEqual(["FAIL keep"]);
  expect(rules(measure({ keep: [{ sel: "?ol.steps", optional: true, items: [blank] }] }))).toEqual([]);
  // A bubble-only selector is not judged on the page view.
  const pageSize = { vw: 390, vh: 844, sw: 390, sh: 844, main: { l: 16, t: 0, r: 374, b: 800 } };
  expect(rules(measure({ ...pageSize, keep: [{ sel: ".summary", only: "bubble", items: [] }] }), page)).toEqual([]);
});

test("a flex item squeezed to a word per line fails", () => {
  const node = 7;
  const narrow = [0, 1, 2, 3, 4].map((i) => line(300, 20 + i * 18, 318, 38 + i * 18, { node, size: 14 }));
  expect(rules(measure({ vw: 390, vh: 844, sw: 390, sh: 844, main: { l: 16, t: 0, r: 374, b: 800 }, lines: narrow }), page)).toContain(
    "FAIL squeeze",
  );
});

test("safe area: text under the status bar fails only with viewport-fit=cover", () => {
  const top = line(16, 20, 200, 40);
  const m = measure({ vw: 390, vh: 844, sw: 390, sh: 844, main: { l: 16, t: 0, r: 374, b: 800 }, lines: [top] });
  expect(rules(m, page)).toContain("FAIL safe-area");
  expect(rules({ ...m, meta: { viewport: "width=device-width" } }, page)).toEqual([]);
  // A footer pinned to the screen bottom sits over the home indicator even on a long page;
  // the same line in the flow of a long page is far above the page end.
  const long = { ...m, sh: 1500, lines: [line(50, 826, 200, 844)] };
  expect(rules({ ...long, lines: [line(50, 826, 200, 844, { fixed: true })] }, page)).toContain("FAIL safe-area");
  expect(rules(long, page)).toEqual([]);
});

test("text under a clip shape or mask that can't be measured fails", () => {
  const masked = line(46, 100, 200, 120, { odd: "a mask" });
  expect(rules(measure({ lines: [masked] }))).toContain("FAIL clip");
  const item = { rendered: true, box: {}, vis: true, lines: [masked], text: "Arrives" };
  expect(rules(measure({ keep: [{ sel: "h1", items: [item] }] }))).toContain("FAIL keep");
});

test("ink box sits inside the line rect", () => {
  const g = ink({ l: 0, t: 0, r: 10, b: 20, size: 20 });
  expect(g.t).toBeGreaterThan(0);
  expect(g.b).toBeLessThan(20);
});

test("a page that does not lay out at the view size fails before any other rule", () => {
  expect(rules(measure({ vw: 981, vh: 948, sw: 981, lines: [line(10, 8, 120, 28)] }))).toEqual(["FAIL viewport"]);
  expect(rules(measure({ scale: 0.28 }))).toEqual(["FAIL viewport"]);
});

test("preview checks og meta and the decoded image", () => {
  const meta = { image: "preview.png?v=1", imageWidth: "1200", imageHeight: "630", title: "Uber" };
  expect(previewFindings(meta, { w: 1200, h: 630 })).toEqual([]);
  expect(previewFindings({ ...meta, image: "" }, null)[0].detail).toBe("no og:image");
  expect(previewFindings(meta, { w: 600, h: 315 })[0].detail).toContain("600x315");
  expect(previewFindings(meta, { error: "did not load or decode" })[0].detail).toContain("did not load");
  expect(previewFindings(meta, undefined)[0].detail).toContain("not checked");
  // A remote image gets the same metadata checks.
  const remote = { image: "https://example.invalid/preview.png", title: "" };
  const details = previewFindings(remote, { error: "did not load or decode" }).map((f) => f.detail);
  expect(details.some((d) => d.includes("size meta"))).toBe(true);
  expect(details).toContain("no og:title");
});
