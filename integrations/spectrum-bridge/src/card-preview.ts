import { cardKind, logCardRender, toolError } from "./toollog.ts";
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
    await reader.cancel().catch((caughtError) => { toolError("card-preview", "card-preview.catch1", caughtError);});
    reader.releaseLock();
  }
}

function httpsUrl(value: string, base?: string): URL | undefined {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048 ? url : undefined;
  } catch (caughtError) { toolError("card-preview", "card-preview.catch2", caughtError);
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

export function cardPreviewImage(upload: (file: LineFile) => Promise<string>, fetchFn: typeof fetch = fetch, chat?: string) {
  const attempts = new Map<string, number>();
  return async (pageUrl: string): Promise<string | undefined> => {
    const attempt = (attempts.get(pageUrl) ?? 0) + 1;
    attempts.set(pageUrl, attempt);
    // Failed cards can be abandoned by delivery; bound diagnostic-only memory.
    if (attempts.size > 1_000) attempts.delete(attempts.keys().next().value!);
    const at = performance.now();
    let ok = false;
    let failureCode = "invalid_url";
    try {
    if (!httpsUrl(pageUrl)) throw new LineError("Card preview is unavailable", "card_preview_unavailable", true, false);
    try {
      failureCode = "page_fetch";
      const page = await fetchFn(pageUrl, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!page.ok || !/text\/html/i.test(page.headers.get("content-type") ?? "")) {
        failureCode = page.ok ? "page_type" : "page_http";
        await page.body?.cancel();
        throw new Error("invalid preview page");
      }
      failureCode = "page_body";
      const html = await boundedBody(page, MAX_HTML);
      if (!html) throw new Error("invalid preview page");
      const image = ogImageOf(new TextDecoder().decode(html), page.url || pageUrl);
      if (!image) { failureCode = "none"; ok = true; return undefined; }
      failureCode = "image_fetch";
      const response = await fetchFn(image, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
      const extension = Object.hasOwn(IMAGE_EXTENSIONS, mimeType) ? IMAGE_EXTENSIONS[mimeType] : undefined;
      if (response.status !== 200 || !extension) { failureCode = response.status !== 200 ? "image_http" : "image_type"; await response.body?.cancel(); throw new Error("invalid preview image"); }
      failureCode = "image_body";
      const data = await boundedBody(response, MAX_IMAGE);
      if (!data) throw new Error("invalid preview image");
      failureCode = "upload";
      const uploaded = await upload({ data, name: `preview.${extension}`, mimeType });
      failureCode = "upload_url";
      const result = httpsUrl(uploaded);
      if (!result) throw new Error("invalid preview upload");
      failureCode = "none";
      ok = true;
      return result.href;
    } catch (caughtError) { toolError("card-preview", "card-preview.catch3", caughtError);
      throw new LineError("Card preview is unavailable", "card_preview_unavailable", true, false);
    }
    } finally {
      if (ok) attempts.delete(pageUrl);
      logCardRender("cards", cardKind(pageUrl), performance.now() - at, ok, { chat, failureCode, attempt });
    }
  };
}
