// card-check: render Robob cards the way Messages shows them and fail what a person would
// notice (text under the app icon or in a masked corner, a half-cut line, a lost ETA,
// sideways scroll, an off-centre card, text under the status bar, a missing preview).
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findChrome, launch } from "./cdp.mjs";
import { BUILDERS, familyOf, locate, pageDir, stopBuilders } from "./families.mjs";
import { measure } from "./measure.mjs";
import { checkReply } from "./reply.mjs";
import { evaluate, KEEP, previewFindings, THEMES, VIEWS } from "./rules.mjs";
import { sheetHtml, sheetWidth } from "./sheet.mjs";

const USAGE = `card-check: compact-bubble acceptance checks for Robob cards

  card-check set [ride] [delivery] [qcard] [--only a,b] [--out DIR]
      Build each renderer's acceptance set (all three by default) and check every case.
  card-check page DIR|index.html ... [--family ride|delivery|qcard] [--out DIR]
      Check finished card directories (a real card before you send it).
  card-check reply [--chat SLUG] [--json] [TEXT | -]
      Lint a chat reply before sending (text from args or stdin, no browser). FAIL means
      structured data (codes, Wi-Fi, flight details, address with times, field lists,
      tables): send a card plus a one-line takeaway. WARN group: a trip item in a 1:1 chat
      goes to the owner+Moni group when both are on the trip.

Options: --themes dark,light  --jobs N (6)  --json  --timeout SECONDS (300, at least 30)

Views: Messages bubble 275x266 (iPhone) and 345x310 (iPad) with the corner mask and
app icon; full page at 300 and 390 wide (390 with iPhone safe-area insets); the
1200x630 link preview is checked first (an absolute og:image URL is loaded over the
network, the way Messages loads it). --timeout covers the whole run, sample builds
included. Exit 0 = no FAIL, 1 = FAIL, 2 = could not run.
Output: report.json, sheet PNGs per family, fails.png, shots/. Read the sheets.`;

function parse(argv) {
  const a = { cmd: argv[0], args: [], only: null, out: null, themes: THEMES, jobs: 6, json: false, timeout: 300, family: null, chat: null };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i];
    if (v === "--only") a.only = new Set(next().split(",").map((s) => s.trim().toLowerCase()));
    else if (v === "--out") a.out = resolve(next());
    else if (v === "--themes") {
      a.themes = [...new Set(next().split(",").map((t) => t.trim()).filter(Boolean))];
      const bad = a.themes.filter((t) => !THEMES.includes(t));
      if (bad.length || !a.themes.length) throw new Error(`--themes takes ${THEMES.join(",")} (got ${bad.join(",") || "nothing"})`);
    }
    else if (v === "--jobs") a.jobs = Math.max(1, +next() || 6);
    else if (v === "--timeout") a.timeout = Math.max(30, +next() || 300);
    else if (v === "--family") a.family = next();
    else if (v === "--chat") a.chat = next();
    else if (v === "--json") a.json = true;
    else if (v === "-h" || v === "--help") a.cmd = "help";
    else a.args.push(v);
  }
  return a;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

// Where the link preview image lives: a remote URL as is, a relative one in the card dir.
const previewSrc = (dir, image) => {
  if (!image) return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(image) ? image : resolve(dir, image.split(/[?#]/)[0]);
};

// Loads og:image from the card page itself (relative URLs resolve against it) and
// decodes its pixels, so a stub or broken file fails like it would in Messages. onload
// and naturalWidth only prove the header parsed; createImageBitmap needs real pixels.
const loadImage = (page, image) =>
  page.eval(
    `new Promise((ok) => {
       const img = new Image();
       let done = false;
       const end = (v) => { if (!done) { done = true; clearTimeout(t); ok(v); } };
       const t = setTimeout(() => end({ error: "timed out" }), 10000);
       img.onload = () => createImageBitmap(img).then(
         (bm) => { const v = { w: bm.width, h: bm.height }; bm.close(); end(v); },
         (e) => end({ error: "did not decode (" + e.name + ")" }),
       );
       img.onerror = () => end({ error: "did not load or decode" });
       try { img.src = new URL(${JSON.stringify(image)}, location.href).href; }
       catch { end({ error: "not a valid URL" }); }
     })`,
    15000,
  ).catch((err) => ({ error: String(err.message || err) }));

async function shoot(page, url, view, theme, keep, pngPath) {
  await page.send("Emulation.setDeviceMetricsOverride", { width: view.w, height: view.h, deviceScaleFactor: view.scale, mobile: true });
  await page.send("Emulation.setSafeAreaInsetsOverride", { insets: view.insets || { top: 0, bottom: 0, left: 0, right: 0 } });
  await page.send("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-color-scheme", value: theme }] });
  await page.goto(url);
  await page.settle();
  const m = await page.eval(`(${measure.toString()})(${JSON.stringify({ bubble: view.kind === "bubble", keep })})`);
  const full = view.kind === "page" && m.sh > view.h;
  const shot = await page.send(
    "Page.captureScreenshot",
    full ? { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: view.w, height: m.sh, scale: 1 } } : { format: "png" },
    60000,
  );
  writeFileSync(pngPath, Buffer.from(shot.data, "base64"));
  return { m, height: full ? m.sh : view.h };
}

