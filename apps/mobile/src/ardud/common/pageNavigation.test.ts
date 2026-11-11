import { describe, expect, it } from "vite-plus/test";

import { pageNavigation, parseWebLink } from "./pageNavigation";

const top = (url: string) => pageNavigation({ url, isTopFrame: true })._tag;
const frame = (url: string) => pageNavigation({ url, isTopFrame: false })._tag;

describe("where a page inside the app may go", () => {
  it("loads its own document and the frames it fills from its own text", () => {
    expect(top("about:blank")).toBe("load");
    expect(frame("about:blank")).toBe("load");
    expect(frame("about:srcdoc")).toBe("load");
    expect(frame("data:text/html,<p>chart</p>")).toBe("load");
  });

  it("never moves the app: its own scheme and every other one are refused, in every frame", () => {
    for (const url of [
      "robob://needs-you/history",
      "robob://needs-you/ask/c1/q1",
      "t3code://thread/1",
      "exp://127.0.0.1:8081",
      "tel:+15550100",
      "sms:+15550100",
      "mailto:a@example.com",
      "itms-services://?action=download-manifest&url=https://x.test/m.plist",
      "intent://scan/#Intent;scheme=zxing;end",
      "file:///etc/passwd",
      "blob:null/1b2c",
      "javascript:alert(1)",
      "about:config",
      "ftp://example.com/file",
      "",
      "needs-you/history",
    ]) {
      expect(top(url), url).toBe("refuse");
      expect(frame(url), url).toBe("refuse");
      expect(pageNavigation({ url })._tag, url).toBe("refuse");
    }
  });

  it("never replaces the page with other content", () => {
    expect(top("data:text/html,<script>location='robob://x'</script>")).toBe("refuse");
  });

  it("offers a web address instead of opening or loading it", () => {
    expect(pageNavigation({ url: "https://example.com/a?b=1", isTopFrame: true })).toEqual({
      _tag: "offer",
      url: "https://example.com/a?b=1",
    });
    expect(top("HTTP://example.com")).toBe("offer");
    // A platform that does not say which frame is asking: taken as the page itself.
    expect(pageNavigation({ url: "https://example.com" })._tag).toBe("offer");
  });

  it("lets a frame of the page load a web address in place, and nothing opens", () => {
    expect(frame("https://example.com/embed")).toBe("load");
    expect(frame("http://example.com/embed")).toBe("load");
  });

  it("takes only a real web address for one", () => {
    expect(parseWebLink("https://example.com")).toEqual({
      url: "https://example.com/",
      host: "example.com",
    });
    expect(parseWebLink("https:")).toBeNull();
    expect(parseWebLink("https:///")).toBeNull();
    expect(parseWebLink("https:example.com")).toBeNull();
    expect(parseWebLink("robob://x")).toBeNull();
    expect(parseWebLink(undefined)).toBeNull();
    expect(top("https:robob://x")).toBe("refuse");
  });

  it("names the site the address really opens, from one reading of it", () => {
    expect(parseWebLink("  HTTPS://WWW.Example.COM/Path?q=1#top ")).toEqual({
      url: "https://www.example.com/Path?q=1#top",
      host: "example.com",
    });
    // What is offered for a page's link is that same reading.
    expect(pageNavigation({ url: "HTTPS://Example.com", isTopFrame: true })).toEqual({
      _tag: "offer",
      url: "https://example.com/",
    });
    // A name in another script is shown as the parser resolves it, not as it was drawn.
    expect(parseWebLink("https://\u0430pple.com/")?.host).toBe("xn--pple-43d.com");
  });

  it("refuses an address that names one site and opens another", () => {
    for (const url of [
      // A standard parser reads the backslash as a slash: the site is evil.example.
      "https://evil.example\\@trusted.example/",
      "https://trusted.example\\.evil.example/",
      "https:\\\\evil.example/",
      // A user name or password before the site.
      "https://trusted.example@evil.example/",
      "https://trusted.example:443@evil.example/login",
      "https://user:pw@example.com/",
      "https://trusted.example%2f@evil.example/",
      // Control characters and spaces a parser strips or splits on.
      "https://trusted.example\t.evil.example/",
      "https://exam\nple.com/",
      "https://example.com/\u0000",
      "https://example.com/a b",
      "https://example.com/\u007f",
    ]) {
      expect(parseWebLink(url), JSON.stringify(url)).toBeNull();
      expect(top(url), JSON.stringify(url)).toBe("refuse");
      expect(frame(url), JSON.stringify(url)).toBe("refuse");
    }
  });
});
