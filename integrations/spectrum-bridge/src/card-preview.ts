/**
 * Sendblue fetches a static card's image outside the tailnet. Read it here and use the existing
 * media upload, so the page can stay private and the provider never receives an unreachable image URL.
 */
import { LineError, type LineFile } from "./line.ts";

const TIMEOUT_MS = 5_000;
const MAX_HTML = 512 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif", "image/webp": "webp",
};

async function boundedBody(response: Response, limit: number): Promise<Uint8Array | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return undefined;
      chunks.push(value);
    }
    return size ? new Uint8Array(Buffer.concat(chunks)) : undefined;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

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

export function cardPreviewImage(upload: (file: LineFile) => Promise<string>, fetchFn: typeof fetch = fetch) {
  return async (pageUrl: string): Promise<string | undefined> => {
    if (!httpsUrl(pageUrl)) throw new LineError("Card preview is unavailable", "card_preview_unavailable", true, false);
    try {
      const page = await fetchFn(pageUrl, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!page.ok || !/text\/html/i.test(page.headers.get("content-type") ?? "")) {
        await page.body?.cancel();
        throw new Error("invalid preview page");
      }
      const html = await boundedBody(page, MAX_HTML);
      if (!html) throw new Error("invalid preview page");
      const image = ogImageOf(new TextDecoder().decode(html), page.url || pageUrl);
      if (!image) return undefined;
      const response = await fetchFn(image, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      const extension = Object.hasOwn(IMAGE_EXTENSIONS, mimeType) ? IMAGE_EXTENSIONS[mimeType] : undefined;
      if (response.status !== 200 || !extension) { await response.body?.cancel(); throw new Error("invalid preview image"); }
      const data = await boundedBody(response, MAX_IMAGE);
      if (!data) throw new Error("invalid preview image");
      const uploaded = await upload({ data, name: `preview.${extension}`, mimeType });
      const result = httpsUrl(uploaded);
      if (!result) throw new Error("invalid preview upload");
      return result.href;
    } catch {
      throw new LineError("Card preview is unavailable", "card_preview_unavailable", true, false);
    }
  };
}
