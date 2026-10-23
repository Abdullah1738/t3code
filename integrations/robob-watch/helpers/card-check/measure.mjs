// Runs inside the card page (serialised with toString). Returns raw geometry only; every
// judgement lives in rules.mjs so it can be tested without a browser.
export function measure(opts) {
  const vw = innerWidth;
  const vh = innerHeight;
  const round = (n) => Math.round(n * 10) / 10;
  const box = (r) => ({ l: round(r.left), t: round(r.top), r: round(r.right), b: round(r.bottom) });
  const meet = (a, b) => {
    if (!a || !b) return null;
    const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bt = Math.min(a.b, b.b);
    return r - l > 0.2 && bt - t > 0.2 ? { l, t, r, b: bt } : null;
  };
  const clipped = (v) => v !== "visible";
  const root = document.scrollingElement || document.documentElement;
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = getComputedStyle(document.body);
  // In the Messages bubble nothing scrolls. On a page the document scrolls unless the
  // page itself turns that off.
  const pinned = opts.bubble || [rootStyle.overflowY, bodyStyle.overflowY].some((v) => v === "hidden" || v === "clip");
  const far = 1e6;
  const viewport = pinned ? { l: 0, t: 0, r: vw, b: vh } : { l: 0, t: -far, r: vw, b: far };
  const styles = new Map();
  const style = (el) => {
    let s = styles.get(el);
    if (!s) styles.set(el, (s = getComputedStyle(el)));
    return s;
  };
  const clips = new Map();
  // Visible region for an element's content: every overflow-clipping ancestor plus the
  // viewport. A clipping element clips its own content at its padding box.
  const clipOf = (el) => {
    if (!el || el === document.documentElement || el === document.body) return viewport;
    if (clips.has(el)) return clips.get(el);
    let c = clipOf(el.parentElement);
    const s = style(el);
    if (c && (clipped(s.overflowX) || clipped(s.overflowY))) {
      const r = el.getBoundingClientRect();
      const l = r.left + el.clientLeft, t = r.top + el.clientTop;
      const own = {
        l: clipped(s.overflowX) ? l : -far,
        r: clipped(s.overflowX) ? l + el.clientWidth : far,
        t: clipped(s.overflowY) ? t : -far,
        b: clipped(s.overflowY) ? t + el.clientHeight : far,
      };
      c = meet(c, own);
    }
    clips.set(el, c);
    return c;
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
    while (e && e !== document.body && /^inline/.test(style(e).display) && style(e).display !== "inline-block") e = e.parentElement;
    if (!blocks.has(e)) blocks.set(e, blocks.size);
    return blocks.get(e);
  };
  const ellipsisOf = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = style(e);
      if (s.textOverflow === "ellipsis" || (s.webkitLineClamp && s.webkitLineClamp !== "none")) return true;
      if (clipped(s.overflowX)) return false;
    }
    return false;
  };
  const path = (el) => {
    const bits = [];
    for (let e = el; e && e !== document.body && bits.length < 3; e = e.parentElement) {
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
        out.push({ ...b, vis: meet(b, clip), ell: ellipsisOf(el), blk: blockOf(el), sel: path(el), text, node, size });
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

  const main = document.querySelector("main") || document.body.firstElementChild || document.body;
  const meta = (p) => document.querySelector(`meta[property="${p}"],meta[name="${p}"]`)?.getAttribute("content") ?? null;
  return {
    vw,
    vh,
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
