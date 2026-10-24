"""Shared preview helpers for Robob app cards (iMessage).

The chat bubble shows og:image + og:title/og:description, so every recurring card
renders a 1200x630 image with one big state/number that reads at ~300px wide.

    import sys; sys.path.insert(0, os.path.expanduser("~/.local/libexec/card-preview"))
    import cardpreview as cp
    cp.og_image(out_png, kicker="Board", big="1 working", line="2 waiting on others", ...)
    head = cp.og_meta(title, description, "preview.png", version)

Rendering uses the headless Chrome shell (real system fonts, no PIL font guessing).
"""
import html, os, subprocess, tempfile, time

CHROME = os.path.expanduser(
    "~/Library/Caches/ms-playwright/chromium_headless_shell-1223/"
    "chrome-headless-shell-mac-arm64/chrome-headless-shell")
FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif'


def esc(s):
    return html.escape("" if s is None else str(s), quote=True)


def og_meta(title, description, image, version=None):
    """<meta> block for <head>; image is relative to the page (the bridge makes it absolute)."""
    src = f"{image}?v={version}" if version is not None else image
    return (f'<meta property="og:title" content="{esc(title)}">'
            f'<meta property="og:description" content="{esc(description)}">'
            f'<meta property="og:image" content="{esc(src)}">'
            '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'
            '<meta name="twitter:card" content="summary_large_image">')


def screenshot(src, out, width, height, timeout=40):
    """Screenshot a URL/file path at width x height (viewport, not full page)."""
    if not src.startswith(("http://", "https://", "file://")):
        src = "file://" + os.path.abspath(src)
    with tempfile.TemporaryDirectory() as prof:
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                        f"--user-data-dir={prof}", "--force-device-scale-factor=1",
                        "--virtual-time-budget=1500", f"--window-size={width},{height}",
                        f"--screenshot={os.path.abspath(out)}", src],
                       check=True, capture_output=True, timeout=timeout)
    return out


def render_html(doc, out, width=1200, height=630):
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(doc)
        tmp = f.name
    try:
        tmp_out = out + ".tmp.png"
        screenshot(tmp, tmp_out, width, height)
        os.replace(tmp_out, out)
    finally:
        os.unlink(tmp)
    return out


def og_image(out, *, kicker, big, line="", foot="", ground="#0f1115", ink="#f4f5f7",
             accent=None, soft=None, big_size=None, chips=()):
    """One-state 1200x630 card: small kicker, huge state, one supporting line, optional chips/foot.

    chips: up to 4 (label, value, colour) tuples shown as big tiles under the line.
    """
    soft = soft or ink
    accent = accent or ink
    n = len(str(big))
    size = big_size or (210 if n <= 6 else 170 if n <= 9 else 132 if n <= 13 else 104)
    chip_html = "".join(
        f'<div class="chip" style="background:{esc(c)}"><b>{esc(v)}</b><span>{esc(l)}</span></div>'
        for l, v, c in list(chips)[:4])
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><style>
*{{box-sizing:border-box;margin:0}}
html,body{{width:1200px;height:630px;overflow:hidden}}
body{{background:{ground};color:{ink};font-family:{FONT};padding:58px 72px 54px;display:flex;flex-direction:column;
-webkit-font-smoothing:antialiased}}
.k{{font-size:44px;font-weight:650;letter-spacing:-.01em;color:{soft};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.b{{font-size:{size}px;font-weight:760;letter-spacing:-.045em;line-height:1.08;padding-bottom:.04em;margin-top:14px;color:{accent};
white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}}
.l{{font-size:50px;font-weight:560;line-height:1.12;margin-top:24px;letter-spacing:-.015em;
display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}}
.chips{{display:flex;gap:18px;margin-top:auto;padding-top:24px;flex:none}}
.chip{{flex:1;border-radius:22px;padding:18px 24px;color:#fff;min-width:0}}
.chip b{{display:block;font-size:64px;line-height:1;font-weight:760;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.02em}}
.chip span{{display:block;font-size:30px;font-weight:600;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.f{{margin-top:auto;font-size:34px;font-weight:550;color:{soft};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
</style></head><body>
<div class="k">{esc(kicker)}</div><div class="b">{esc(big)}</div>
{f'<div class="l" style="-webkit-line-clamp:{1 if chip_html else 2}">{esc(line)}</div>' if line else ''}
{f'<div class="chips">{chip_html}</div>' if chip_html else ''}
{f'<div class="f">{esc(foot)}</div>' if foot and not chip_html else ''}
</body></html>"""
    return render_html(doc, out)


def version():
    return int(time.time())
