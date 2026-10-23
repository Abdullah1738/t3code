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
  // Does this element clip its own content? Overflow does nothing on the root (it is the
  // viewport's), on a body whose overflow went to the viewport, or on inline boxes; paint
  // containment clips any non-inline box, the root included.
  const clipsOwn = (el, axis) => {
    const s = style(el);
    if (/^(inline|contents|none)$/.test(s.display)) return false;
    if (paintContained(s)) return true;
    return el !== html && !(el === body && fromBody) && clipped(s[axis]);
  };
  const clips = new Map();
  // Visible region for an element's content: every clipping ancestor plus the viewport.
  // A clipping element clips its own content at its padding box.
  const clipOf = (el) => {
    if (!el) return viewport;
    if (clips.has(el)) return clips.get(el);
    let c = el === html ? viewport : clipOf(el.parentElement);
    const cx = clipsOwn(el, "overflowX");
    const cy = clipsOwn(el, "overflowY");
    if (c && (cx || cy)) {
      const r = el.getBoundingClientRect();
      const l = r.left + el.clientLeft, t = r.top + el.clientTop;
      c = meet(c, {
        l: cx ? l : -far,
        r: cx ? l + el.clientWidth : far,
        t: cy ? t : -far,
        b: cy ? t + el.clientHeight : far,
      });
    }
    clips.set(el, c);
    return c;
  };
  // Is an element's border box whole inside what its ancestors leave visible?
  const whole = (el) => {
    const r = el.getBoundingClientRect();
    const c = clipOf(el.parentElement);
    return !!c && r.left >= c.l - 0.5 && r.right <= c.r + 0.5 && r.top >= c.t - 0.5 && r.bottom <= c.b + 0.5;
  };
  const shown = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const s = style(e);
      if (s.visibility !== "visible" || +s.opacity === 0) return false;
    }
    return true;
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
  const ellipsisOf = (el) => {
    if (ells.has(el)) return ells.get(el);
    let e = el;
    while (e && e !== html && /^inline$|^contents$/.test(style(e).display)) e = e.parentElement;
    const s = e && e !== html ? style(e) : null;
    const ok = !!s && BLOCKISH.test(s.display) && clipsOwn(e, "overflowX") && s.textOverflow === "ellipsis" && whole(e);
    const edge = ok ? (s.direction === "rtl" ? "l" : "r") : false;
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
        const r = e.getBoundingClientRect();
        out = { t: round(r.top + e.clientTop), b: round(r.top + e.clientTop + free) };
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
      if (!shown(el)) continue;
      range.selectNodeContents(n);
      const clip = clipOf(el);
      const text = n.data.trim().replace(/\s+/g, " ").slice(0, 48);
      const node = ++nodes;
      const size = parseFloat(style(el).fontSize) || 16;
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const b = box(r);
        out.push({ ...b, vis: meet(b, clip), ell: ellipsisOf(el), clamp: clampOf(el), blk: blockOf(el), sel: path(el), text, node, size });
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
