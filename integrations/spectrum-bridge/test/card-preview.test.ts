import { expect, test } from "bun:test";
import { cardPreviewImage, ogImageOf } from "../src/card-preview.ts";
import type { LineFile } from "../src/line.ts";

test("ogImageOf resolves relative og:image values and ignores non-https ones", () => {
  expect(ogImageOf(`<meta property="og:image" content="/preview.png?v=2&amp;x=1">`, "https://a.example/ride/"))
    .toBe("https://a.example/preview.png?v=2&x=1");
  expect(ogImageOf(`<meta content="https://cdn.example/i.png" name="twitter:image">`, "https://a.example/")).toBe("https://cdn.example/i.png");
  expect(ogImageOf(`<meta property="og:image" content="http://a.example/i.png">`, "https://a.example/")).toBeUndefined();
  expect(ogImageOf(`<meta property="og:title" content="x">`, "https://a.example/")).toBeUndefined();
});

function fakeFetch(routes: Record<string, () => Response>) {
  return (async (input: string | URL | Request) => routes[String(input)]?.() ?? new Response("", { status: 404 })) as typeof fetch;
}
const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html" } });
const page = `<meta property="og:image" content="p.png">`;

test("private og images are read on the Mac and uploaded as media, never handed to Sendblue by tailnet URL", async () => {
  const files: LineFile[] = [];
  const url = "https://mac.tailnet.ts.net:18400/delivery-noon-test/";
  const preview = cardPreviewImage(async file => { files.push(file); return "https://media.example/preview.png"; }, fakeFetch({
    [url]: html(page),
    [url + "p.png"]: () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }),
  }));
  expect(await preview(url)).toBe("https://media.example/preview.png");
  expect(files).toEqual([{ data: new Uint8Array([137, 80, 78, 71]), name: "preview.png", mimeType: "image/png" }]);
});

for (const [name, response] of Object.entries({
  redirect: () => new Response(null, { status: 302, headers: { location: "https://b.example/p.png" } }),
  missing: () => new Response(null, { status: 404 }),
  html: () => new Response("not an image", { headers: { "content-type": "text/html" } }),
  inherited: () => new Response("not an image", { headers: { "content-type": "constructor" } }),
  empty: () => new Response(null, { headers: { "content-type": "image/png" } }),
  oversized: () => new Response(new Uint8Array(10 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }),
})) {
  test(`invalid preview (${name}) is never uploaded`, async () => {
    let uploaded = false;
    const preview = cardPreviewImage(async () => { uploaded = true; return "https://media.example/p.png"; }, fakeFetch({
      "https://a.example/": html(page), "https://a.example/p.png": response,
    }));
    await expect(preview("https://a.example/")).rejects.toMatchObject({ code: "card_preview_unavailable", retryable: true, uncertain: false });
    expect(uploaded).toBe(false);
  });
}

test("failed media upload and non-https upload acknowledgements cannot become preview URLs", async () => {
  const fetchFn = fakeFetch({
    "https://a.example/": html(page),
    "https://a.example/p.png": () => new Response("bytes", { headers: { "content-type": "image/png" } }),
  });
  await expect(cardPreviewImage(async () => { throw new Error("upload failed"); }, fetchFn)("https://a.example/")).rejects.toMatchObject({ code: "card_preview_unavailable" });
  await expect(cardPreviewImage(async () => "http://media.example/p.png", fetchFn)("https://a.example/")).rejects.toMatchObject({ code: "card_preview_unavailable" });
});

test("caption-only pages such as secure forms do not require an image upload", async () => {
  const preview = cardPreviewImage(async () => { throw new Error("must not upload"); }, fakeFetch({
    "https://a.example/": html("<title>Secure form</title>"),
  }));
  expect(await preview("https://a.example/")).toBeUndefined();
});
