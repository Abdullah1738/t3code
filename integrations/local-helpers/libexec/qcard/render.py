"""qcard templates: spec dict -> (page html, og html, meta).

House style is shared with the delivery card (integrations/app-api-cli/delivery_cards.py in the Robob fork):
one framed sheet on a quiet ground, a full-colour field header, big tabular number,
wells for rows, light + dark, safe-area padding, 300-430px.
"""
import html, math, time, datetime as dt

DUBAI = dt.timezone(dt.timedelta(hours=4))
E = lambda s: html.escape("" if s is None else str(s), quote=True)

CSS = """
:root{--ground:#f4f4f1;--card:#ffffff;--ink:#16160f;--soft:#5d5d55;--well:#ecece6;--up:#0f7b3f;--down:#c0392b;
color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif}
@media (prefers-color-scheme:dark){:root{--ground:#0d0d0b;--card:#1a1a17;--ink:#f3f3ee;--soft:#a6a69c;--well:#26261f;--up:#3ccf7a;--down:#ff6b5b}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--ground);color:var(--ink);min-height:100svh;display:flex;justify-content:center;
padding:max(16px,env(safe-area-inset-top)) 16px calc(env(safe-area-inset-bottom) + 72px);-webkit-font-smoothing:antialiased}
main{width:100%;max-width:420px;align-self:flex-start;background:var(--card);border-radius:28px;overflow:hidden}
.field{background:var(--field);color:var(--field-ink);padding:20px 24px 22px}
.head{display:flex;flex-direction:column;gap:3px;font-size:16px;font-weight:650;line-height:1.25}
.head span{font-size:13px;font-weight:500;opacity:.68}
h1{font-size:64px;line-height:.98;letter-spacing:-.045em;font-weight:700;margin-top:16px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
h1.long{font-size:46px;letter-spacing:-.035em}
h1 small{font-size:.42em;font-weight:600;letter-spacing:-.01em;margin-right:4px}
.chg{font-size:18px;font-weight:600;margin-top:10px;font-variant-numeric:tabular-nums;display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}
.chg b{background:var(--field-ink);color:var(--field);border-radius:999px;padding:3px 10px;font-weight:650}
.chg span{opacity:.75;font-weight:500;font-size:16px}
.tabs{display:flex;gap:6px;padding:18px 20px 0}
.tabs button{flex:1;font:inherit;font-size:15px;font-weight:600;color:var(--ink);background:var(--well);border:0;border-radius:999px;padding:9px 0;
font-variant-numeric:tabular-nums;cursor:pointer;transition:transform .12s}
.tabs button:active{transform:scale(.95)}
.tabs button[aria-pressed=true]{background:var(--ink);color:var(--card)}
.chart{padding:14px 20px 4px}
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.chart .ln{fill:none;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.chart .ar{opacity:.12}
.chart text{font-size:11px;fill:var(--soft);font-variant-numeric:tabular-nums}
.rng{display:none}.rng.on{display:block}.chg.rng.on,.hl.rng.on{display:flex}.hl.rng:not(.on),.chg.rng:not(.on){display:none}
.hl{display:flex;justify-content:space-between;padding:6px 24px 0;font-size:14px;color:var(--soft);font-variant-numeric:tabular-nums}
.hl b{color:var(--ink);font-weight:600}
h2{font-size:17px;font-weight:650;padding:24px 24px 10px;letter-spacing:-.01em}
ul.rows{list-style:none;padding:0 16px}
ul.rows li{display:grid;grid-template-columns:1fr auto;gap:2px 12px;align-items:baseline;padding:11px 12px;border-radius:16px}
ul.rows li:nth-child(odd){background:var(--well)}
.rows .l{font-size:16px;font-weight:600;min-width:0}
.rows .v{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.rows .n{grid-column:1/-1;font-size:13px;color:var(--soft);line-height:1.35}
.rows .v.up{color:var(--up)}.rows .v.down{color:var(--down)}
ul.check li{grid-template-columns:28px 1fr auto}
ul.check .box{width:24px;height:24px;border-radius:8px;background:var(--card);display:grid;place-items:center;align-self:center}
ul.check li:nth-child(even) .box{background:var(--well)}
ul.check li.done .box{background:var(--ink)}
ul.check li.done .box::after{content:"";width:10px;height:5px;border:solid var(--card);border-width:0 0 2.5px 2.5px;transform:translateY(-1px) rotate(-45deg)}
ul.check li.done .l{color:var(--soft);text-decoration:line-through;text-decoration-thickness:1.5px}
ul.check .n{grid-column:2/-1}
.opts{list-style:none;padding:0 16px;display:grid;gap:8px}
.opts li{border-radius:20px;background:var(--well);padding:14px 16px 16px}
.opts li.best{background:var(--field);color:var(--field-ink)}
.opts .top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.opts .nm{font-size:18px;font-weight:700;letter-spacing:-.01em;min-width:0}
.opts .tag{font-size:13px;font-weight:650;background:var(--field-ink);color:var(--field);border-radius:999px;padding:3px 9px;white-space:nowrap}
.opts dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:10px 12px;margin-top:12px}
.opts dt{font-size:12px;opacity:.7;font-weight:500}
.opts dd{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:2px}
.opts .on{font-size:14px;margin-top:10px;line-height:1.4;opacity:.85}
ol.tl{list-style:none;padding:4px 24px 0}
ol.tl li{display:grid;grid-template-columns:14px 1fr;gap:0 14px;position:relative;padding-bottom:18px}
ol.tl li::before{content:"";width:14px;height:14px;border-radius:50%;background:var(--well);margin-top:4px;grid-row:1/4}
ol.tl li::after{content:"";position:absolute;left:5px;top:22px;bottom:2px;width:4px;border-radius:2px;background:var(--well)}
ol.tl li:last-child::after{display:none}
ol.tl li.done::before{background:var(--ink)}
ol.tl li.now::before{background:var(--field);box-shadow:0 0 0 4px var(--ink)}
ol.tl .w{font-size:13px;color:var(--soft);font-weight:600;font-variant-numeric:tabular-nums}
ol.tl .t{font-size:17px;font-weight:600;line-height:1.3;margin-top:1px}
ol.tl li.now .t{font-weight:750}
ol.tl .n{font-size:14px;color:var(--soft);line-height:1.4;margin-top:2px}
.bars{list-style:none;padding:0 24px;display:grid;gap:14px}
.bars .bl{display:flex;justify-content:space-between;gap:12px;font-size:15px;font-weight:600}
.bars .bl span{font-variant-numeric:tabular-nums;white-space:nowrap}
.bars .bl em{font-style:normal;color:var(--soft);font-weight:500;margin-left:6px}
.bars .tr{height:12px;border-radius:6px;background:var(--well);margin-top:6px;overflow:hidden}
.bars .fl{height:100%;border-radius:6px}
.donut{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center;padding:4px 24px 0}
.donut svg{width:150px;height:150px;display:block}
.donut ul{list-style:none;display:grid;gap:9px}
.donut li{display:grid;grid-template-columns:12px 1fr auto;gap:8px;align-items:center;font-size:14px;font-weight:600}
.donut li i{width:12px;height:12px;border-radius:4px}
.donut li span{font-variant-numeric:tabular-nums;color:var(--soft)}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 16px}
.stats div{background:var(--well);border-radius:18px;padding:12px 14px}
.stats b{display:block;font-size:22px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stats span{font-size:13px;color:var(--soft);font-weight:500}
.note{padding:18px 24px 4px;font-size:15px;line-height:1.5;color:var(--soft)}
footer{margin:0 24px;padding:18px 0 22px;font-size:13px;color:var(--soft);display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}
footer span:first-child{min-width:0}footer span+span{white-space:nowrap}
@media (max-width:360px){body{padding-left:8px;padding-right:8px}.field,h2,.note,.hl,.donut{padding-left:18px;padding-right:18px}
.tabs,.chart{padding-left:14px;padding-right:14px}h1{font-size:54px}h1.long{font-size:40px}footer{margin:0 18px}
.donut{grid-template-columns:120px 1fr}.donut svg{width:120px;height:120px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
"""

