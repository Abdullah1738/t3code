// Pure rules over the geometry measure.mjs returns. No browser, no files: unit tested.

// Messages draws the sender's app icon over the bubble's top-left and rounds the
// bubble's corners (measured from the owner's screenshots, Oct 2026).
export const ICON = { x: 16, y: 16, r: 18 };
export const CORNER = 18;

export const VIEWS = [
  { id: "bubble-iphone", kind: "bubble", w: 275, h: 266, scale: 2 },
  { id: "bubble-ipad", kind: "bubble", w: 345, h: 310, scale: 2 },
  { id: "page-300", kind: "page", w: 300, h: 640, scale: 1 },
  { id: "page-390", kind: "page", w: 390, h: 844, scale: 1, insets: { top: 59, bottom: 34, left: 0, right: 0 } },
];
export const THEMES = ["dark", "light"];

// What each card must show whole. "?sel" = only when the page renders it;
// "bubble:sel" / "page:sel" = only in that kind of view.
export const KEEP = {
  ride: ["h1", ".route li", "?#stale", "?.plate", "?.note"],
  delivery: ["h1", ".status", "?ol.steps", "#freshness", "bubble:?.summary", "?.more", "?.notice", "?.when", "page:?ul.items li"],
  qcard: [".head", "h1", "?.chg"],
  page: ["?h1"],
};

// How far a box reaches into a circle, in px (0 = clear).
const intoCircle = (b, c) => {
  const x = Math.max(b.l, Math.min(c.x, b.r));
  const y = Math.max(b.t, Math.min(c.y, b.b));
  return Math.max(0, c.r - Math.hypot(x - c.x, y - c.y));
};

// Does a box reach into the area a rounded corner masks off? Checks the box corner
// nearest each bubble corner against that corner's arc.
export function inCorner(b, w, h, r = CORNER, slack = 1) {
  const corners = [
    { px: b.l, py: b.t, cx: r, cy: r, sx: -1, sy: -1 },
    { px: b.r, py: b.t, cx: w - r, cy: r, sx: 1, sy: -1 },
    { px: b.l, py: b.b, cx: r, cy: h - r, sx: -1, sy: 1 },
    { px: b.r, py: b.b, cx: w - r, cy: h - r, sx: 1, sy: 1 },
  ];
  return corners.some(({ px, py, cx, cy, sx, sy }) => {
    const dx = (px - cx) * sx;
    const dy = (py - cy) * sy;
    return dx > 0 && dy > 0 && Math.hypot(dx, dy) > r + slack;
  });
}

// Text rects include the font's ascent/descent padding. Judge the glyphs instead:
// cap top to descender, both measured from the rect's middle.
export function ink(x) {
  const mid = (x.t + x.b) / 2;
  const size = x.size || x.b - x.t;
  return { l: x.l, r: x.r, t: mid - 0.36 * size, b: mid + 0.45 * size };
}

// The glyphs left on screen once the clip chain is applied, or null when none are.
export function inkShown(x) {
  if (!x.vis) return null;
  const g = ink(x);
  const t = Math.max(g.t, x.vis.t);
  const b = Math.min(g.b, x.vis.b);
  return b - t > 0.5 ? { l: x.vis.l, r: x.vis.r, t, b } : null;
}

const clipV = (x) => {
  const g = ink(x);
  const s = inkShown(x);
  return s ? g.b - g.t - (s.b - s.t) : 0;
};
const clipH = (x) => (x.vis ? Math.max(0, x.vis.l - x.l) + Math.max(0, x.r - x.vis.r) : 0);

// One finding per element and rule, not one per line box.
function push(out, f) {
  const key = `${f.rule}|${f.sel || ""}|${f.text || ""}`;
  if (out.some((o) => `${o.rule}|${o.sel || ""}|${o.text || ""}` === key)) return;
  out.push(f);
}

