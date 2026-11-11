/**
 * Sample asks for the reference page ("What an ask can be"). They are drawn by
 * the page's own parts, so the reference shows the real thing; nothing here
 * reaches the server. The files are made in the browser: a few shapes, a tone,
 * a one-page document and a three-second clip.
 */
import type {
  KanbanAskBlock,
  KanbanAskChange,
  KanbanAskFeedItem,
  KanbanOwnerAsk,
} from "@t3tools/contracts";

/** A three-second 320x180 H.264 clip (2 KB): a square crossing the frame over a progress bar. */
const SAMPLE_CLIP =
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAO2bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAC7gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAuF0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAC7gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAUAAAAC0AAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAu4AAAAAAABAAAAAAJZbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAAkABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACBG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAcRzdGJsAAAAvHN0c2QAAAAAAAAAAQAAAKxhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAAtABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAAMmF2Y0MBQsAV/+EAGWdCwBWmEQUGfnwEQAAAAwBAAAAGA8WLhGABAAZoyEICEsgAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAANaAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAJAAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAJAAAAAEAAACkc3RzegAAAAAAAAAAAAAAJAAAA34AAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAADAAAAAwAAAAMAAAADAAAAAwAAAAMAAAADAAAAAwAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAABRzdGNvAAAAAAAAAAEAAAPmAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMgAAAAhmcmVlAAAFD21kYXQAAAJzBgX//2/cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MTYgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDEzMSBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJvbWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz02IGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEyIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NjAgcmM9Y3JmIG1idHJlZT0xIGNyZj0zNC4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAABA2WIggd4iQUAAQ044AGOAAID9y333333333333333333111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111//+OC0JcUDoHz7eOcfMnXla2tra2tra2tra2tra2trFxIACaTbSSbaTXb4kJkD0+TF1///oFY6JJHTrzFuMrl+1tbW1tbW1tbW1tbW1tbW1x8P/QKq/Nvzpj67777777777777777776666666666666666666668AAAAAHQZocDvAeMAAAAAdBmioDvAeMAAAAB0GaOwO8B4wAAAAHQZpJAO8B4wAAAAdBmllA7wHjAAAAB0GaaYDvAeMAAAAHQZp5wO8B4wAAAAhBmoiAO8B4wAAAAAhBmpiQO8B4wAAAAAhBmqigO8B4wAAAAAhBmriwO8B4wAAAAAhBmsjAO8B4wAAAAAhBmtjQO8B4wAAAAAhBmujgO8B4wAAAAAhBmvjwO8B4wAAAAAdBmwAd4DxgAAAAB0GbEB3gPGAAAAAHQZsgHeA8YAAAAAdBmzAd4DxgAAAAB0GbQB3gPGAAAAAHQZtQHeA8YAAAAAdBm2Ad4DxgAAAAB0GbcB3gPGAAAAAHQZuAHeA8YAAAAAdBm5Ad4DxgAAAAB0GboB3gPGAAAAAHQZuwHeA8YAAAAAdBm8Ad4DxgAAAAB0Gb0B3gPGAAAAAHQZvgHeA8YAAAAAdBm/Ad4DxgAAAAB0GaAB3gPGAAAAAHQZoQHeA8YAAAAAdBmiAb4DxgAAAAB0GaMBngPGA=";

const svg = (markup: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;

const SANS = "system-ui,-apple-system,Segoe UI,sans-serif";

const SCREENSHOT = svg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="236" viewBox="0 0 720 236"><rect width="720" height="236" fill="#18181b"/><g font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="17"><text x="28" y="50" fill="#a1a1aa">$ board_get  # before</text><text x="28" y="80" fill="#f87171" font-weight="700">reply size 1.33 MB</text><text x="28" y="138" fill="#a1a1aa">$ board_get  # after, 400 visible cards</text><text x="28" y="168" fill="#4ade80" font-weight="700">reply size under 300 KB</text><text x="28" y="198" fill="#e4e4e7">settled cards left out unless includeSettled is true</text></g></svg>`,
);