PALETTE = ["#16160f", "#e0a526", "#2f6fdb", "#d9534f", "#2e9e6a", "#8a5cd6", "#9a9a8e"]
CUR = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "INR": "₹"}


def ink_for(hexcol):
    h = hexcol.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    lum = lambda c: c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4
    L = .2126 * lum(r) + .7152 * lum(g) + .0722 * lum(b)
    return "#16160f" if L > .32 else "#f6f6f1"


def num(v, dec=None):
    if isinstance(v, str):
        return v
    if dec is None:
        dec = 0 if abs(v) >= 1000 else 2 if abs(v) >= 1 else 4
    return f"{v:,.{dec}f}"


def money(v, cur=None, dec=None):
    if isinstance(v, str):
        return v
    s = num(v, dec)
    if not cur:
        return s
    sym = CUR.get(cur)
    return f"{sym}{s}" if sym else f"{cur} {s}"


def local(ts):
    return dt.datetime.fromtimestamp(ts, DUBAI)


def asof_text(ts):
    t, now = local(ts), dt.datetime.now(DUBAI)
    return f"{t:%H:%M}" if t.date() == now.date() else f"{t:%-d %b %H:%M}"


def pct(a, b):
    return (a - b) / b * 100 if b else 0.0


# ---------- charts ----------

