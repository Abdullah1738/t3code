// Contact sheets as plain HTML (screenshotted by the CLI). Bubble tiles are drawn the way
// Messages shows them: rounded corners, the app icon over the top-left, findings outlined.
import { relative } from "node:path";
import { CORNER, ICON } from "./rules.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#3a3a3a;color:#f2f2f2;font:13px/1.35 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;padding:16px}
h1{font-size:18px;font-weight:650;margin:0 0 12px}
.hd,.row{display:grid;gap:14px;align-items:start;margin-bottom:14px}
.hd{font-weight:600;color:#cfcfcf;margin-bottom:8px}
.row{padding:8px;border-radius:10px;background:#2c2c2c}
.row.fail{background:#4a2222}
.name{font-weight:650;font-size:14px;word-break:break-word}
.name small{display:block;font-weight:500;color:#ffb4a8;margin-top:6px;font-size:12px;line-height:1.3}
.tile{position:relative;overflow:hidden}
.tile img{display:block;width:100%;height:100%}
.bubble{border-radius:${CORNER}px}
.bubble.light{background:#fff}.bubble.dark{background:#000}
.icon{position:absolute;left:${ICON.x - ICON.r}px;top:${ICON.y - ICON.r}px;width:${ICON.r * 2}px;height:${ICON.r * 2}px;border-radius:50%;
background:rgba(205,225,215,.92);box-shadow:0 0 0 2px rgba(80,120,100,.9)}
.box{position:absolute;outline:2px solid #ff3b30;outline-offset:0;background:rgba(255,59,48,.18)}
.box.warn{outline-color:#ffcc00;background:rgba(255,204,0,.15)}
.preview{border-radius:8px}
.cap{color:#bdbdbd;font-size:11px;margin-top:4px}
`;

function boxes(findings, scale = 1) {
  return findings
    .filter((f) => f.box)
    .map((f) => {
      const b = f.box;
      return `<i class="box${f.level === "WARN" ? " warn" : ""}" style="left:${b.l * scale}px;top:${b.t * scale}px;width:${Math.max(2, (b.r - b.l) * scale)}px;height:${Math.max(2, (b.b - b.t) * scale)}px"></i>`;
    })
    .join("");
}

const summary = (findings) => {
  const fails = findings.filter((f) => f.level === "FAIL");
  if (!fails.length) return "";
  const seen = new Set();
  const bits = [];
  for (const f of fails) {
    const k = `${f.rule}: ${f.detail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    bits.push(esc(k + (f.text ? ` ("${f.text}")` : "")));
  }
  return `<small>${bits.slice(0, 6).join("<br>")}${bits.length > 6 ? `<br>+${bits.length - 6} more` : ""}</small>`;
};

// cases: [{family, name, preview, shots:[{view, theme, png, findings}]}]
// columns: [{view, theme, label}] in display order.
export function sheetHtml({ title, cases, columns, base, previewWidth = 300 }) {
  const widths = columns.map((c) => (c.view.kind === "bubble" ? c.view.w : Math.round(c.view.w * (c.scale ?? 0.5))));
  const grid = `grid-template-columns:150px ${previewWidth ? previewWidth + "px " : ""}${widths.map((w) => w + "px").join(" ")}`;
  const head =
    `<div class="hd" style="${grid}"><div>Case</div>${previewWidth ? "<div>Link preview 1200x630</div>" : ""}` +
    columns.map((c) => `<div>${esc(c.label)}</div>`).join("") +
    "</div>";
  const rows = cases
    .map((k) => {
      const findings = k.shots.flatMap((s) => s.findings).concat(k.previewFindings || []);
      const fail = findings.some((f) => f.level === "FAIL");
      const cells = columns
        .map((c) => {
          const s = k.shots.find((x) => x.view.id === c.view.id && x.theme === c.theme);
          if (!s || !s.png) return "<div></div>";
          const src = esc(relative(base, s.png));
          if (c.view.kind === "bubble") {
            return `<div class="tile bubble ${c.theme}" style="width:${c.view.w}px;height:${c.view.h}px"><img src="${src}">${boxes(s.findings)}<i class="icon"></i></div>`;
          }
          const sc = c.scale ?? 0.5;
          return `<div class="tile" style="width:${Math.round(c.view.w * sc)}px;height:${Math.round(s.height * sc)}px"><img src="${src}">${boxes(s.findings, sc)}</div>`;
        })
        .join("");
      const pv = previewWidth
        ? k.preview
          ? `<div><img class="preview" style="width:${previewWidth}px" src="${esc(/^[a-z][a-z0-9+.-]*:/i.test(k.preview) ? k.preview : relative(base, k.preview))}"><div class="cap">${esc(k.previewTitle || "")}</div></div>`
          : `<div class="cap">no preview image</div>`
        : "";
      return `<div class="row${fail ? " fail" : ""}" style="${grid}"><div class="name">${esc(k.family)}/${esc(k.name)}${summary(findings)}</div>${pv}${cells}</div>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><h1>${esc(title)}</h1>${head}${rows}`;
}

export function sheetWidth({ columns, previewWidth = 300 }) {
  const widths = columns.map((c) => (c.view.kind === "bubble" ? c.view.w : Math.round(c.view.w * (c.scale ?? 0.5))));
  return 32 + 16 + 150 + (previewWidth ? previewWidth + 14 : 0) + widths.reduce((a, w) => a + w + 14, 0);
}
