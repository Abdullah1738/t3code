// Runs inside the card page (serialised with toString). Returns raw geometry only; every
// judgement lives in rules.mjs so it can be tested without a browser.
export function measure(opts) {
  const vw = innerWidth;
  const vh = innerHeight;
  const scale = window.visualViewport ? visualViewport.scale : 1;
  const round = (n) => Math.round(n * 10) / 10;
  const box = (r) => ({ l: round(r.left), t: round(r.top), r: round(r.right), b: round(r.bottom) });
  const meet = (a, b) => {
    if (!a || !b) return null;
    const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bt = Math.min(a.b, b.b);
    return r - l > 0.2 && bt - t > 0.2 ? { l, t, r, b: bt } : null;
  };
  const clipped = (v) => v !== "visible";
  const html = document.documentElement;
  const body = document.body;
  const root = document.scrollingElement || html;
  const rootStyle = getComputedStyle(html);
  const bodyStyle = getComputedStyle(body);
  // Any containment (contain, container-type, content-visibility) on the root or the body
  // stops the body's overflow from moving to the viewport (checked in Chrome 154).
  const contained = (s) => s.contain !== "none" || (s.containerType || "normal") !== "normal" || (s.contentVisibility || "visible") !== "visible";
  // Paint containment clips an element's content at its box whatever its overflow says.
  const paintContained = (s) => /paint|strict|content/.test(s.contain) || /^(auto|hidden)$/.test(s.contentVisibility || "visible");
  // CSS overflow propagation: the root's overflow applies to the viewport, and when the
  // root leaves it visible the body's does instead (and the body then clips nothing).
  const fromBody =
    rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible" && bodyStyle.display !== "none" && !contained(rootStyle) && !contained(bodyStyle);
  const vpY = (fromBody ? bodyStyle : rootStyle).overflowY;
  // In the Messages bubble nothing scrolls. On a page the document scrolls unless the
  // viewport's overflow turns that off.
  const pinned = opts.bubble || vpY === "hidden" || vpY === "clip";
  const far = 1e6;
  const viewport = pinned ? { l: 0, t: 0, r: vw, b: vh } : { l: 0, t: -far, r: vw, b: far };
  const styles = new Map();
  const style = (el) => {
    let s = styles.get(el);
    if (!s) styles.set(el, (s = getComputedStyle(el)));
    return s;
  };
  const px = (v) => parseFloat(v) || 0;
  // How much bigger an element is drawn than laid out (transforms, scale, zoom), from its
  // nearest box: drawn size over layout size. Font sizes and border widths are layout px.
  const scales = new Map();
  const scaleOf = (el) => {
    let e = el;
    while (e && e !== html && (/^(inline|contents)$/.test(style(e).display) || !e.offsetWidth || !e.offsetHeight)) e = e.parentElement;
    if (!e) return { x: 1, y: 1 };
    if (!scales.has(e)) {
      const r = e.getBoundingClientRect();
      scales.set(e, { x: e.offsetWidth ? r.width / e.offsetWidth : 1, y: e.offsetHeight ? r.height / e.offsetHeight : 1 });
    }
    return scales.get(e);
  };
  // Does this element clip its own content? Overflow does nothing on the root (it is the
  // viewport's), on a body whose overflow went to the viewport, or on inline boxes; paint
  // containment clips any non-inline box, the root included.
  const clipsOwn = (el, axis) => {
    const s = style(el);
    if (/^(inline|contents|none)$/.test(s.display)) return false;
    if (paintContained(s)) return true;
    return el !== html && !(el === body && fromBody) && clipped(s[axis]);
  };
  // An element's padding box on screen. From the border widths, not clientWidth/Height,
  // which on the root report the viewport instead of the root's own box.
  const padBox = (el) => {
    const s = style(el);
    const r = el.getBoundingClientRect();
    const k = scaleOf(el);
    return { l: r.left + px(s.borderLeftWidth) * k.x, t: r.top + px(s.borderTopWidth) * k.y, r: r.right - px(s.borderRightWidth) * k.x, b: r.bottom - px(s.borderBottomWidth) * k.y };
  };
  // clip-path inset() and the legacy clip rect cut an element and everything in it. Other
  // clip-path shapes and masks can't be measured here: odd() names them so the rules fail
  // the text under them instead of trusting it.
  const oddOf = (s) =>
    (s.clipPath !== "none" && !/^inset\([^)]*\)( border-box)?$/.test(s.clipPath) && `clip-path ${s.clipPath}`) ||
    ((s.maskImage || s.webkitMaskImage || "none") !== "none" && "a mask") ||
    null;
  const shapeOf = (el) => {
    const s = style(el);
    const r = el.getBoundingClientRect();
    const k = scaleOf(el);
    let c = { l: -far, t: -far, r: far, b: far };
    const inset = /^inset\(([^)]*)\)/.exec(s.clipPath);
    if (inset) {
      const v = inset[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
      const [t, rt = t, b = t, l = rt] = v;
      const len = (x, total, kk) => (x.endsWith("%") ? (parseFloat(x) / 100) * total : parseFloat(x) * kk);
      c = { l: r.left + len(l, r.width, k.x), t: r.top + len(t, r.height, k.y), r: r.right - len(rt, r.width, k.x), b: r.bottom - len(b, r.height, k.y) };
      if (Object.values(c).some(Number.isNaN)) return null;
    }
    const rect = /^rect\((.*)\)$/.exec(s.clip || "");
    if (rect && /^(absolute|fixed)$/.test(s.position)) {
      const [t, rt, b, l] = rect[1].split(/[\s,]+/).filter(Boolean);
      const at = (x, auto, base, kk) => (x === "auto" || x === undefined ? auto : base + parseFloat(x) * kk);
      c = meet(c, { t: at(t, r.top, r.top, k.y), r: at(rt, r.right, r.left, k.x), b: at(b, r.bottom, r.top, k.y), l: at(l, r.left, r.left, k.x) });
    }
    return c;
  };
  // What makes an element the containing block of its fixed (and absolute) descendants.
  const holdsFixed = (s) =>
    s.transform !== "none" ||
    (s.translate || "none") !== "none" ||
    (s.rotate || "none") !== "none" ||
    (s.scale || "none") !== "none" ||
    s.perspective !== "none" ||
    s.filter !== "none" ||
    (s.backdropFilter || "none") !== "none" ||
    /paint|layout|strict|content/.test(s.contain) ||
    (s.containerType || "normal") !== "normal" ||
    /transform|perspective|filter/.test(s.willChange) ||
    /^(auto|hidden)$/.test(s.contentVisibility || "visible");
  // Positioned boxes are clipped by their containing block's chain, not their parent's:
  // overflow on an ancestor in between does not cut them. undefined = the viewport.
  const cbs = new Map();
  const cbOf = (el) => {
    if (cbs.has(el)) return cbs.get(el);
    const pos = style(el).position;
    let a = el.parentElement;
    if (pos === "absolute" || pos === "fixed") {
      while (a && !(pos === "absolute" && style(a).position !== "static") && !holdsFixed(style(a))) a = a.parentElement;
    }
    cbs.set(el, a || undefined);
    return a || undefined;
  };
  const screen = { l: 0, t: 0, r: vw, b: vh };
  // What an element's box is subject to from outside it. clip-path and clip on boxes
  // between it and its containing block still cut it.
  const clipFor = (el) => {
    if (el === html) return viewport;
    const a = cbOf(el);
    let c = a ? clipOf(a) : style(el).position === "fixed" ? screen : viewport;
    for (let e = el.parentElement; c && e && e !== a; e = e.parentElement) {
      const s = style(e);
      if (s.clipPath === "none" && (s.clip || "auto") === "auto") continue;
      const shape = shapeOf(e);
      if (shape) c = meet(c, shape);
    }
    return c;
  };
  // Pinned to the screen: fixed with no containing block in between.
  const fixedOf = (el) => {
    for (let e = el; e && e !== html; e = cbOf(e) || null) if (style(e).position === "fixed" && !cbOf(e)) return true;
    return false;
  };
  const odds = new Map();
  const oddIn = (el) => {
    if (!el) return null;
    if (!odds.has(el)) odds.set(el, oddOf(style(el)) || oddIn(el.parentElement));
    return odds.get(el);
  };
  const clips = new Map();
  // Visible region for an element's content: every clipping box it is subject to plus the
  // viewport. A clipping element clips its own content at its padding box (plus any
  // overflow-clip-margin when it uses overflow: clip).
  const clipOf = (el) => {
    if (!el) return viewport;
    if (clips.has(el)) return clips.get(el);
    let c = clipFor(el);
    const s = style(el);
    const cx = clipsOwn(el, "overflowX");
    const cy = clipsOwn(el, "overflowY");
    if (c && (cx || cy)) {
      const p = padBox(el);
      const k = scaleOf(el);
      const margin = px(String(s.overflowClipMargin || "").replace(/^[a-z-]+\s*/, ""));
      const mx = s.overflowX === "clip" && !paintContained(s) ? margin * k.x : 0;
      const my = s.overflowY === "clip" && !paintContained(s) ? margin * k.y : 0;
      c = meet(c, { l: cx ? p.l - mx : -far, r: cx ? p.r + mx : far, t: cy ? p.t - my : -far, b: cy ? p.b + my : far });
    }
    if (c && (s.clipPath !== "none" || (s.clip || "auto") !== "auto")) {
      const shape = shapeOf(el);
      if (shape) c = meet(c, shape);
    }
    clips.set(el, c);
    return c;
  };
  // Is an element's border box whole inside what it is subject to?
  const whole = (el) => {
    const r = el.getBoundingClientRect();
    const c = clipFor(el);
    return !!c && r.left >= c.l - 0.5 && r.right <= c.r + 0.5 && r.top >= c.t - 0.5 && r.bottom <= c.b + 0.5;
  };
  // visibility inherits (a visible child of a hidden box shows), opacity multiplies.
  const shown = (el) => {
    if (style(el).visibility !== "visible") return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (+style(e).opacity === 0) return false;
    return true;
  };
  const alpha = (c) => {
    if (!c || c === "transparent") return 0;
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c);
    if (slash) return parseFloat(slash[1]) * (slash[2] ? 0.01 : 1);
    const rgba = /^rgba\(([^)]*)\)$/.exec(c);
    return rgba ? parseFloat(rgba[1].split(",")[3] ?? "1") : 1;
  };
  // Is text in this element drawn in some ink a person can see? A transparent fill counts
  // only with a stroke, a shadow or a background clipped to the text behind it.
  const inked = (el) => {
    const s = style(el);
    if (alpha(s.webkitTextFillColor || s.color) > 0.05) return true;
    if (px(s.webkitTextStrokeWidth) > 0 && alpha(s.webkitTextStrokeColor) > 0.05) return true;
    if (s.textShadow && s.textShadow !== "none") return true;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const t = style(e);
      if (t.backgroundClip === "text" || t.webkitBackgroundClip === "text") return true;
    }
    return false;
  };
  const blocks = new Map();
  const blockOf = (el) => {
    let e = el;
    while (e && e !== body && /^inline/.test(style(e).display) && style(e).display !== "inline-block") e = e.parentElement;
    if (!blocks.has(e)) blocks.set(e, blocks.size);
    return blocks.get(e);
  };
  // text-overflow draws only on the block container that lays the line out (the nearest
  // non-inline ancestor), only when that block clips sideways, only at its end edge, and
  // the dots are only seen when no outer box cuts that block too. Returns the edge the
  // ellipsis covers ("r" or "l") or false.
  const BLOCKISH = /^(block|inline-block|flow-root|list-item|-webkit-box|-webkit-inline-box|table-cell|table-caption)$/;
  const ells = new Map();
  const pen = document.createElement("canvas").getContext("2d");
  // The line's first letter is never swapped for the dots (Chrome 154), so a block too
  // narrow for that letter plus "…" shows a sliced letter and no ellipsis at all.
  const ellipsisOf = (el) => {
    if (ells.has(el)) return ells.get(el);
    let e = el;
    while (e && e !== html && /^inline$|^contents$/.test(style(e).display)) e = e.parentElement;
    const s = e && e !== html ? style(e) : null;
    let edge = false;
    if (s && BLOCKISH.test(s.display) && clipsOwn(e, "overflowX") && s.textOverflow === "ellipsis" && whole(e)) {
      pen.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const first = [...(e.textContent || "").trim()][0] || "";
      const need = pen.measureText(first + "\u2026").width;
      const room = e.clientWidth - px(s.paddingLeft) - px(s.paddingRight) - Math.abs(px(s.textIndent));
      if (room >= need - 0.5) edge = s.direction === "rtl" ? "l" : "r";
    }
    ells.set(el, edge);
    return edge;
  };
  // A line clamp that really shortens its box. Computed style can't prove it (Chrome 154
  // computes both a working -webkit-box clamp and an inert flow-root one as flow-root), so
  // lay the box out again without height limits, with and then without the clamp: the
  // clamp works when it alone makes the box shorter, and its edge is that height. A
  // height crop above that edge is a crop. Only returned when the box is whole on screen.
  const clamps = new Map();
  const clampBox = (e) => {
    if (clamps.has(e)) return clamps.get(e);
    let out = null;
    if (whole(e)) {
      const old = e.getAttribute("style");
      const set = (k, v) => e.style.setProperty(k, v, "important");
      set("height", "auto");
      set("max-height", "none");
      set("min-height", "0");
      set("flex", "0 0 auto");
      const free = e.clientHeight;
      set("-webkit-line-clamp", "none");
      const full = e.clientHeight;
      if (old === null) e.removeAttribute("style");
      else e.setAttribute("style", old);
      if (free < full - 0.5) {
        const t = padBox(e).t;
        out = { t: round(t), b: round(t + free * scaleOf(e).y) };
      }
    }
    clamps.set(e, out);
    return out;
  };
  const clampOf = (el) => {
    for (let e = el; e && e !== html; e = e.parentElement) {
      if (/^\d+$/.test(style(e).webkitLineClamp || "")) return clampBox(e);
    }
    return null;
  };
  const path = (el) => {
    const bits = [];
    for (let e = el; e && e !== body && bits.length < 3; e = e.parentElement) {
      bits.unshift(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.classList.length ? "." + [...e.classList].join(".") : ""));
    }
    return bits.join(" > ");
  };

  let nodes = 0;
  const linesOf = (scope) => {
    const out = [];
    const walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName) || !n.data.trim()) continue;
      // Text nobody can see (hidden, transparent, zero-size) is not a line at all, so a
      // required element made only of it has nothing to show.
      if (!shown(el) || !inked(el)) continue;
      range.selectNodeContents(n);
      const clip = clipOf(el);
      const text = n.data.trim().replace(/\s+/g, " ").slice(0, 48);
      const node = ++nodes;
      // Drawn size: the rects are post-transform, so the font size has to be too.
      const size = round(px(style(el).fontSize) * scaleOf(el).y);
      if (size < 1) continue;
      const odd = oddIn(el);
      const fixed = fixedOf(el);
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const b = box(r);
        out.push({ ...b, vis: meet(b, clip), ell: ellipsisOf(el), clamp: clampOf(el), blk: blockOf(el), sel: path(el), text, node, size, ...(odd && { odd }), ...(fixed && { fixed }) });
      }
    }
    return out;
  };

  const keep = (opts.keep || []).map((spec) => {
    const scoped = /^(bubble|page):/.exec(spec);
    const only = scoped ? scoped[1] : null;
    const raw = scoped ? spec.slice(scoped[0].length) : spec;
    const optional = raw.startsWith("?");
    const sel = optional ? raw.slice(1) : raw;
    const items = [...document.querySelectorAll(sel)].map((el) => {
      const rendered = el.getClientRects().length > 0 && shown(el);
      const own = box(el.getBoundingClientRect());
      return {
        rendered,
        box: own,
        vis: rendered ? meet(own, clipOf(el)) : null,
        lines: rendered ? linesOf(el) : [],
        text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48),
      };
    });
    return { sel, optional, only, items };
  });

  const main = document.querySelector("main") || body.firstElementChild || body;
  const meta = (p) => document.querySelector(`meta[property="${p}"],meta[name="${p}"]`)?.getAttribute("content") ?? null;
  return {
    vw,
    vh,
    scale,
    sw: root.scrollWidth,
    sh: root.scrollHeight,
    pinned,
    main: box(main.getBoundingClientRect()),
    lines: linesOf(document.body),
    keep,
    meta: {
      viewport: meta("viewport"),
      title: meta("og:title"),
      image: meta("og:image"),
      imageWidth: meta("og:image:width"),
      imageHeight: meta("og:image:height"),
    },
  };
}