export function evaluate(m, view, family = "page") {
  const out = [];
  const bubble = view.kind === "bubble";
  const shown = m.lines.filter((x) => inkShown(x));

  if (m.sw > m.vw + 1) push(out, { rule: "width", level: "FAIL", detail: `scrolls sideways: content ${m.sw}px in a ${m.vw}px view` });

  for (const x of shown) {
    const g = inkShown(x);
    const cut = clipV(x);
    if (cut > Math.max(2, 0.15 * (x.size || 16))) {
      push(out, { rule: "cut", level: "FAIL", detail: `text line cut ${Math.round(cut)}px by the ${bubble ? "bubble" : "card"} edge`, sel: x.sel, text: x.text, box: x });
    }
    if (!x.ell && clipH(x) > 2) {
      push(out, { rule: "slice", level: "FAIL", detail: "text sliced at the side with no ellipsis", sel: x.sel, text: x.text, box: x });
    }
    const under = bubble ? intoCircle(g, ICON) : 0;
    if (under > 0.5) {
      push(out, { rule: "icon", level: "FAIL", detail: `text ${Math.ceil(under)}px under the app icon`, sel: x.sel, text: x.text, box: x });
    }
    if (bubble && inCorner(g, m.vw, m.vh)) {
      push(out, { rule: "corner", level: "FAIL", detail: "text in a rounded corner Messages masks off", sel: x.sel, text: x.text, box: x });
    }
  }

  for (const k of m.keep) {
    if (k.only && k.only !== view.kind) continue;
    const rendered = k.items.filter((i) => i.rendered);
    if (!rendered.length) {
      if (!k.optional) push(out, { rule: "keep", level: "FAIL", detail: `${k.sel} missing`, sel: k.sel });
      continue;
    }
    for (const i of rendered) {
      const lost = i.lines.length ? i.lines.filter((x) => !inkShown(x) || clipV(x) > 1) : i.vis ? [] : [i];
      if (!lost.length) continue;
      // A line clamp that ends in an ellipsis is a chosen shortening, not a crop.
      const clamped = i.lines.length > 0 && lost.every((x) => x.ell);
      push(out, {
        rule: "keep",
        level: clamped ? "WARN" : "FAIL",
        detail: clamped ? `${k.sel} shortened by its line clamp` : `${k.sel} not fully visible`,
        sel: k.sel,
        text: i.text,
        box: i.box,
      });
    }
  }

  // A flex item squeezed to nothing wraps a letter or two per line.
  const byNode = new Map();
  for (const x of m.lines) byNode.set(x.node, [...(byNode.get(x.node) || []), x]);
  for (const group of byNode.values()) {
    if (group.length < 4) continue;
    const widths = group.map((x) => x.r - x.l).sort((a, b) => a - b);
    const median = widths[Math.floor(widths.length / 2)];
    if (median < 1.6 * (group[0].size || 16)) {
      const b = { l: Math.min(...group.map((x) => x.l)), t: Math.min(...group.map((x) => x.t)), r: Math.max(...group.map((x) => x.r)), b: Math.max(...group.map((x) => x.b)) };
      push(out, { rule: "squeeze", level: "FAIL", detail: `text squeezed to ${group.length} narrow lines`, sel: group[0].sel, text: group[0].text, box: b });
    }
  }

  const h1 = m.lines.filter((x) => /(^|> )h1/.test(x.sel) && x.vis && clipH(x) > 2);
  for (const x of h1) push(out, { rule: "headline", level: "WARN", detail: "headline truncated", sel: x.sel, text: x.text, box: x });

  const left = m.main.l;
  const right = m.vw - m.main.r;
  if (Math.abs(left - right) > 1) {
    push(out, { rule: "frame", level: "FAIL", detail: `card off-centre: ${Math.round(left)}px left vs ${Math.round(right)}px right` });
  }

  const ins = view.insets;
  if (!bubble && ins && /viewport-fit\s*=\s*cover/.test(m.meta.viewport || "")) {
    const top = shown.filter((x) => x.vis.t < ins.top - 0.5);
    for (const x of top) push(out, { rule: "safe-area", level: "FAIL", detail: `text under the status bar (top ${Math.round(x.vis.t)}px < ${ins.top}px)`, sel: x.sel, text: x.text, box: x });
    const floor = Math.max(m.sh, m.vh) - ins.bottom;
    const low = shown.filter((x) => x.vis.b > floor + 0.5);
    for (const x of low) push(out, { rule: "safe-area", level: "FAIL", detail: "text under the home indicator at the end of the page", sel: x.sel, text: x.text, box: x });
  }
  return out;
}

// og meta + the image file itself (read by the CLI). Only judged once per case.
export function previewFindings(meta, png) {
  const out = [];
  if (!meta.image) return [{ rule: "preview", level: "FAIL", detail: "no og:image" }];
  if (meta.imageWidth !== "1200" || meta.imageHeight !== "630") {
    out.push({ rule: "preview", level: "FAIL", detail: `og:image size meta ${meta.imageWidth}x${meta.imageHeight}, want 1200x630` });
  }
  if (!meta.title) out.push({ rule: "preview", level: "FAIL", detail: "no og:title" });
  if (!png) out.push({ rule: "preview", level: "FAIL", detail: `preview image missing (${meta.image})` });
  else if (png.w !== 1200 || png.h !== 630) out.push({ rule: "preview", level: "FAIL", detail: `preview image is ${png.w}x${png.h}, want 1200x630` });
  return out;
}

export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