const screen = (after: boolean): string =>
  svg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="360" viewBox="0 0 260 360" font-family="${SANS}"><rect width="260" height="360" fill="#ffffff"/><text x="20" y="46" font-size="18" font-weight="700" fill="#18181b">Referral</text><text x="20" y="66" font-size="11" fill="#71717a">Invite friends, earn together</text><rect x="20" y="86" width="220" height="${after ? 118 : 86}" rx="12" fill="${after ? "#ccfbf1" : "#f4f4f5"}"/><text x="34" y="114" font-size="11" fill="#52525b">Your reward</text><text x="34" y="146" font-size="24" font-weight="700" fill="#18181b">20 USDT</text>${after ? `<text x="34" y="184" font-size="11" fill="#0f766e">Paid on your friend's first trade</text>` : ""}<rect x="20" y="${after ? 220 : 188}" width="220" height="44" rx="10" fill="#f4f4f5"/><text x="34" y="${after ? 247 : 215}" font-size="12" font-weight="700" fill="#18181b">CRPKO-7F2K</text><rect x="20" y="298" width="220" height="40" rx="20" fill="${after ? "#0f766e" : "#18181b"}"/><text x="130" y="323" text-anchor="middle" font-size="13" font-weight="700" fill="#ffffff">Share invite link</text></svg>`,
  );

/** A short two-note tone as an 8-bit WAV. */
function tone(): Blob {
  const rate = 8_000;
  const seconds = 1.6;
  const count = Math.floor(rate * seconds);
  const view = new DataView(new ArrayBuffer(44 + count));
  const ascii = (at: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(at + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + count, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, count, true);
  for (let index = 0; index < count; index += 1) {
    const at = index / rate;
    const fade = Math.min(1, at * 20, (seconds - at) * 6);
    const wave = Math.sin(2 * Math.PI * (at < 0.8 ? 440 : 554) * at);
    view.setUint8(44 + index, 128 + Math.round(56 * fade * wave));
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

/** A one-page PDF: a title, a line and three storyboard frames. */
function onePagePdf(): Blob {
  const stream = [
    "BT /F1 26 Tf 56 770 Td (Walkthrough storyboard) Tj ET",
    "BT /F2 13 Tf 56 744 Td (Three frames of the referral flow, in the order they play.) Tj ET",
    "0.93 0.95 0.95 rg 56 520 150 190 re f 222 520 150 190 re f 388 520 150 190 re f",
    "0.06 0.46 0.43 rg 56 520 150 6 re f 222 520 150 6 re f 388 520 150 6 re f",
    "0 g BT /F2 11 Tf 56 500 Td (1  Envelope closed) Tj ET",
    "BT /F2 11 Tf 222 500 Td (2  Envelope opens) Tj ET",
    "BT /F2 11 Tf 388 500 Td (3  Reward shown) Tj ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: Array<number> = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([body], { type: "application/pdf" });
}

const CSV = [
  "time,ping_ms,loss_pct",
  "09:00,12,0",
  "09:05,2540,4",
  "09:10,6810,11",
  "09:15,3120,6",
  "09:20,14,0",
].join("\n");

const LOG = [
  "09:05:02 nettop  9router  en0  out 1.2 MB/s  in 88 KB/s",
  "09:05:07 nettop  9router  en0  out 1.4 MB/s  in 91 KB/s",
  "09:05:12 ping    192.168.1.1  time=2540 ms",
  "09:10:12 ping    192.168.1.1  time=6810 ms",
  "09:20:12 ping    192.168.1.1  time=14 ms",
].join("\n");

const clip = (): Blob => {
  const binary = atob(SAMPLE_CLIP);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "video/mp4" });
};

const CHART_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:13px/1.4 var(--font-sans);color:var(--foreground);padding:14px 16px}
.row{display:grid;grid-template-columns:5.5rem 1fr 3rem;gap:10px;align-items:center;margin:7px 0}
.bar{height:14px;border-radius:4px;background:var(--chart-1)}
.n{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted-foreground)}
</style>
<div class="row"><span>Monday</span><span><div class="bar" style="width:22%"></div></span><span class="n">12</span></div>
<div class="row"><span>Tuesday</span><span><div class="bar" style="width:64%"></div></span><span class="n">35</span></div>
<div class="row"><span>Wednesday</span><span><div class="bar" style="width:100%"></div></span><span class="n">55</span></div>
<div class="row"><span>Thursday</span><span><div class="bar" style="width:31%"></div></span><span class="n">17</span></div>
<div class="row"><span>Friday</span><span><div class="bar" style="width:9%"></div></span><span class="n">5</span></div>`;

/** A page that hands a value back: the slider posts it, and the field beside it shows it. */
const SLIDER_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:13px/1.4 var(--font-sans);color:var(--foreground);padding:16px}
label{display:block;margin-bottom:10px;color:var(--muted-foreground)}
input{width:100%;accent-color:var(--accent)}
.s{display:flex;justify-content:space-between;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
</style>
<label for="cap">Drag to set the daily cap</label>
<input id="cap" type="range" min="5" max="50" step="5" value="25">
<div class="s"><span>5</span><span>50</span></div>
<script>
var cap=document.getElementById("cap");
cap.addEventListener("input",function(){parent.postMessage({type:"robob.ask.value",value:Number(cap.value)},"*");});
</script>`;