def line_svg(points, w=360, h=150, colour="var(--ink)", labels=True, pad=4):
    vs = [p[1] for p in points]
    lo, hi = min(vs), max(vs)
    span = (hi - lo) or abs(hi) * .01 or 1
    n = len(points)
    xs = [pad + (w - 2 * pad) * i / (n - 1) for i in range(n)]
    ys = [pad + (h - 2 * pad) * (1 - (v - lo) / span) for v in vs]
    d = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys))
    area = d + f" L{xs[-1]:.1f},{h} L{xs[0]:.1f},{h} Z"
    out = (f'<svg viewBox="0 0 {w} {h + (18 if labels else 0)}" role="img" aria-label="Price chart">'
           f'<path class="ar" d="{area}" fill="{colour}"/>'
           f'<path class="ln" d="{d}" stroke="{colour}"/>'
           f'<circle cx="{xs[-1]:.1f}" cy="{ys[-1]:.1f}" r="4.5" fill="{colour}"/>')
    if labels:
        span_s = points[-1][0] - points[0][0]
        f = "%H:%M" if span_s < 2 * 86400 else "%-d %b" if span_s < 400 * 86400 else "%b %Y"
        out += (f'<text x="{pad}" y="{h + 15}">{local(points[0][0]).strftime(f)}</text>'
                f'<text x="{w - pad}" y="{h + 15}" text-anchor="end">{local(points[-1][0]).strftime(f)}</text>')
    return out + "</svg>"


def donut_svg(items, size=150, hole=.58):
    tot = sum(i["value"] for i in items) or 1
    r, c = size / 2, size / 2
    rr = r * (1 + hole) / 2
    sw = r * (1 - hole)
    circ = 2 * math.pi * rr
    acc, segs = 0, ""
    for i in items:
        frac = i["value"] / tot
        gap = 2 if len(items) > 1 else 0
        segs += (f'<circle cx="{c}" cy="{c}" r="{rr:.2f}" fill="none" stroke="{i["colour"]}" stroke-width="{sw:.2f}" '
                 f'stroke-dasharray="{max(frac * circ - gap, .1):.2f} {circ:.2f}" stroke-dashoffset="{-acc * circ:.2f}" '
                 f'transform="rotate(-90 {c} {c})"/>')
        acc += frac
    return f'<svg viewBox="0 0 {size} {size}" role="img" aria-label="Breakdown">{segs}</svg>'


# ---------- shared shell ----------

