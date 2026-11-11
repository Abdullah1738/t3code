import { describe, expect, it } from "vite-plus/test";

import { isWebAddress, pageLinkHost, pageNavigation } from "./pageNavigation";

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
    expect(isWebAddress("https://example.com")).toBe(true);
    expect(isWebAddress("https:")).toBe(false);
    expect(isWebAddress("https:///nohost")).toBe(false);
    expect(top("https:robob://x")).toBe("refuse");
    expect(top("https:///nohost")).toBe("refuse");
  });

  it("names the site a link really leads to", () => {
    expect(pageLinkHost("https://www.example.com/path")).toBe("example.com");
    expect(pageLinkHost("https://apple.com@evil.test/login")).toBe("evil.test");
    expect(pageLinkHost("robob://x")).toBe("");
  });
});
