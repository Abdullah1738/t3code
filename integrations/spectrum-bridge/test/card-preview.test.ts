import { expect, test } from "bun:test";
import { cardPreviewImage, ogImageOf } from "../src/card-preview.ts";

test("ogImageOf resolves relative og:image values and ignores non-https ones", () => {
  expect(ogImageOf(`<meta property="og:image" content="/preview.png?v=2&amp;x=1">`, "https://a.example/ride/"))
    .toBe("https://a.example/preview.png?v=2&x=1");
  expect(ogImageOf(`<meta content="https://cdn.example/i.png" name="twitter:image">`, "https://a.example/")).toBe("https://cdn.example/i.png");
  expect(ogImageOf(`<meta property="og:image" content="http://a.example/i.png">`, "https://a.example/")).toBeUndefined();
  expect(ogImageOf(`<meta property="og:title" content="x">`, "https://a.example/")).toBeUndefined();
});

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; method: string; redirect?: string }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", redirect: init?.redirect });
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    return route ? route() : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

test("cardPreviewImage returns the og:image only when it answers directly as an image", async () => {
  const page = `<meta property="og:image" content="/p.png">`;
  const ok = fakeFetch({
    "GET https://a.example/": html(page),
    "HEAD https://a.example/p.png": () => new Response(null, { headers: { "content-type": "image/png" } }),
  });
  expect(await cardPreviewImage(ok.fn)("https://a.example/")).toBe("https://a.example/p.png");
  expect(ok.calls[1]).toMatchObject({ method: "HEAD", redirect: "manual" });

  const redirected = fakeFetch({
    "GET https://a.example/": html(page),
    "HEAD https://a.example/p.png": () => new Response(null, { status: 302, headers: { location: "https://b.example/p.png" } }),
  });
  expect(await cardPreviewImage(redirected.fn)("https://a.example/")).toBeUndefined();

  const notImage = fakeFetch({
    "GET https://a.example/": html(page),
    "HEAD https://a.example/p.png": () => new Response(null, { headers: { "content-type": "text/html" } }),
  });
  expect(await cardPreviewImage(notImage.fn)("https://a.example/")).toBeUndefined();

  expect(await cardPreviewImage(fakeFetch({}).fn)("https://a.example/")).toBeUndefined();
  expect(await cardPreviewImage(fakeFetch({}).fn)("http://a.example/")).toBeUndefined();
});
