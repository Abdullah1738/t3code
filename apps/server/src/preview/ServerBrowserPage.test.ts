import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { presentAsChrome } from "./ServerBrowserContexts.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe("server browser element refs", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = () =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("reads a document.write page at about:blank without waiting for URL or load", async () => {
    await page.evaluate(
      "document.open(); document.write('<button>inline document</button>'); document.close()",
    );
    const result = await takeSnapshot();
    expect(result.url).toBe("about:blank");
    expect(result.accessibilityTree).toContain("inline document");
    expect(result.screenshot?.data).toBeTruthy();
  });

  it("returns text and refs even when screenshots cannot answer", async () => {
    await page.setContent("<button>loaded local content</button>");
    const send = vi.spyOn(cdp, "send");
    const result = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      captureImage: false,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    expect(result.accessibilityTree).toContain("loaded local content");
    expect(result.screenshot).toBeUndefined();
    expect(send.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
  });

  it("captures the new responsive layout immediately after resize and a DOM change", async () => {
    await page.setContent(
      `<style>body {margin:0;background:rgb(255,0,0)} @media(max-width:400px){body{background:rgb(0,0,255)}}</style><button>before</button>`,
    );
    await takeSnapshot();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate("document.querySelector('button').textContent = 'after'");
    const result = await takeSnapshot();
    expect(result.accessibilityTree).toContain("after");
    expect(result.screenshot).toMatchObject({ width: 390, height: 844 });
    const pixels = await page.evaluate(`(async () => {
      const image = await createImageBitmap(await (await fetch('data:image/png;base64,${result.screenshot!.data}')).blob());
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image,0,0);
      return [10,200,380].map(x => Array.from(ctx.getImageData(x,400,1,1).data));
    })()`);
    expect(pixels).toEqual([
      [0, 0, 255, 255],
      [0, 0, 255, 255],
      [0, 0, 255, 255],
    ]);
  });

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]!, timeoutMs: 1_000 });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
      timeoutMs: 1_000,
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("shows dotted fields as dots wherever their value appears, keeping text values and refs", async () => {
    await page.setContent(`
      <table><tr><td>password:</td><td><input id="pw" type="password" aria-label="Password"></td></tr></table>
      <input aria-label="Username" value="maria">
      <input type="password" aria-label='saved" [ref=e2]: x' placeholder="hint" value="saved-pass">
      <input type="password" role="combobox" aria-label="Code" value="role-pass">
      <input aria-label="PIN" style="-webkit-text-security: disc" value="styled-pass">
      <div contenteditable style="-webkit-text-security: disc">editable-pass</div>
      <iframe srcdoc="<input type=password aria-label=child value=frame-pass>"></iframe>
      <iframe id="blank" src="javascript:false"></iframe>
      <p>Order styled-pass-2</p>
      <script>
        // A frame that never commits a document, filled by its parent.
        blank.contentDocument.body.innerHTML = "<input type=password aria-label=blank value=blank-pass>";
        // Page script can't change the value the snapshot sees.
        Object.defineProperty(HTMLInputElement.prototype, "value", { get: () => "" });
      </script>`);
    await page.frameLocator("iframe[srcdoc]").getByRole("textbox").waitFor();
    await ServerBrowserPage.type(page, { locator: "#pw", text: "typed-pass" });
    const result = await takeSnapshot();
    const tree = String(result.accessibilityTree);
    expect(tree).toContain('textbox "blank"');
    expect(tree).not.toMatch(
      /typed-pass|saved-pass|role-pass|styled-pass|editable-pass|frame-pass|blank-pass/,
    );
    expect(result.visibleText).not.toContain("editable-pass");
    // Page text masks the same values, so it can't be compared against the tree.
    expect(result.visibleText).toContain("Order ••••••••-2");
    expect(tree).toMatch(/row "password: •+"/);
    expect(tree).toMatch(/textbox "Username" [^\n]*: maria$/m);
    const line = tree.split("\n").find((line) => line.includes('textbox "Password"'));
    expect(line).toMatch(/: •+$/);
    await ServerBrowserPage.type(page, { locator: locators(line)[0]!, text: "next", clear: true });
    expect(await page.locator("#pw").inputValue()).toBe("next");
  });

  it("masks dotted values in page text next to punctuation, with odd spaces, and at the cut", async () => {
    await page.setContent(`
      <input type="password" aria-label="PIN" value="123">
      <input type="password" aria-label="Phrase" value="open&nbsp;sesame">
      <p>PIN: 123. Code (123) id 1234</p>
      <p>open&nbsp;sesame</p>`);
    const text = (await takeSnapshot()).visibleText;
    expect(text).toContain("PIN: ••••••••. Code (••••••••) id 1234");
    expect(text).not.toMatch(/open|sesame/);
    await page.setContent(`
      <p>${"x".repeat(19_995)}long-secret</p>
      <input type="password" aria-label="Long" value="long-secret">`);
    const cut = (await takeSnapshot()).visibleText;
    expect(cut.length).toBe(20_000);
    // Masked before the cut, so no prefix of the value is left.
    expect(cut.slice(-8)).toBe("xxx•••••");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs on takeover and issues usable refs in the next snapshot", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    ServerBrowserPage.invalidateRefs(page);
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    const fresh = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await ServerBrowserPage.click(page, { locator: fresh });
    expect(await page.locator("button").textContent()).toBe("clicked");
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it("only accepts refs from the most recent snapshot", async () => {
    await page.setContent("<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await takeSnapshot();
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves CSS selectors containing an aria-ref attribute", async () => {
    await page.setContent(
      '<button aria-ref="save" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[aria-ref="save"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("right-clicks, double-clicks, hovers, selects, and drags like a pointer user", async () => {
    await page.setContent(`
      <style>#menu { position: absolute; display: none } #hover:hover + #menu { display: block }</style>
      <button id="target">target</button>
      <div id="hover">hover me</div><div id="menu">menu item</div>
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <div id="card" draggable="true">card</div><div id="lane" style="height:40px">lane</div>
      <p id="log"></p>
      <script>
        const log = (text) => (document.getElementById("log").textContent += text + ";");
        const target = document.getElementById("target");
        target.addEventListener("contextmenu", (event) => { event.preventDefault(); log("context"); });
        target.addEventListener("dblclick", () => log("dblclick"));
        document.getElementById("card").addEventListener("dragstart", (event) =>
          event.dataTransfer.setData("text/plain", "card"),
        );
        for (const type of ["dragenter", "dragover"])
          document.getElementById("lane").addEventListener(type, (event) => event.preventDefault());
        document.getElementById("lane").addEventListener("drop", () => log("drop"));
      </script>`);
    await ServerBrowserPage.click(page, { locator: "#target", button: "right" });
    await ServerBrowserPage.click(page, { locator: "#target", clickCount: 2 });
    await ServerBrowserPage.hover(page, { locator: "#hover" });
    expect(await page.isVisible("#menu")).toBe(true);
    expect(await ServerBrowserPage.select(page, { locator: "#size", values: ["Large"] })).toEqual({
      selected: ["l"],
    });
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" });
    expect(await page.textContent("#log")).toBe("context;dblclick;drop;");
    await expect(
      ServerBrowserPage.select(page, { locator: "#target", values: ["s"] }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTargetNotEditableError" });
  });

  it("shows the agent's pointer at each target before the action reaches the page", async () => {
    await page.setContent(`
      <button id="go" style="position:absolute;left:100px;top:40px;width:80px;height:20px">go</button>
      <div id="tip" style="position:absolute;left:300px;top:40px;width:60px;height:20px">tip</div>
      <div id="card" draggable="true" style="position:absolute;left:20px;top:120px;width:40px;height:40px">card</div>
      <div id="lane" style="position:absolute;left:220px;top:120px;width:100px;height:40px">lane</div>
      <script>
        window.seen = [];
        go.onclick = () => seen.push("click");
        tip.onmouseenter = () => seen.push("hover");
        card.ondragstart = (event) => event.dataTransfer.setData("text/plain", "card");
        lane.ondragover = (event) => event.preventDefault();
        lane.ondrop = () => seen.push("drop");
      </script>`);
    const shown: Array<string> = [];
    const pointer: ServerBrowserPage.PointerReporter = async ({ x, y }, phase) => {
      const seen = await page.evaluate("window.seen.length");
      shown.push(`${phase}@${Math.round(x)},${Math.round(y)} after ${seen}`);
    };
    await ServerBrowserPage.click(page, { locator: "#go" }, pointer);
    await ServerBrowserPage.hover(page, { locator: "#tip" }, pointer);
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }, pointer);
    expect(shown).toEqual([
      "click@140,50 after 0",
      "move@330,50 after 1",
      "move@40,140 after 2",
      "move@270,140 after 2",
    ]);
    expect(await page.evaluate("window.seen")).toEqual(["click", "hover", "drop"]);
  });

  it("presents a headless page as Chrome, with client hints that agree", async () => {
    await presentAsChrome(cdp, { platform: "linux", arch: "x64" });
    // userAgentData exists only in secure contexts; https comes from a route.
    let secChUa: string | undefined;
    await page.route("https://example.test/", (route) => {
      secChUa = route.request().headers()["sec-ch-ua"];
      return route.fulfill({ contentType: "text/html", body: "<p>hi</p>" });
    });
    await page.goto("https://example.test/");
    const identity = (await page.evaluate(`(async () => ({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData.brands.map((brand) => brand.brand),
      full: (await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]))
        .fullVersionList.map((brand) => brand.brand),
    }))()`)) as { userAgent: string; brands: string[]; full: string[] };
    expect(identity.userAgent).not.toContain("Headless");
    expect(identity.userAgent).toMatch(/ Chrome\/\d+\.0\.0\.0 /);
    expect(identity.brands).toContain("Google Chrome");
    expect([...identity.brands, ...identity.full].join()).not.toContain("Headless");
    expect(secChUa).toContain('"Google Chrome"');
    expect(secChUa).not.toContain("Headless");
  });

  it("stops an evaluation at its deadline so the page answers the next one", async () => {
    await expect(
      ServerBrowserPage.evaluate(cdp, { expression: "for (;;) {}" }, 200),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    expect(await ServerBrowserPage.evaluate(cdp, { expression: "1 + 1" }, 2_000)).toBe(2);
  });
});

describe("server browser snapshot screenshot", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    // ServerBrowserContexts launches with these, and the capture scale depends on them.
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--force-device-scale-factor=2"],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
  });
  afterEach(async () => {
    await context.close();
  });

  // Blue on the left half and red on the right, so a mirrored left half shows up on the right.
  const halves = (overlay: string) => `
    <style>
      body { margin: 0; background: white; }
      .half { position: absolute; top: 0; width: 640px; height: 800px; }
      .overlay { position: fixed; inset: 0; ${overlay} }
    </style>
    <div class="half" style="left: 0; background: #2563eb"></div>
    <div class="half" style="left: 640px; background: #ef4444"></div>
    <div class="overlay"></div>`;

  const screenshotOf = async (html: string) => {
    const page = await context.newPage();
    await page.setContent(html);
    const { screenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    // The server has no DOM types, so the decoder runs as page source.
    const points = [
      [0.15, 0.75],
      [0.85, 0.25],
      [0.85, 0.75],
    ];
    const pixels = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(screenshot!.data)}), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return ${JSON.stringify(points)}.map(([x, y]) =>
        Array.from(context.getImageData(x * bitmap.width, y * bitmap.height, 1, 1).data),
      );
    })()`)) as Array<[number, number, number, number]>;
    return { screenshot, pixels };
  };
  const colorOf = ([red, green, blue]: readonly [number, number, number, number]) =>
    blue - red > 100 ? "blue" : red - blue > 100 ? "red" : `rgb(${red}, ${green}, ${blue})`;

  it("captures a blurred backdrop-filter page as rendered, not mirrored", async () => {
    const { screenshot, pixels } = await screenshotOf(halves("backdrop-filter: blur(4px);"));

    expect({
      size: [screenshot!.width, screenshot!.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], colors: ["blue", "red", "red"] });
  });

  it("captures a plain page at the shrunk size with its content in place", async () => {
    const { screenshot, pixels } = await screenshotOf(halves(""));

    expect({
      size: [screenshot!.width, screenshot!.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], colors: ["blue", "red", "red"] });
  });

  it("shrinks the screenshot of an XML document, whose createElement makes no canvas", async () => {
    const page = await context.newPage();
    await page.goto("data:text/xml,<a/>");
    const { screenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });

    expect([screenshot!.width, screenshot!.height]).toEqual([1280, 800]);
  });
});

describe("server browser drag", () => {
  it("fails the drag, not the server, when it times out while the cursor is still moving", async () => {
    const timedOut = new Error("locator.dragTo: Timeout 30000ms exceeded.");
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const targetBox = Promise.withResolvers<typeof box>();
    const page = {
      locator: (selector: string) =>
        selector === "#card"
          ? {
              scrollIntoViewIfNeeded: async () => {},
              boundingBox: async () => box,
              dragTo: () => Promise.reject(timedOut),
            }
          : { boundingBox: () => targetBox.promise },
    } as unknown as Page;
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const settled = ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }).then(
        () => null,
        (error: unknown) => error,
      );
      void settled.then(() => (finished = true));
      // Two macrotask turns: Node reports a rejection nobody observed after the first.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      targetBox.resolve(box);

      expect(await settled).toBe(timedOut);
      expect(unobserved).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

it("captures the native display viewport after page script reassigns the globals", async () => {
  // Context deviceScaleFactor changes DPR but does not scale raw CDP captures.
  const browser = await chromium.launch({
    headless: true,
    args: ["--force-device-scale-factor=1.5", "--window-size=1280,800"],
  });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.setContent(
      "<script>devicePixelRatio = -1.5; innerWidth = 99999; innerHeight = 1e7;</script>",
    );
    expect(await page.evaluate("[devicePixelRatio, innerWidth, innerHeight]")).toEqual([
      -1.5, 99999, 1e7,
    ]);
    const snapshotSize = async () => {
      const { screenshot } = await ServerBrowserPage.snapshot({
        page,
        cdp,
        renderScale: "display",
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      });
      const png = Buffer.from(screenshot!.data, "base64");
      const size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      expect(screenshot).toMatchObject(size);
      return size;
    };
    expect(await snapshotSize()).toEqual({ width: 1280, height: 800 });
    expect(await ServerBrowserPage.readPageMetrics(cdp)).toEqual({
      ratio: 1.5,
      width: 1280,
      height: 800,
      zoom: 1,
    });
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    // CDP acknowledges the bounds change before the renderer applies the resize.
    const resize = await page.evaluateHandle(`({
      done: new Promise(resolve => window.addEventListener("resize", () => resolve(), { once: true })),
    })`);
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: 390, height: 844 },
    });
    await resize.evaluate("resize => resize.done");
    await resize.dispose();
    expect(await snapshotSize()).toEqual({ width: 585, height: 1266 });
  } finally {
    await browser.close();
  }
});

describe("snapshot stage deadlines", () => {
  afterEach(() => vi.useRealTimers());

  it("names a stalled renderer metrics read at its real cutoff", async () => {
    vi.useFakeTimers();
    const cdp = { send: () => new Promise(() => {}) } as unknown as CDPSession;
    const pending = ServerBrowserPage.snapshot({
      page: {} as Page,
      cdp,
      renderScale: "display",
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { timeoutMs: 2_000 },
    });
    expect((await pending).message).toContain("viewport metrics");
  });

  it.each([false, true])(
    "names a stalled accessibility tree on the no-image path (native timeout=%s)",
    async (nativeTimeout) => {
      vi.useFakeTimers();
      const page = {
        on: () => {},
        frames: () => [page],
        mainFrame: () => page,
        evaluate: async () => ({
          url: "http://local.test/",
          title: "loaded",
          loading: false,
          visibleText: "loaded",
          interactiveElements: [],
        }),
        ariaSnapshot: () =>
          nativeTimeout
            ? Promise.reject(
                Object.assign(new Error("page.ariaSnapshot: Timeout 8000ms exceeded"), {
                  name: "TimeoutError",
                }),
              )
            : new Promise(() => {}),
      } as unknown as Page;
      const cdp = {
        send: async (method: string) => {
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
          return { result: { value: [] } };
        },
      } as unknown as CDPSession;
      const pending = ServerBrowserPage.snapshot({
        page,
        cdp,
        captureImage: false,
        renderScale: 1,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await pending).message).toContain("accessibility tree did not answer");
      expect((await pending).detail).toEqual({ timeoutMs: 8_000 });
    },
  );

  it("names the absence of a fresh background paint without issuing a screenshot", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const cdp = {
      send: async (method: string) => {
        sent.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        return new Promise(() => {});
      },
    } as unknown as CDPSession;
    const pending = ServerBrowserPage.captureViewport(cdp, { format: "png" }).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).message).toContain("No fresh paint");
    expect((await pending).detail).toEqual({ timeoutMs: 2_000 });
    expect(sent).not.toContain("Page.captureScreenshot");
  });
});

it.each([1, 1.5, 0.8])("waits for the renderer's applied CSS viewport at zoom %s", async (zoom) => {
  vi.useFakeTimers();
  let width = 1280;
  let settled = false;
  const cdp = {
    send: async (method: string, params?: { expression?: string }) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { zoom } };
      return {
        result: {
          value: params?.expression?.startsWith("new Promise")
            ? true
            : { ratio: 1, width, height: 844 },
        },
      };
    },
  } as unknown as CDPSession;
  try {
    const pending = ServerBrowserPage.waitForViewport(cdp, { width: 390, height: 844 }).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    width = 390;
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual({ width: 390, height: 844 });
  } finally {
    vi.useRealTimers();
  }
});

it("rereads fill dimensions after the paint boundary", async () => {
  let width = 1280;
  const cdp = {
    send: async (method: string, params?: { expression?: string }) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { zoom: 1.5 } };
      if (params?.expression?.startsWith("new Promise")) {
        width = 390;
        return { result: { value: true } };
      }
      return { result: { value: { ratio: 1.5, width, height: 844 } } };
    },
  } as unknown as CDPSession;
  expect(await ServerBrowserPage.waitForViewport(cdp, null)).toEqual({ width: 390, height: 844 });
});

it("does not issue a late screenshot after a timed-out paint setup answers", async () => {
  vi.useFakeTimers();
  const lateTree = Promise.withResolvers<{ frameTree: { frame: { id: string } } }>();
  const sent: string[] = [];
  let frameTrees = 0;
  const page = {
    viewportSize: () => ({ width: 1280, height: 800 }),
    on: () => {},
    frames: () => [page],
    mainFrame: () => page,
    evaluate: async () => ({
      url: "about:blank",
      title: "inline",
      loading: false,
      visibleText: "inline",
      interactiveElements: [],
    }),
    ariaSnapshot: async () => '- button "inline" [ref=e1]',
  } as unknown as Page;
  const cdp = {
    send: async (method: string) => {
      sent.push(method);
      if (method === "Page.getFrameTree") {
        if (++frameTrees === 2) return lateTree.promise;
        return { frameTree: { frame: { id: "main" } } };
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      return { result: { value: [] } };
    },
  } as unknown as CDPSession;
  try {
    const pending = ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).message).toContain("No fresh paint");
    lateTree.resolve({ frameTree: { frame: { id: "main" } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).not.toContain("Page.captureScreenshot");
    expect(sent.filter((method) => method === "Page.createIsolatedWorld")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["Page.getFrameTree", "Page.createIsolatedWorld"])(
  "bounds the whole paint setup when %s does not answer",
  async (stuck) => {
    vi.useFakeTimers();
    const cdp = {
      send: async (method: string) => {
        if (method === stuck) return new Promise(() => {});
        return { frameTree: { frame: { id: "main" } } };
      },
    } as unknown as CDPSession;
    try {
      const pending = ServerBrowserPage.waitForPaint(cdp).catch((error) => error);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).message).toContain("No fresh paint");
      expect((await pending).detail).toEqual({ timeoutMs: 2_000 });
    } finally {
      vi.useRealTimers();
    }
  },
);

it("waits for the desktop to acknowledge fill and the guest to reach its target dimensions", async () => {
  vi.useFakeTimers();
  let mode = "freeform";
  let width = 1280;
  let settled = false;
  const cdp = {
    send: async (method: string, params?: { expression?: string }) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { zoom: 1 }, t3Viewport: { mode, width: 390, height: 844 } };
      return {
        result: {
          value: params?.expression?.startsWith("new Promise")
            ? true
            : { ratio: 1, width, height: 844 },
        },
      };
    },
  } as unknown as CDPSession;
  try {
    const pending = ServerBrowserPage.waitForViewport(cdp, null, true).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(75);
    expect(settled).toBe(false);
    mode = "fill";
    await vi.advanceTimersByTimeAsync(25);
    expect(settled).toBe(false);
    width = 390;
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual({ width: 390, height: 844 });
  } finally {
    vi.useRealTimers();
  }
});

it("names a missing desktop fill acknowledgment instead of accepting the previous dimensions", async () => {
  vi.useFakeTimers();
  const cdp = {
    send: async (method: string) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { zoom: 1 } };
      return { result: { value: { ratio: 1, width: 1280, height: 800 } } };
    },
  } as unknown as CDPSession;
  try {
    const pending = ServerBrowserPage.waitForViewport(cdp, null, true).catch((error) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).message).toContain("waiting for desktop layout acknowledgment");
    expect((await pending).detail).toEqual({ timeoutMs: 2_000 });
  } finally {
    vi.useRealTimers();
  }
});