async function pool(items, jobs, browser, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    let page = await browser.newPage();
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(page, item);
      } catch (err) {
        item.error = String(err.message || err);
        await page.close();
        page = await browser.newPage();
      }
    }
    await page.close();
  });
  await Promise.all(workers);
}

async function screenshotHtml(browser, htmlPath, width, pngPath) {
  const page = await browser.newPage();
  try {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.settle(150);
    const h = await page.eval("document.documentElement.scrollHeight");
    const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } }, 90000);
    writeFileSync(pngPath, Buffer.from(shot.data, "base64"));
  } finally {
    await page.close();
  }
}

// Sheets are cut into parts so no single PNG gets taller than Chrome will capture.
function chunks(cases, rowHeight, limit = 6500) {
  const out = [];
  let cur = [];
  let h = 0;
  for (const k of cases) {
    const rh = rowHeight(k);
    if (cur.length && h + rh > limit) {
      out.push(cur);
      cur = [];
      h = 0;
    }
    cur.push(k);
    h += rh + 14;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function sheets(browser, out, cases, themes) {
  const bubbleCols = VIEWS.filter((v) => v.kind === "bubble").flatMap((view) =>
    themes.map((theme) => ({ view, theme, label: `${view.id === "bubble-iphone" ? "iPhone" : "iPad"} bubble ${view.w}x${view.h} ${theme}` })),
  );
  const pageCols = VIEWS.filter((v) => v.kind === "page").flatMap((view) =>
    themes.map((theme) => ({ view, theme, scale: 0.5, label: `page ${view.w} ${theme} (half size)` })),
  );
  const written = [];
  const make = async (name, title, list, columns, previewWidth) => {
    if (!list.length) return;
    const rowH = (k) =>
      Math.max(
        previewWidth ? (previewWidth * 630) / 1200 + 20 : 0,
        ...columns.map((c) => {
          const s = k.shots.find((x) => x.view.id === c.view.id && x.theme === c.theme);
          return c.view.kind === "bubble" ? c.view.h : Math.round((s?.height || c.view.h) * (c.scale ?? 0.5));
        }),
      ) + 16;
    const parts = chunks(list, rowH);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.length > 1 ? `-${i + 1}` : "";
      const html = join(out, `.${name}${suffix}.html`);
      const png = join(out, `${name}${suffix}.png`);
      writeFileSync(html, sheetHtml({ title: `${title}${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ""}`, cases: parts[i], columns, base: out, previewWidth }));
      await screenshotHtml(browser, html, sheetWidth({ columns, previewWidth }), png);
      rmSync(html, { force: true });
      written.push(png);
    }
  };
  const families = [...new Set(cases.map((k) => k.family))];
  for (const f of families) {
    const list = cases.filter((k) => k.family === f);
    await make(`sheet-${f}-bubble`, `${f}: link preview + Messages bubble`, list, bubbleCols, 300);
    await make(`sheet-${f}-page`, `${f}: full page`, list, pageCols, 0);
  }
  const failing = cases.filter((k) => k.findings.some((x) => x.level === "FAIL"));
  if (failing.length) {
    await make("fails", "Cases with FAIL findings", failing, [...bubbleCols, ...pageCols], 300);
  }
  return written;
}

async function main() {
  const a = parse(process.argv.slice(2));
  if (!a.cmd || a.cmd === "help" || !["set", "page", "reply"].includes(a.cmd)) {
    console.log(USAGE);
    process.exit(a.cmd === "help" ? 0 : 2);
  }
  if (a.cmd === "reply") return reply(a);
  const chrome = findChrome();
  if (!chrome) throw new Error("no headless Chrome found (set CARD_CHECK_CHROME)");
  const out = a.out || join(process.env.TMPDIR || tmpdir(), "card-check", stamp());
  mkdirSync(join(out, "shots"), { recursive: true });
  const t0 = Date.now();
  // Renderers get TMPDIR here, so Chrome profiles a killed renderer leaves go with it.
  const scratch = mkdtempSync(join(out, ".scratch-"));
  // One deadline for the whole run. On it, or on any failure, the sample builds and
  // everything they started are stopped and waited for, the browser is closed, and the
  // run exits 2.
  const abort = new AbortController();
  let browser = null;
  let cleaning = null;
  const cleanup = () =>
    (cleaning ||= (async () => {
      abort.abort();
      await stopBuilders();
      await browser?.close();
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    })());
  const giveUp = (why, code) => {
    console.error(`card-check: ${why}`);
    cleanup().finally(() => process.exit(code));
  };
  const deadline = setTimeout(() => giveUp(`gave up after ${a.timeout}s`, 2), a.timeout * 1000);
  // Builders run in their own process groups and Chrome outlives a killed parent, so a
  // signal has to go through the same cleanup or they are left running.
  const onSignal = (sig) => giveUp(`stopped by ${sig}`, 128 + (sig === "SIGINT" ? 2 : sig === "SIGHUP" ? 1 : 15));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, onSignal);
  try {
    await run(a, chrome, out, t0, abort.signal, () => abort.abort(), scratch, (b) => (browser = b));
  } finally {
    clearTimeout(deadline);
    await cleanup();
  }
}