export interface SampleFile {
  readonly blob: Blob;
  readonly url: string;
}

export interface SampleFiles {
  readonly video: SampleFile;
  readonly audio: SampleFile;
  readonly pdf: SampleFile;
  readonly csv: SampleFile;
  readonly log: SampleFile;
  readonly other: SampleFile;
  /** Frees every URL made here. */
  readonly revoke: () => void;
}

/** Makes the sample files and a URL for each. Call `revoke` when the page leaves. */
export function makeSampleFiles(): SampleFiles {
  const made: Array<string> = [];
  const file = (blob: Blob): SampleFile => {
    const url = URL.createObjectURL(blob);
    made.push(url);
    return { blob, url };
  };
  return {
    video: file(clip()),
    audio: file(tone()),
    pdf: file(onePagePdf()),
    csv: file(new Blob([CSV], { type: "text/csv" })),
    log: file(new Blob([LOG], { type: "text/plain" })),
    other: file(new Blob([new Uint8Array(4_200)], { type: "application/vnd.tcpdump.pcap" })),
    revoke: () => made.forEach((url) => URL.revokeObjectURL(url)),
  };
}

/** One thing an ask can show: its name, and the blocks that show it. */
export interface ShowSample {
  readonly label: string;
  readonly blocks: ReadonlyArray<KanbanAskBlock>;
  readonly urlOf: ReadonlyMap<number, string | null>;
  readonly fileOf: ReadonlyMap<number, Blob>;
}

const attachment = (name: string, mimeType: string, file: SampleFile): KanbanAskBlock =>
  ({
    _tag: "attachment",
    attachment: {
      type: "file",
      id: `sample-${name}`,
      name,
      mimeType,
      sizeBytes: file.blob.size,
    },
  }) as unknown as KanbanAskBlock;

const md = (text: string): KanbanAskBlock => ({ _tag: "md", text });
const image = (url: string, alt: string): KanbanAskBlock =>
  ({ _tag: "image", url, alt }) as KanbanAskBlock;

/** Every kind of block, in the order the reference lists them. `linkedCard`: a real card to link, when there is one. */
export function showSamples(files: SampleFiles, linkedCard: string | null): Array<ShowSample> {
  const one = (label: string, name: string, mimeType: string, file: SampleFile): ShowSample => ({
    label,
    blocks: [attachment(name, mimeType, file)],
    urlOf: new Map([[0, file.url]]),
    fileOf: new Map([[0, file.blob]]),
  });
  const plain = (label: string, blocks: ReadonlyArray<KanbanAskBlock>): ShowSample => ({
    label,
    blocks,
    urlOf: new Map(),
    fileOf: new Map(),
  });
  return [
    plain("Text", [
      md("Plain text with `code` and **bold**. The question and what you need come first."),
    ]),
    plain("Folded detail", [
      {
        _tag: "collapse",
        title: "Longer detail, closed until opened",
        text: "Anything that would push the question off the first screen goes here.",
      } as KanbanAskBlock,
    ]),
    plain("Picture", [
      image(SCREENSHOT, "Terminal output: reply size before and after"),
      md("A screenshot, with a one-line caption"),
    ]),
    plain("Before and after", [
      image(screen(false), "Referral screen before"),
      md("Before"),
      image(screen(true), "Referral screen after"),
      md("After"),
    ]),
    one("Video", "envelope-reveal.mp4", "video/mp4", files.video),
    one("Audio", "voiceover-take-2.wav", "audio/wav", files.audio),
    one("PDF", "walkthrough-storyboard.pdf", "application/pdf", files.pdf),
    one("Table file", "router-ping-en0.csv", "text/csv", files.csv),
    one("Log or source file", "nettop-9router.log", "text/plain", files.log),
    one("A type with no preview", "en0-capture.pcap", "application/vnd.tcpdump.pcap", files.other),
    plain("Chart or page", [
      {
        _tag: "html",
        html: CHART_PAGE,
        title: "Failed runs a day, this week",
        height: 170,
      } as KanbanAskBlock,
    ]),
    ...(linkedCard === null
      ? []
      : [plain("Linked card", [{ _tag: "card", cardId: linkedCard } as KanbanAskBlock])]),
  ];
}

