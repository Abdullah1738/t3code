/**
 * What a page drawn inside the app (an html block of a message or an ask) may
 * do when it tries to go somewhere. The page is text an agent wrote, so it is
 * not trusted: it must never move the app itself (`robob://…` and every other
 * registered scheme), never dial, mail or open another app, and never leave
 * for a website by itself. The WebView asks about every navigation; this is
 * the whole answer.
 *
 * - The page's own document and frames it builds from its own text load.
 * - A web address in a frame of the page loads in that frame.
 * - A web address for the page itself never loads in place and never opens by
 *   itself: it is offered to him as a link to tap (`PageLinkOffer`).
 * - Everything else is refused, in every frame.
 */
export type PageNavigation =
  | { readonly _tag: "load" }
  | { readonly _tag: "offer"; readonly url: string }
  | { readonly _tag: "refuse" };

const LOAD: PageNavigation = { _tag: "load" };
const REFUSE: PageNavigation = { _tag: "refuse" };

const schemeOf = (url: string): string | null =>
  /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? null;

/** A web address and nothing else: `http://` or `https://` with a host. */
export const isWebAddress = (url: string): boolean => /^https?:\/\/[^/?#\s]+/i.test(url.trim());

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
  if ((scheme === "http" || scheme === "https") && isWebAddress(url)) {
    return top ? { _tag: "offer", url } : LOAD;
  }
  return REFUSE;
}

/** The site a link leads to, for the line that offers it: "example.com". */
export function pageLinkHost(url: string): string {
  const host = /^https?:\/\/([^/?#\s]+)/i.exec(url.trim())?.[1] ?? "";
  // Never the part before an "@": that is where a link hides its real site.
  return host.slice(host.lastIndexOf("@") + 1).replace(/^www\./i, "");
}
