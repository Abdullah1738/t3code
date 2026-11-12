/**
 * What a page drawn inside the app (an html block of a message or an ask) may
 * do when it tries to go somewhere. The page is text an agent wrote, so it is
 * not trusted: it must never move the app itself (`robob://…` and every other
 * registered scheme), never dial, mail or open another app, and never leave
 * for a website by itself. The WebView asks about every navigation; this is
 * the whole answer.
 *
 * - The page's own document and frames it builds from its own text load.
 * - A web address never loads, in the page or in a frame of it. For the page
 *   itself it is offered to him as a link to tap (`PageLinkOffer`); in a frame
 *   it is refused.
 * - Everything else is refused, in every frame.
 *
 * This is the second layer. The first is the shell the page is drawn in
 * (`pageShell.ts`), whose sandbox and policy hold without the WebView asking:
 * on Android the WebView does not ask about a form POST, and lets a navigation
 * through when the answer takes over 250 ms (the library's fixed timeout).
 */
export type PageNavigation =
  | { readonly _tag: "load" }
  | { readonly _tag: "offer"; readonly url: string }
  | { readonly _tag: "refuse" };

const LOAD: PageNavigation = { _tag: "load" };
const REFUSE: PageNavigation = { _tag: "refuse" };

const schemeOf = (url: string): string | null =>
  /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? null;

/** A web address he can be shown and sent to: what it opens and the site it names are one thing. */
export interface WebLink {
  /** The address as the parser wrote it back. This, and nothing else, is what opens. */
  readonly url: string;
  /**
   * The site it leads to, whole, as the parser wrote it: every label of the
   * host, and the port when it is not the scheme's own ("example.com",
   * "www.example.com:8443"). Shown whole wherever it is shown: the end of a
   * host is what says whose site it is, so it is never cut off.
   */
  readonly host: string;
}

// A backslash, a control character or a space: each is read differently by
// different parsers, which is how a link names one site and opens another.
// oxlint-disable-next-line no-control-regex -- Control characters are exactly what this looks for.
const UNSAFE_IN_LINK = /[\\\u0000-\u0020\u007f]/;

/**
 * Reads a link as a web address, once, with the platform's standard URL
 * parser. The label and the address that opens both come from that one
 * reading, so they can't differ. Refused: anything that is not `http://` or
 * `https://` with a host, an address that carries a user name or password
 * (`https://trusted.example@evil.example/`), and one with a backslash, a
 * space or a control character in it.
 */
export function parseWebLink(raw: string | undefined): WebLink | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text) || UNSAFE_IN_LINK.test(text)) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "" || parsed.hostname === "") return null;
  // The parser leaves the port empty when it is the scheme's default.
  const host = parsed.port === "" ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
  return { url: parsed.href, host };
}

export function pageNavigation(request: {
  readonly url: string;
  /** Unset on platforms that only ask about the page itself: taken as the page itself. */
  readonly isTopFrame?: boolean | undefined;
}): PageNavigation {
  const url = request.url.trim();
  const top = request.isTopFrame !== false;
  // The document the page was loaded as, and frames it fills from its own text.
  if (url === "about:blank" || url === "about:srcdoc") return LOAD;
  const scheme = schemeOf(url);
  if (scheme === "data") return top ? REFUSE : LOAD;
  if (scheme === "http" || scheme === "https") {
    const link = parseWebLink(url);
    if (link === null) return REFUSE;
    // What is offered is the address as the parser read it, the one that will open.
    // A frame holds the page's own text and nothing from the web.
    return top ? { _tag: "offer", url: link.url } : REFUSE;
  }
  return REFUSE;
}