// No browser: a text lint run on a reply before it goes out.
async function reply(a) {
  let text = a.args.filter((x) => x !== "-").join(" ");
  if (!text) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (!text.trim()) throw new Error("reply: no text (pass it as an argument or on stdin)");
  const findings = checkReply(text, { chat: a.chat });
  const ok = !findings.some((f) => f.level === "FAIL");
  if (a.json) console.log(JSON.stringify({ ok, chat: a.chat, findings }));
  else {
    for (const f of findings) console.log(`${f.level} ${f.rule}: ${f.detail}${f.text ? ` ("${f.text}")` : ""}`);
    console.log(ok ? "PASS: fine as text" : "FAIL: send this as a card (design it, card-check page it), plus a one-line takeaway");
  }
  process.exitCode = ok ? 0 : 1;
}

async function run(a, chrome, out, t0, signal, stop, scratch, setBrowser) {
  let cases = [];
  if (a.cmd === "set") {
    const fams = a.args.length ? a.args : Object.keys(BUILDERS);
    const bad = fams.filter((f) => !BUILDERS[f]);
    if (bad.length) throw new Error(`unknown family: ${bad.join(", ")} (ride, delivery, qcard)`);
    const where = locate();
    // The first family to fail stops the others, and all of them are waited for, so none
    // is left running unwatched. Its error is the one reported, not the stopped siblings'.
    let broke = null;
    const settled = await Promise.allSettled(
      fams.map(async (f) => {
        try {
          return { f, list: await BUILDERS[f](join(out, "cards", f), where, signal, scratch) };
        } catch (err) {
          broke ||= err;
          stop();
          throw err;
        }
      }),
    );
    if (broke) throw broke;
    const built = settled.map((s) => s.value);
    for (const { f, list } of built) {
      for (const c of list) if (!a.only || a.only.has(c.name)) cases.push({ family: f, name: c.name, dir: c.dir, file: join(c.dir, "index.html") });
    }
  } else {
    if (!a.args.length) throw new Error("page needs at least one card directory or index.html");
    for (const p of a.args) {
      const { dir, file } = pageDir(p);
      if (!existsSync(file)) throw new Error(`no ${file}`);
      cases.push({ family: a.family || familyOf(dir), name: basename(dir), dir, file });
    }
  }
  if (!cases.length) throw new Error("nothing to check");
  if (signal.aborted) return;

  const browser = await launch(chrome);
  setBrowser(browser);
  {
    const version = (await browser.version()).product;
    const tasks = [];
    for (const k of cases) {
      k.shots = [];
      k.findings = [];
      for (const view of VIEWS) for (const theme of a.themes) tasks.push({ k, view, theme });
    }
    await pool(tasks, a.jobs, browser, async (page, t) => {
      const png = join(out, "shots", `${t.k.family}-${t.k.name}-${t.view.id}-${t.theme}.png`);
      const keep = KEEP[t.k.family] || KEEP.page;
      const { m, height } = await shoot(page, pathToFileURL(t.k.file).href, t.view, t.theme, keep, png);
      const findings = evaluate(m, t.view, t.k.family).map((f) => ({ ...f, view: t.view.id, theme: t.theme }));
      t.k.shots.push({ view: t.view, theme: t.theme, png, height, findings });
      if (!t.k.meta) t.k.meta = m.meta;
      // The preview is judged once per case, from whichever shot gets there first.
      if (!t.k.previewClaimed && m.meta.image) {
        t.k.previewClaimed = true;
        t.k.previewImg = await loadImage(page, m.meta.image);
      }
    });
    for (const t of tasks) {
      // A shot that was taken stands; the error only fills in the views that have none.
      if (t.error && !t.k.shots.some((s) => s.view.id === t.view.id && s.theme === t.theme)) {
        t.k.shots.push({ view: t.view, theme: t.theme, png: null, findings: [{ rule: "load", level: "FAIL", detail: t.error, view: t.view.id, theme: t.theme }] });
      }
    }
    // A PASS has to mean every view was looked at in every theme.
    const want = VIEWS.length * a.themes.length;
    const short = cases.filter((k) => k.shots.length !== want);
    if (signal.aborted) throw new Error("stopped");
    if (!want || short.length) throw new Error(`checked ${short.map((k) => `${k.name} ${k.shots.length}/${want}`).join(", ") || "no views"}; not reporting a result`);
    for (const k of cases) {
      const meta = k.meta || {};
      k.previewFindings = k.meta ? previewFindings(meta, k.previewImg) : [];
      k.preview = k.previewImg && !k.previewImg.error ? previewSrc(k.dir, meta.image) : null;
      k.previewTitle = meta.title;
      const order = (s) => VIEWS.findIndex((v) => v.id === s.view.id) * 10 + a.themes.indexOf(s.theme);
      k.shots.sort((x, y) => order(x) - order(y));
      k.findings = [...k.previewFindings, ...k.shots.flatMap((s) => s.findings)];
    }
    const pngs = await sheets(browser, out, cases, a.themes);
    const report = {
      ok: !cases.some((k) => k.findings.some((f) => f.level === "FAIL")),
      out,
      chrome: version,
      ms: Date.now() - t0,
      sheets: pngs,
      totals: {
        cases: cases.length,
        failing: cases.filter((k) => k.findings.some((f) => f.level === "FAIL")).length,
        fail: cases.reduce((n, k) => n + k.findings.filter((f) => f.level === "FAIL").length, 0),
        warn: cases.reduce((n, k) => n + k.findings.filter((f) => f.level === "WARN").length, 0),
      },
      cases: cases.map((k) => ({
        family: k.family,
        name: k.name,
        dir: k.dir,
        preview: k.preview,
        findings: k.findings.map(({ box, ...f }) => f),
        shots: k.shots.map((s) => ({ view: s.view.id, theme: s.theme, png: s.png })),
      })),
    };
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    const latest = join(dirname(out), "latest");
    if (!a.out) {
      rmSync(latest, { force: true });
      try {
        symlinkSync(out, latest);
      } catch {}
    }
    if (a.json) {
      console.log(JSON.stringify({ ok: report.ok, out, totals: report.totals, sheets: pngs, report: join(out, "report.json") }));
    } else {
      const fams = [...new Set(cases.map((k) => k.family))];
      for (const f of fams) {
        const list = cases.filter((k) => k.family === f);
        const failing = list.filter((k) => k.findings.some((x) => x.level === "FAIL"));
        const warns = list.reduce((n, k) => n + k.findings.filter((x) => x.level === "WARN").length, 0);
        console.log(`${f}: ${list.length} cases, ${failing.length} failing, ${warns} warnings`);
        for (const k of failing) {
          const seen = new Set();
          for (const x of k.findings.filter((x) => x.level === "FAIL")) {
            const key = `${x.rule}|${x.detail}|${x.text || ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const where = k.findings.filter((y) => y.level === "FAIL" && `${y.rule}|${y.detail}|${y.text || ""}` === key).map((y) => (y.view ? `${y.view}/${y.theme}` : "preview"));
            console.log(`  FAIL ${k.name}: ${x.rule}: ${x.detail}${x.text ? ` ("${x.text}")` : ""} [${[...new Set(where)].join(", ")}]`);
          }
        }
      }
      console.log(`${report.ok ? "PASS" : "FAIL"} in ${(report.ms / 1000).toFixed(1)}s`);
      for (const p of pngs) console.log(`sheet ${p}`);
      console.log(`report ${join(out, "report.json")}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  }
}

main().catch((err) => {
  console.error(`card-check: ${err.message || err}`);
  process.exit(2);
});
