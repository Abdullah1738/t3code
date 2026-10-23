/**
 * Preview image for a static app card: the page's own og:image. Sendblue only takes a public
 * https image that answers directly (no redirects), so anything else is left out and the card
 * keeps just its captions.
 */
const TIMEOUT_MS = 5_000;
const MAX_HTML = 512 * 1024;
const IMAGE_TYPES = /^image\/(?:jpeg|png|heic|heif|webp)\b/i;

function httpsUrl(value: string, base?: string): URL | undefined {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048 ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The og:image (or twitter:image) content of a page, resolved against the page URL. */
export function ogImageOf(html: string, pageUrl: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.trim().toLowerCase();
    if (key !== "og:image" && key !== "og:image:secure_url" && key !== "twitter:image") continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim().replaceAll("&amp;", "&");
    const url = content ? httpsUrl(content, pageUrl) : undefined;
    if (url) return url.href;
  }
  return undefined;
}

export function cardPreviewImage(fetchFn: typeof fetch = fetch) {
  return async (pageUrl: string): Promise<string | undefined> => {
    if (!httpsUrl(pageUrl)) return undefined;
    try {
      const page = await fetchFn(pageUrl, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!page.ok || !/text\/html/i.test(page.headers.get("content-type") ?? "")) return undefined;
      const html = (await page.text()).slice(0, MAX_HTML);
      const image = ogImageOf(html, page.url || pageUrl);
      if (!image) return undefined;
      const head = await fetchFn(image, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      return head.status === 200 && IMAGE_TYPES.test(head.headers.get("content-type") ?? "") ? image : undefined;
    } catch {
      return undefined;
    }
  };
}
