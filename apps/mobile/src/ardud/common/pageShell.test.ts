import { describe, expect, it } from "vite-plus/test";

import {
  PAGE_SHELL_CSP,
  PAGE_SHELL_SANDBOX,
  newPageToken,
  pageShell,
  pageThemeScript,
  readPageMessage,
} from "./pageShell";

const TOKEN = "0123456789abcdef0123456789abcdef";

/** The frame's `srcdoc` as the HTML parser would hand it to the frame. */
const srcdocOf = (shell: string): string => {
  const raw = /<iframe [^>]*srcdoc="([^"]*)"/.exec(shell)?.[1];
  if (raw === undefined) throw new Error("no srcdoc");
  return raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
};
/** The shell with the page taken out: what the app itself wrote. */
const ownOf = (shell: string): string => shell.replace(/srcdoc="[^"]*"/, 'srcdoc=""');
const sent = (m: unknown, k: unknown = TOKEN) => JSON.stringify({ k, m });

describe("the shell a page is drawn in", () => {
  it("gives the page's frame scripts and nothing else", () => {
    expect(PAGE_SHELL_SANDBOX).toBe("allow-scripts");
    const shell = pageShell({ html: "<p>Hi</p>", token: TOKEN });
    expect(shell).toContain('sandbox="allow-scripts"');
    for (const more of [
      "allow-top-navigation",
      "allow-forms",
      "allow-popups",
      "allow-same-origin",
      "allow-modals",
      "allow-downloads",
    ]) {
      expect(shell).not.toContain(more);
    }
    // One frame, and it is the only way the page is loaded.
    expect(shell.match(/<iframe /g)).toHaveLength(1);
  });

  it("forbids form posts, a re-pointed base, and frames that are not the page's own text", () => {
    expect(PAGE_SHELL_CSP).toBe("form-action 'none'; base-uri 'none'; frame-src about: data:");
    const shell = pageShell({ html: "<p>Hi</p>", token: TOKEN });
    expect(shell).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${PAGE_SHELL_CSP}">`,
    );
    // The policy is in force before the frame is parsed.
    expect(shell.indexOf("Content-Security-Policy")).toBeLessThan(shell.indexOf("<iframe "));
    // No web address may fill a frame.
    expect(PAGE_SHELL_CSP).not.toMatch(/https?:|\*/);
  });

  it("keeps the page inside the frame's srcdoc, whatever the page's text is", () => {
    const hostile = `"></iframe><script>window.ReactNativeWebView.postMessage("x")</script><iframe srcdoc="&quot;`;
    const shell = pageShell({ html: hostile, token: TOKEN, title: `T" onload="x` });
    // The parser gives the frame the page's text back whole...
    expect(srcdocOf(shell).startsWith(hostile)).toBe(true);
    // ...and nothing of it is part of the shell: one frame, one script (the shell's own).
    const own = ownOf(shell);
    expect(own.match(/<iframe /g)).toHaveLength(1);
    expect(own.match(/<script>/g)).toHaveLength(1);
    expect(own).not.toContain('postMessage("x")');
    expect(own).toContain('title="T&quot; onload=&quot;x"');
  });

  it("passes on only what comes from the page's own frame, marked with the token", () => {
    const own = ownOf(pageShell({ html: "<p>Hi</p>", token: TOKEN }));
    expect(own).toContain("e.source!==f.contentWindow");
    expect(own).toContain(JSON.stringify(TOKEN));
    // The token is the shell's alone: it is not in what the page is given.
    expect(srcdocOf(pageShell({ html: "<p>Hi</p>", token: TOKEN }))).not.toContain(TOKEN);
  });

  it("turns a tap on a link into a message, so the frame never navigates", () => {
    const page = srcdocOf(pageShell({ html: "<a href='https://example.com'>x</a>", token: TOKEN }));
    expect(page).toContain("e.preventDefault()");
    expect(page).toContain('"ui/open-link"');
  });

  it("hands the theme to the shell, which passes it to the page", () => {
    expect(pageThemeScript({ theme: "dark" })).toBe(
      'window.__robobPage&&window.__robobPage.theme({"theme":"dark"});true;',
    );
  });

  it("makes a new token for every page", () => {
    const tokens = new Set(Array.from({ length: 50 }, newPageToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("what a page told the app", () => {
  it("is read when it came through the shell: a height, a value, a link", () => {
    expect(readPageMessage(sent({ t: "height", height: 212 }), TOKEN)).toEqual({
      _tag: "height",
      height: 212,
    });
    expect(readPageMessage(sent({ t: "value", value: { cap: 25 } }), TOKEN)).toEqual({
      _tag: "value",
      value: { cap: 25 },
    });
    expect(readPageMessage(sent({ t: "value", value: null }), TOKEN)).toEqual({
      _tag: "value",
      value: null,
    });
    expect(readPageMessage(sent({ t: "link", url: "HTTPS://Example.com/a?b=1" }), TOKEN)).toEqual({
      _tag: "link",
      url: "https://example.com/a?b=1",
    });
  });

  it("is dropped without this shell's token: the page reached the bridge by itself", () => {
    // On Android the bridge object is visible inside the page's frame too.
    for (const raw of [
      JSON.stringify({ type: "robob.ask.value", value: 25 }),
      JSON.stringify({ t: "value", value: 25 }),
      sent({ t: "value", value: 25 }, "another-token"),
      JSON.stringify({ m: { t: "value", value: 25 } }),
      sent({ t: "value", value: 25 }, null),
      sent({ t: "height", height: 9000 }, ""),
    ]) {
      expect(readPageMessage(raw, TOKEN), raw).toBeNull();
    }
    expect(readPageMessage(sent({ t: "value", value: 25 }, ""), "")).toBeNull();
  });

  it("is dropped when it is anything else", () => {
    for (const m of [
      { t: "height", height: "tall" },
      { t: "height", height: -1 },
      { t: "height", height: null },
      { t: "value" },
      { t: "open", url: "https://example.com" },
      { t: "link", url: "robob://needs-you/history" },
      { t: "link", url: "javascript:alert(1)" },
      { t: "link", url: "https://user:pw@example.com" },
      { t: "link", url: 7 },
      "text",
      null,
      7,
    ]) {
      expect(readPageMessage(sent(m), TOKEN), JSON.stringify(m)).toBeNull();
    }
    expect(readPageMessage("not json", TOKEN)).toBeNull();
    expect(readPageMessage(JSON.stringify("text"), TOKEN)).toBeNull();
  });
});