export const SAMPLE_ACTION: NonNullable<KanbanOwnerAsk["action"]> = {
  summary: "Restarts the delivery tracker with the fixed image library.",
  command: "integrations/deploy.zsh robob-watch",
  target: "This Mac, the robob-watch LaunchAgent",
  evidence: ["Review clear at 4c1d9e2", "41 tests pass"],
  undo: "Deploy the previous commit, 9a7f310.",
  // oxlint-disable-next-line unicorn/no-thenable -- The contract's own field name: what the agent does after a yes.
  then: "Checks the next delivery card renders, and tells you.",
};

export const SAMPLE_CHANGES: ReadonlyArray<KanbanAskChange> = [
  {
    label: "Worker brief, tools line",
    before: "Use card_update to report progress.",
    after: "Use card_update to report progress. It works only on your own cards.",
    format: "text",
  },
];

/** A sample ask as the feed would carry it. Its ids are its own: nothing on a board has them. */
const sampleEntry = (id: string, kind: string, ask: Partial<KanbanOwnerAsk>): KanbanAskFeedItem =>
  ({
    boardId: "sample",
    boardSlug: "sample",
    boardName: "Robob",
    cardId: `sample-${id}`,
    cardNumber: 1,
    cardRef: `sample:${id}`,
    cardTitle: "",
    stage: "needs_owner",
    priority: 3,
    discussionId: null,
    blocks: 0,
    ask: {
      id: "q1",
      text: "",
      blocking: false,
      by: { _tag: "system", component: "reference" },
      at: "2026-01-01T00:00:00.000Z",
      seq: null,
      closedAt: null,
      kind,
      ...ask,
    },
    kind,
    revision: 0,
    waitsOn: "owner",
    expired: false,
    messages: [],
  }) as unknown as KanbanAskFeedItem;

export const SAMPLE_CHOOSE = sampleEntry("choose", "decision", {
  options: [
    {
      id: "today",
      label: "Ship it today",
      detail: "Each option says what it is.",
      consequence: "And what happens once it is picked.",
      recommended: true,
    },
    { id: "wait", label: "Wait for the backend", detail: "One or many can be picked." },
  ],
});

export const SAMPLE_FILL = sampleEntry("fill", "input", {
  blocks: [{ _tag: "html", html: SLIDER_PAGE, title: "Daily cap", height: 120 } as KanbanAskBlock],
  respond: {
    fields: [
      { id: "text", label: "Text", type: "text" },
      { id: "long", label: "Long text", type: "longtext" },
      { id: "number", label: "Number with a unit", type: "number", unit: "USD", min: 0, max: 500 },
      { id: "date", label: "Date", type: "date" },
      { id: "datetime", label: "Date and time", type: "datetime" },
      { id: "toggle", label: "Toggle", type: "toggle" },
      {
        id: "select",
        label: "Select",
        type: "select",
        options: [
          { id: "dev", label: "Dev" },
          { id: "staging", label: "Staging" },
          { id: "prod", label: "Production" },
        ],
      },
      {
        id: "rank",
        label: "Rank",
        type: "rank",
        options: [
          { id: "speed", label: "Speed" },
          { id: "cost", label: "Cost" },
          { id: "polish", label: "Polish" },
        ],
      },
      { id: "secret", label: "Secret", type: "secret", hint: "Masked, and kept nowhere." },
      { id: "file", label: "File", type: "file", accepts: ["image/*", ".csv"] },
      {
        id: "cap",
        label: "A value from a chart",
        type: "custom",
        unit: "USD",
        min: 5,
        max: 50,
        block: 0,
      },
    ],
  },
});

export const SAMPLE_DRAFT = sampleEntry("draft", "draft", {
  draft: {
    text: "Thanks for the report. The fix is in review and ships with the next release.",
    format: "text",
    target: "comment on CRP-10107",
  },
});

export const SAMPLE_TASK = sampleEntry("task", "task", {
  respond: {
    task: {
      steps: [
        { text: "Open the App Store Connect page", link: "https://appstoreconnect.apple.com" },
        { text: "Accept the new agreement" },
      ],
    },
  },
});
