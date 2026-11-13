/**
 * Sample asks for the reference view ("What an ask can be"). They are drawn by
 * the screen's own parts, so the reference shows the real thing; nothing here
 * reaches the server. Shared by the web page and the phone; the web adds sample
 * files it makes in the browser.
 */
import type {
  KanbanAskBlock,
  KanbanAskChange,
  KanbanAskFeedItem,
  KanbanOwnerAsk,
} from "@t3tools/contracts";

export const SAMPLE_CHART_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
export const SAMPLE_SLIDER_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
export const sampleAskEntry = (id: string, kind: string, ask: Partial<KanbanOwnerAsk>): KanbanAskFeedItem =>
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

export const SAMPLE_CHOOSE = sampleAskEntry("choose", "decision", {
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

export const SAMPLE_FILL = sampleAskEntry("fill", "input", {
  blocks: [{ _tag: "html", html: SAMPLE_SLIDER_PAGE, title: "Daily cap", height: 120 } as KanbanAskBlock],
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

export const SAMPLE_DRAFT = sampleAskEntry("draft", "draft", {
  draft: {
    text: "Thanks for the report. The fix is in review and ships with the next release.",
    format: "text",
    target: "comment on CRP-10107",
  },
});

export const SAMPLE_TASK = sampleAskEntry("task", "task", {
  respond: {
    task: {
      steps: [
        { text: "Open the App Store Connect page", link: "https://appstoreconnect.apple.com" },
        { text: "Accept the new agreement" },
      ],
    },
  },
});
