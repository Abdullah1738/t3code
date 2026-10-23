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
  // CSS overflow propagation: the root's overflow applies to the viewport, and when the
  // root leaves it visible the body's does instead (and the body then clips nothing).
  const fromBody = rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible";
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
  // Does this element clip its own content? The root never does (its overflow is the
  // viewport's), nor does a body whose overflow went to the viewport.
  // Overflow does nothing on inline boxes either.
  const clipsOwn = (el, axis) =>
    el !== html && !(el === body && fromBody) && clipped(style(el)[axis]) && !/^(inline|contents|none)$/.test(style(el).display);
  const clips = new Map();
  // Visible region for an element's content: every overflow-clipping ancestor plus the
  // viewport. A clipping element clips its own content at its padding box.
  const clipOf = (el) => {
    if (!el || el === html) return viewport;
    if (clips.has(el)) return clips.get(el);
    let c = clipOf(el.parentElement);
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
  // text-overflow only draws on the block container that clips the line sideways, and
  // the dots are only seen when no outer box cuts that block too.
  const BLOCKISH = /^(block|inline-block|flow-root|list-item|-webkit-box|-webkit-inline-box|table-cell|table-caption)$/;
  const ells = new Map();
  const ellipsisOf = (el) => {
    if (ells.has(el)) return ells.get(el);
    let e = el;
    while (e && e !== html && !clipsOwn(e, "overflowX")) e = e.parentElement;
    const s = e && e !== html ? style(e) : null;
    const ok = !!s && s.textOverflow === "ellipsis" && BLOCKISH.test(s.display) && whole(e);
    ells.set(el, ok);
    return ok;
  };
  // An effective -webkit-line-clamp box (clamp + -webkit-box + clipping), returned only
  // when the clamp box itself is whole on screen, so lines below it were dropped by the
  // clamp (with its ellipsis) and not by the bubble edge.
  const clampsOf = new Map();
  const clampOf = (el) => {
    if (clampsOf.has(el)) return clampsOf.get(el);
    let out = null;
    for (let e = el; e && e !== html; e = e.parentElement) {
      const s = style(e);
      // Chrome 140+ computes a clamped -webkit-box as flow-root (native line-clamp).
      if (/^\d+$/.test(s.webkitLineClamp || "") && /^(-webkit-(inline-)?box|flow-root|block|inline-block)$/.test(s.display) && clipsOwn(e, "overflowY")) {
        if (whole(e)) {
          const r = e.getBoundingClientRect();
          out = { t: round(r.top + e.clientTop), b: round(r.top + e.clientTop + e.clientHeight) };
        }
        break;
      }
    }
    clampsOf.set(el, out);
    return out;
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