def shell(spec, body, meta, built):
    ver = int(built)
    field = spec.get("accent") or "#feee00"
    fink = spec.get("accent_ink") or ink_for(field)
    src = spec.get("source")
    left = (E(src) + " · " if src else "") + (f'As of {E(asof_text(spec["asof"]))}' if spec.get("asof") else f'Made {local(built):%H:%M}')
    refresh = f'<meta http-equiv="refresh" content="{int(spec["refresh"])}">' if spec.get("refresh") else ""
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
{refresh}<title>{E(meta['title'])}</title>
<meta property="og:title" content="{E(meta['title'])}">
<meta property="og:description" content="{E(meta['description'])}">
<meta property="og:image" content="og.png?v={ver}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<style>:root{{--field:{field};--field-ink:{fink}}}{CSS}</style>
</head><body><main>
{body}
<footer><span>{left}</span><span id="ago" data-t="{int(spec.get('asof') or built)}"></span></footer>
</main>
<script>
document.querySelectorAll('.tabs button').forEach(b=>b.addEventListener('click',()=>{{
document.querySelectorAll('.tabs button').forEach(x=>x.setAttribute('aria-pressed',x===b));
document.querySelectorAll('[data-r]').forEach(x=>x.classList.toggle('on',x.dataset.r===b.dataset.r));}}));
const a=document.getElementById('ago');const m=Math.round((Date.now()/1000-a.dataset.t)/60);
a.textContent=m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':'';
</script>
</body></html>"""


def head(spec, big, chg_html=""):
    long = " long" if len(big) > 9 else ""
    return (f'<section class="field"><div class="head">{E(spec.get("title"))}'
            + (f'<span>{E(spec["sub"])}</span>' if spec.get("sub") else "") + '</div>'
            f'<h1 class="{long.strip()}">{big}</h1>{chg_html}</section>')


def big_value(v, cur=None, unit=None, dec=None):
    s = num(v, dec)
    pre = ""
    if cur:
        sym = CUR.get(cur)
        s = (sym + s) if sym else s
        pre = "" if sym else f"<small>{E(cur)}</small>"
    plain = (CUR.get(cur, "") if cur else "") + num(v, dec) if not isinstance(v, str) else v
    return pre + E(s) + (f"<small> {E(unit)}</small>" if unit else ""), plain


def rows_html(rows, cls="rows"):
    out = ""
    for r in rows:
        tone = f' {r["tone"]}' if r.get("tone") in ("up", "down") else ""
        out += (f'<li><span class="l">{E(r.get("label"))}</span><span class="v{tone}">{E(r.get("value", ""))}</span>'
                + (f'<span class="n">{E(r["note"])}</span>' if r.get("note") else "") + "</li>")
    return f'<ul class="{cls}">{out}</ul>'


# ---------- templates ----------

def t_price(spec):
    rng = spec.get("range", "1M")
    ser = spec["series"]
    cur, dec = spec.get("currency"), spec.get("decimals")
    value = spec["value"]
    tabs, charts, info = "", "", {}
    for r, s in ser.items():
        pts = s["points"]
        base = s.get("prev") or pts[0][1]
        last = value if r == rng or True else pts[-1][1]
        ch = last - base
        p = pct(last, base)
        info[r] = (ch, p, min(x[1] for x in pts), max(x[1] for x in pts))
        colour = "var(--up)" if ch >= 0 else "var(--down)"
        on = " on" if r == rng else ""
        tabs += f'<button type="button" data-r="{r}" aria-pressed="{str(r == rng).lower()}">{r}</button>'
        charts += f'<div class="rng{on}" data-r="{r}">{line_svg(pts + ([[pts[-1][0] + 1, value]] if abs(pts[-1][1] - value) > 1e-9 else []), colour=colour)}</div>'
    chg_spans = ""
    for r, (ch, p, lo, hi) in info.items():
        on = " on" if r == rng else ""
        sign = "+" if ch >= 0 else "−"
        chg_spans += (f'<div class="rng chg{on}" data-r="{r}"><b>{sign}{abs(p):.2f}%</b>'
                      f'<span>{sign}{E(money(abs(ch), cur, dec))} over {r}</span></div>')
    hl = "".join(f'<div class="rng hl{" on" if r == rng else ""}" data-r="{r}"><span>Low <b>{E(money(lo, cur, dec))}</b></span>'
                 f'<span>High <b>{E(money(hi, cur, dec))}</b></span></div>' for r, (ch, p, lo, hi) in info.items())
    bv, plain = big_value(value, cur, None, dec)
    body = head(spec, bv, chg_spans)
    body = body.replace('<div class="rng chg', '<div class="rng chg')
    body += f'<div class="tabs" role="group" aria-label="Range">{tabs}</div><div class="chart">{charts}</div>{hl}'
    if spec.get("rows"):
        body += f'<h2>{E(spec.get("rows_title", "In Dubai"))}</h2>' + rows_html(spec["rows"])
    if spec.get("note"):
        body += f'<p class="note">{E(spec["note"])}</p>'
    ch, p, lo, hi = info.get(rng, next(iter(info.values())))
    sign = "+" if ch >= 0 else "−"
    meta = dict(title=f'{spec["title"]} {plain}', description=f'{sign}{abs(p):.2f}% over {rng}' +
                (" · " + spec["rows"][0]["label"] + " " + spec["rows"][0]["value"] + "/g" if spec.get("rows") and "gram" in spec["rows"][0].get("note", "") else ""),
                caption=spec["title"], subcaption=f"{plain}  {sign}{abs(p):.2f}%")
    pts = ser.get(rng, next(iter(ser.values())))["points"]
    og = og_doc(spec, kicker=f'{spec["title"]} · {rng}', big=plain,
                line=f'{sign}{abs(p):.2f}%  {sign}{money(abs(ch), cur, dec)}', tone="up" if ch >= 0 else "down",
                chart=line_svg(pts, w=1056, h=130, colour="currentColor", labels=False),
                foot=(spec["rows"][0]["label"] + "  " + spec["rows"][0]["value"] + " /g") if spec.get("rows") else spec.get("sub", ""))
    return body, og, meta


def t_stat(spec):
    v = spec["value"]
    bv, plain = big_value(v, spec.get("currency"), spec.get("unit"), spec.get("decimals"))
    chg = ""
    if spec.get("change") is not None:
        c = spec["change"]
        if isinstance(c, (int, float)):
            tone = "up" if c >= 0 else "down"
            ctext = f'{"+" if c >= 0 else "−"}{abs(c):.1f}%'
        else:
            ctext, tone = str(c), spec.get("tone", "")
        chg = f'<div class="chg"><b>{E(ctext)}</b>' + (f'<span>{E(spec["change_note"])}</span>' if spec.get("change_note") else "") + "</div>"
    else:
        ctext = ""
    body = head(spec, bv, chg)
    if spec.get("points"):
        pts = [[i, float(x)] if not isinstance(x, list) else x for i, x in enumerate(spec["points"])]
        body += f'<div class="chart" style="padding-top:22px">{line_svg(pts, labels=False)}</div>'
    if spec.get("stats"):
        body += '<h2>' + E(spec.get("stats_title", "Details")) + '</h2><div class="stats">' + "".join(
            f'<div><b>{E(s["value"])}</b><span>{E(s["label"])}</span></div>' for s in spec["stats"]) + "</div>"
    if spec.get("rows"):
        body += f'<h2>{E(spec.get("rows_title", "Details"))}</h2>' + rows_html(spec["rows"])
    if spec.get("note"):
        body += f'<p class="note">{E(spec["note"])}</p>'
    unit = f' {spec["unit"]}' if spec.get("unit") else ""
    meta = dict(title=f'{spec["title"]}: {plain}{unit}', description=spec.get("summary") or (ctext + (" " + spec.get("change_note", "") if ctext else "")).strip() or spec.get("sub", ""),
                caption=spec["title"], subcaption=f"{plain}{unit}" + (f"  {ctext}" if ctext else ""))
    og = og_doc(spec, kicker=spec["title"], big=plain + unit, line=(ctext + "  " + spec.get("change_note", "")).strip() or spec.get("sub", ""),
                tone=("up" if isinstance(spec.get("change"), (int, float)) and spec["change"] >= 0 else "down" if isinstance(spec.get("change"), (int, float)) else ""),
                chips=[(s["label"], s["value"]) for s in (spec.get("stats") or [])[:3]])
    return body, og, meta


def t_compare(spec):
    opts = spec["options"][:6]
    fields = spec.get("fields") or list(dict.fromkeys(k for o in opts for k in (o.get("values") or {})))
    best = spec.get("best")
    if best is None and spec.get("best_by"):
        key, d = spec["best_by"], spec.get("best_dir", "min")
        vals = [(o.get("values", {}).get(key), i) for i, o in enumerate(opts)]
        nums = [(float(str(v).replace(",", "").split()[-1].lstrip("$€£")) if v is not None else None, i) for v, i in vals]
        nums = [(v, i) for v, i in nums if v is not None]
        if nums:
            best = (min if d == "min" else max)(nums)[1]
    if isinstance(best, str):
        best = next((i for i, o in enumerate(opts) if o["name"] == best), None)
    lis = ""
    for i, o in enumerate(opts):
        b = i == best
        dl = "".join(f'<div><dt>{E(f)}</dt><dd>{E((o.get("values") or {}).get(f, "–"))}</dd></div>' for f in fields)
        lis += (f'<li class="{"best" if b else ""}"><div class="top"><span class="nm">{E(o["name"])}</span>'
                + (f'<span class="tag">{E(spec.get("best_label", "Best pick"))}</span>' if b else "")
                + f'</div><dl>{dl}</dl>' + (f'<p class="on">{E(o["note"])}</p>' if o.get("note") else "") + "</li>")
    win = opts[best] if best is not None else None
    big = E(win["name"]) if win else f"{len(opts)} options"
    sub = spec.get("verdict") or (f'Best of {len(opts)}' if win else "")
    body = (f'<section class="field"><div class="head">{E(spec.get("title"))}' + (f'<span>{E(spec["sub"])}</span>' if spec.get("sub") else "")
            + f'</div><h1 class="{"long" if len(big) > 9 else ""}">{big}</h1>' + (f'<div class="chg"><span>{E(sub)}</span></div>' if sub else "") + "</section>")
    body += f'<h2>{E(spec.get("list_title", "Side by side"))}</h2><ul class="opts">{lis}</ul>'
    if spec.get("note"):
        body += f'<p class="note">{E(spec["note"])}</p>'
    key = fields[0] if fields else None
    chips = [(o["name"], str((o.get("values") or {}).get(spec.get("best_by") or key, ""))) for o in opts[:3]]
    meta = dict(title=f'{spec["title"]}: {win["name"]}' if win else spec["title"], description=sub or f"{len(opts)} options",
                caption=spec["title"], subcaption=(f'{win["name"]} wins' if win else f"{len(opts)} options"))
    og = og_doc(spec, kicker=spec["title"], big=win["name"] if win else f"{len(opts)} options", line=sub, chips=chips, best_chip=best if best is not None and best < 3 else None)
    return body, og, meta


def t_list(spec):
    items = [i if isinstance(i, dict) else {"text": i} for i in spec["items"]]
    check = any("done" in i for i in items) or spec.get("checklist")
    n_done = sum(1 for i in items if i.get("done"))
    lis = ""
    for i in items:
        cls = "done" if i.get("done") else ""
        lis += (f'<li class="{cls}">' + ('<span class="box"></span>' if check else "")
                + f'<span class="l">{E(i["text"])}</span><span class="v">{E(i.get("value", ""))}</span>'
                + (f'<span class="n">{E(i["note"])}</span>' if i.get("note") else "") + "</li>")
    big = f"{n_done} of {len(items)}" if check else str(len(items))
    sub = spec.get("sub") or ("done" if check else "items")
    body = (f'<section class="field"><div class="head">{E(spec.get("title"))}</div>'
            f'<h1>{E(big)}</h1><div class="chg"><span>{E(sub)}</span></div></section>')
    if check:
        body += f'<div class="tabs" style="padding-bottom:4px"><div style="flex:1;height:8px;border-radius:4px;background:var(--well);overflow:hidden"><div style="height:100%;width:{100 * n_done / max(len(items), 1):.0f}%;background:var(--ink);border-radius:4px"></div></div></div>'
    body += f'<h2>{E(spec.get("list_title", "Items"))}</h2><ul class="rows{" check" if check else ""}">{lis}</ul>'
    if spec.get("note"):
        body += f'<p class="note">{E(spec["note"])}</p>'
    nxt = next((i["text"] for i in items if check and not i.get("done")), None)
    meta = dict(title=f'{spec["title"]}: {big} {sub}'.strip(), description=(f"Next: {nxt}" if nxt else ", ".join(i["text"] for i in items[:3])),
                caption=spec["title"], subcaption=f"{big} {sub}")
    og = og_doc(spec, kicker=spec["title"], big=f"{big} {sub}" if check else f"{big} {sub}", line=(f"Next: {nxt}" if nxt else " · ".join(i["text"] for i in items[:3])),
                progress=(n_done / max(len(items), 1)) if check else None)
    return body, og, meta


def t_timeline(spec):
    ev = spec["events"]
    now_i = next((i for i, e in enumerate(ev) if e.get("state") == "now"), None)
    if now_i is None:
        now_i = next((i for i, e in enumerate(ev) if e.get("state") != "done"), len(ev) - 1)
    lis = ""
    for i, e in enumerate(ev):
        st = e.get("state") or ("done" if i < now_i else "now" if i == now_i else "")
        lis += (f'<li class="{st}"><span class="w">{E(e.get("when", ""))}</span><span class="t">{E(e["text"])}</span>'
                + (f'<span class="n">{E(e["note"])}</span>' if e.get("note") else "") + "</li>")
    cur = ev[now_i]
    big = spec.get("big") or cur["text"]
    body = (f'<section class="field"><div class="head">{E(spec.get("title"))}' + (f'<span>{E(spec["sub"])}</span>' if spec.get("sub") else "")
            + f'</div><h1 class="{"long" if len(big) > 9 else ""}">{E(big)}</h1>'
            + (f'<div class="chg"><span>{E(cur.get("when", ""))}</span></div>' if cur.get("when") and not spec.get("big") else "")
            + f'</section><h2>{E(spec.get("list_title", "Timeline"))}</h2><ol class="tl">{lis}</ol>')
    if spec.get("note"):
        body += f'<p class="note">{E(spec["note"])}</p>'
    nxt = ev[now_i + 1]["text"] if now_i + 1 < len(ev) else None
    meta = dict(title=f'{spec["title"]}: {big}', description=f"Then: {nxt}" if nxt else f"Step {now_i + 1} of {len(ev)}",
                caption=spec["title"], subcaption=big)
    og = og_doc(spec, kicker=spec["title"], big=big, line=(f"Then: {nxt}" if nxt else ""), progress=(now_i + 1) / len(ev), steps=len(ev), step=now_i)
    return body, og, meta


def t_breakdown(spec):
    items = sorted(spec["items"], key=lambda i: -float(i["value"])) if spec.get("sort", True) else spec["items"]
    for k, i in enumerate(items):
        i["value"] = float(i["value"])
        i["colour"] = i.get("colour") or (spec.get("accent") if k == 0 and spec.get("accent") and ink_for(spec["accent"]) == "#16160f" and False else PALETTE[k % len(PALETTE)])
    tot = spec.get("total") if spec.get("total") is not None else sum(i["value"] for i in items)
    cur, unit, dec = spec.get("currency"), spec.get("unit"), spec.get("decimals")
    fmt = lambda v: money(v, cur, dec) + (f" {unit}" if unit else "")
    bv, plain = big_value(tot, cur, unit, dec)
    body = head(spec, bv, f'<div class="chg"><span>{E(spec.get("total_label", "Total"))}</span></div>')
    body += f'<h2>{E(spec.get("list_title", "Breakdown"))}</h2>'
    top = max(i["value"] for i in items) or 1
    sm = sum(i["value"] for i in items) or 1
    if spec.get("kind", "bar") == "donut":
        lg = "".join(f'<li><i style="background:{i["colour"]}"></i>{E(i["label"])}<span>{100 * i["value"] / sm:.0f}%</span></li>' for i in items)
        body += f'<div class="donut">{donut_svg(items)}<ul>{lg}</ul></div>'
    else:
        body += '<ul class="bars">' + "".join(
            f'<li><div class="bl">{E(i["label"])}<span>{E(fmt(i["value"]))}<em>{100 * i["value"] / sm:.0f}%</em></span></div>'
            f'<div class="tr"><div class="fl" style="width:{100 * i["value"] / top:.1f}%;background:{i["colour"]}"></div></div></li>' for i in items) + "</ul>"
    if spec.get("note"):
        body += f'<p class="note">{E(spec["note"])}</p>'
    t0 = items[0]
    meta = dict(title=f'{spec["title"]}: {fmt(tot)}', description=f'{t0["label"]} {100 * t0["value"] / sm:.0f}%' + (f', {items[1]["label"]} {100 * items[1]["value"] / sm:.0f}%' if len(items) > 1 else ""),
                caption=spec["title"], subcaption=f'{fmt(tot)} · {t0["label"]} {100 * t0["value"] / sm:.0f}%')
    og = og_doc(spec, kicker=spec["title"], big=plain + (f" {unit}" if unit else ""), line=meta["description"], segments=[(i["label"], i["value"] / sm, i["colour"]) for i in items])
    return body, og, meta


TEMPLATES = {"price": t_price, "stat": t_stat, "compare": t_compare, "list": t_list, "timeline": t_timeline, "breakdown": t_breakdown}


# ---------- og image ----------

def og_doc(spec, *, kicker, big, line="", tone="", chart="", chips=(), foot="", progress=None, segments=None, best_chip=None, steps=None, step=None):
    field = spec.get("accent") or "#feee00"
    ink = spec.get("accent_ink") or ink_for(field)
    n = len(big)
    size = (168 if chart else 200) if n <= 7 else 168 if n <= 9 else 136 if n <= 12 else 108 if n <= 16 else 86
    tone_bg = {"up": "#0f7b3f", "down": "#c0392b"}.get(tone)
    line_html = ""
    if line:
        if tone_bg:
            a, _, b = line.partition("  ")
            line_html = f'<div class="l"><b style="background:{tone_bg};color:#fff">{E(a)}</b>{E(b)}</div>'
        else:
            line_html = f'<div class="l">{E(line)}</div>'
    extra = ""
    if chart:
        extra = f'<div class="ch">{chart}</div>'
    elif chips:
        extra = '<div class="chips">' + "".join(
            f'<div class="chip{" best" if k == best_chip else ""}"><b>{E(v)}</b><span>{E(l)}</span></div>' for k, (l, v) in enumerate(list(chips)[:3])) + "</div>"
    elif segments:
        extra = '<div class="seg">' + "".join(f'<i style="flex:{max(f, .01):.4f};background:{c}"></i>' for _, f, c in segments) + "</div>"
    elif steps:
        extra = '<div class="steps">' + "".join(f'<i class="{"on" if k <= step else ""}"></i>' for k in range(steps)) + "</div>"
    elif progress is not None:
        extra = f'<div class="pg"><i style="width:{progress * 100:.1f}%"></i></div>'
    chip_size = 60 if max([len(str(v)) for _, v in chips] or [0]) <= 7 else 44
    footer = f'<div class="f">{E(foot)}</div>' if foot else ""
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
*{{box-sizing:border-box;margin:0}}
html,body{{width:1200px;height:630px;overflow:hidden}}
body{{background:{field};color:{ink};font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif;
padding:54px 72px 52px;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}}
.k{{font-size:46px;font-weight:650;letter-spacing:-.01em;opacity:.78;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.b{{font-size:{size}px;font-weight:760;letter-spacing:-.045em;line-height:1.02;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;padding-bottom:.04em}}
.l{{font-size:50px;font-weight:620;margin-top:14px;display:flex;gap:22px;align-items:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;letter-spacing:-.015em}}
.l b{{border-radius:999px;padding:4px 24px 6px;font-weight:720}}
.ch{{margin-top:auto;height:130px;color:{ink}}}
.ch svg{{width:100%;height:130px;display:block;overflow:visible}}
.ch .ln{{fill:none;stroke-width:9;stroke-linejoin:round;stroke-linecap:round}}
.ch .ar{{opacity:.14}}
.chips{{display:flex;gap:18px;margin-top:auto}}
.chip{{flex:1;min-width:0;border-radius:26px;padding:20px 26px;background:{ink};color:{field}}}
.chip.best{{outline:8px solid {ink};outline-offset:-8px;background:transparent;color:{ink}}}
.chip b{{display:block;font-size:{chip_size}px;line-height:1.05;font-weight:760;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;letter-spacing:-.02em}}
.chip span{{display:block;font-size:32px;font-weight:600;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.8}}
.seg,.pg,.steps{{margin-top:auto;height:64px;display:flex;gap:10px}}
.seg i{{display:block;border-radius:16px;min-width:16px}}
.pg{{background:{ink}22;border-radius:32px;overflow:hidden;display:block}}
.pg i{{display:block;height:100%;background:{ink};border-radius:32px}}
.steps i{{flex:1;border-radius:16px;background:{ink}2a}}.steps i.on{{background:{ink}}}
.f{{font-size:36px;font-weight:600;margin-top:22px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}}
</style></head><body>
<div class="k">{E(kicker)}</div><div class="b">{E(big)}</div>{line_html}{extra}{footer}
</body></html>"""


def build(spec, built=None):
    built = built or time.time()
    body, og, meta = TEMPLATES[spec["template"]](spec)
    return shell(spec, body, meta, built), og, meta
