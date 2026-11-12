/**
 * The document a page inside the app is drawn in. The page (an html block of a
 * message or an ask) is text an agent wrote. It is never loaded as the
 * WebView's own document: the WebView loads this shell, which the app writes,
 * and the shell holds the page in one sandboxed frame.
 *
 * What that buys does not depend on the WebView asking the app about each
 * navigation (on Android that callback never sees a form POST, and lets a
 * navigation through when the app takes over 250 ms to answer):
 *
 * - `sandbox="allow-scripts"` and nothing else. The page runs its scripts, in
 *   an origin of its own. It cannot navigate the WebView's document (no
 *   `allow-top-navigation`), submit a form anywhere (no `allow-forms`), open a
 *   window (no `allow-popups`), start a download, or read anything of the
 *   shell (no `allow-same-origin`). The sandbox holds for every frame the page
 *   builds inside itself and for wherever the frame goes next.
 * - The shell's Content-Security-Policy, which the page inherits: no form may
 *   be submitted (`form-action 'none'`), no `<base>` may re-point its links
 *   (`base-uri 'none'`), and a frame may hold only the page's own text
 *   (`frame-src`: `srcdoc` and `data:`), so neither the page's frame nor one
 *   inside it can be sent to a website.
 * - The page reaches the app only through the shell, which passes on three
 *   things and only from the page's own frame: how tall the page is, a value
 *   for a custom field, and a web link he tapped (shown to him as a link to
 *   tap again, never opened). Each message carries a token the shell holds and
 *   the page cannot read, so the app drops anything that did not come through
 *   the shell: on Android the bridge object is visible in every frame.
 *
 * The app's own answer to each navigation (`pageNavigation`) stays on as a
 * second layer.
 */
import { parseWebLink } from "./pageNavigation";

/** What the shell allows, for itself and (inherited) for the page in its frame. */
export const PAGE_SHELL_CSP = "form-action 'none'; base-uri 'none'; frame-src about: data:";

/** The only thing the page's frame is allowed. */
export const PAGE_SHELL_SANDBOX = "allow-scripts";

const SIZE_METHOD = "ui/notifications/size-changed";
const LINK_METHOD = "ui/open-link";
/** The most a value for a custom field may weigh as JSON. */
const VALUE_MAX = 65_536;
const LINK_MAX = 2_048;

// Runs in the page, after its own text. A tap on a link never navigates the
// frame: a web link is told to the shell, anything else does nothing. A link
// inside the page ("#part") still scrolls.
const LINK_TAPS = `(function(){document.addEventListener("click",function(e){if(e.defaultPrevented)return;var p=e.composedPath?e.composedPath():[],l=null,i,h,u;for(i=0;i<p.length;i++){if(p[i]&&p[i].matches&&p[i].matches("a[href]")){l=p[i];break;}}if(!l)return;h=l.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();try{u=new URL(h,document.baseURI);}catch(_){return;}if(u.protocol!=="http:"&&u.protocol!=="https:")return;parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(LINK_METHOD)},params:{url:u.href}},"*");},true);})();`;

// Runs in the shell. `K` is the token; `f` is the page's frame.
const shellScript = (token: string) =>
  `(function(){var K=${JSON.stringify(token)},f=document.getElementById("page"),theme=null,met=false;` +
  `function out(m){try{window.ReactNativeWebView.postMessage(JSON.stringify({k:K,m:m}));}catch(_){}}` +
  `function tell(){if(theme&&f.contentWindow){try{f.contentWindow.postMessage(theme,"*");}catch(_){}}}` +
  `window.__robobPage={theme:function(t){theme=t;tell();}};` +
  `f.addEventListener("load",tell);` +
  `window.addEventListener("message",function(e){` +
  // Only the page's own frame: not a frame inside it, not the shell itself.
  `if(!f.contentWindow||e.source!==f.contentWindow)return;` +
  `var d=e.data,p,s;if(!d||typeof d!=="object")return;` +
  `if(!met){met=true;tell();}` +
  `p=d.params;` +
  `if(d.jsonrpc==="2.0"&&d.method===${JSON.stringify(SIZE_METHOD)}){if(p&&typeof p.height==="number"&&isFinite(p.height)&&p.height>0)out({t:"height",height:p.height});return;}` +
  `if(d.jsonrpc==="2.0"&&d.method===${JSON.stringify(LINK_METHOD)}){if(p&&typeof p.url==="string"&&p.url.length<=${LINK_MAX})out({t:"link",url:p.url});return;}` +
  `if(d.type==="robob.ask.value"&&"value" in d){try{s=JSON.stringify(d.value);}catch(_){return;}if(typeof s!=="string"||s.length>${VALUE_MAX})return;out({t:"value",value:JSON.parse(s)});return;}` +
  `if(typeof d.robobPick==="number"&&isFinite(d.robobPick))out({t:"value",value:d.robobPick});` +
  `});` +
  // The frame tried to go to a website by itself and the policy stopped it: offer the link.
  `document.addEventListener("securitypolicyviolation",function(e){var u=e.blockedURI;if(typeof u==="string"&&u.length<=${LINK_MAX}&&/^https?:\\/\\//i.test(u))out({t:"link",url:u});});` +
  `})();`;

const attribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The shell with the page inside it. `html` is the page as it should run
 * (with the theme bootstrap already in it, when it takes the app's colours);
 * `token` is `newPageToken()`, kept by the screen that reads the messages.
 */
export function pageShell(input: {
  readonly html: string;
  readonly token: string;
  readonly title?: string | undefined;
}): string {
  const page = `${input.html}<script>${LINK_TAPS}</script>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="${attribute(PAGE_SHELL_CSP)}">` +
    `<meta name="color-scheme" content="light dark">` +
    `<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}` +
    `iframe{display:block;border:0;width:100%;height:100%;background:transparent}</style></head><body>` +
    `<iframe id="page" title="${attribute(input.title ?? "Page")}" sandbox="${PAGE_SHELL_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${attribute(page)}"></iframe>` +
    `<script>${shellScript(input.token)}</script></body></html>`
  );
}

/** For `injectJavaScript`: hands the shell a theme message to pass on to the page. */
export const pageThemeScript = (message: unknown): string =>
  `window.__robobPage&&window.__robobPage.theme(${JSON.stringify(message)});true;`;

/** A token for one shell: hex, new for every page drawn. */
export function newPageToken(): string {
  const bytes = new Uint8Array(16);
  const crypto = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
  ).crypto;
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type PageMessage =
  | { readonly _tag: "height"; readonly height: number }
  | { readonly _tag: "value"; readonly value: unknown }
  | { readonly _tag: "link"; readonly url: string };

/**
 * What a page told the app, as the shell passed it on: how tall it is, a
 * value for a custom field, or a web link to offer. Anything without this
 * shell's token did not come through the shell and is dropped; so is anything
 * of another shape, and a link that is not a plain web address.
 */
export function readPageMessage(raw: string, token: string): PageMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { k, m } = data as { k?: unknown; m?: unknown };
  if (token === "" || k !== token || typeof m !== "object" || m === null) return null;
  const message = m as { t?: unknown; height?: unknown; value?: unknown; url?: unknown };
  if (message.t === "height") {
    const { height } = message;
    return typeof height === "number" && Number.isFinite(height) && height > 0
      ? { _tag: "height", height }
      : null;
  }
  if (message.t === "value")
    return "value" in message ? { _tag: "value", value: message.value } : null;
  if (message.t === "link") {
    const link = typeof message.url === "string" ? parseWebLink(message.url) : null;
    return link === null ? null : { _tag: "link", url: link.url };
  }
  return null;
}
