import { describe, expect, it } from "vite-plus/test";
import type { AssistantTextSelector } from "@t3tools/shared/assistantTextSelection";

import { captureAssistantTextSelection } from "./assistantTextSelection";

function selector(
  text: string,
  overrides: Partial<Omit<AssistantTextSelector, "text">> = {},
): AssistantTextSelector {
  return {
    text,
    start: 0,
    end: text.replace(/\s+/g, " ").length,
    prefix: "",
    suffix: "",
    ...overrides,
  };
}

class SelectionNode {
  parentElement: SelectionNode | null = null;
  childNodes: SelectionNode[] = [];

  constructor(
    readonly tagName: string,
    readonly data = "",
    readonly attributes: Record<string, string> = {},
  ) {}

  get nodeType() {
    return this.tagName === "#text" ? 3 : 1;
  }
  get ownerDocument() {
    // `user-select: none` inherits, like Chromium's computed style.
    const getComputedStyle = (element: SelectionNode) => ({
      userSelect: element.closest("[data-select-none]") ? "none" : "auto",
    });
    return { defaultView: { getComputedStyle } };
  }
  get length() {
    return this.data.length;
  }
  get firstChild(): SelectionNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): SelectionNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get previousSibling(): SelectionNode | null {
    const siblings = this.parentElement?.childNodes;
    return siblings?.[siblings.indexOf(this) - 1] ?? null;
  }
  get nextSibling(): SelectionNode | null {
    const siblings = this.parentElement?.childNodes;
    return siblings?.[siblings.indexOf(this) + 1] ?? null;
  }
  append(...children: SelectionNode[]) {
    for (const child of children) child.parentElement = this;
    this.childNodes.push(...children);
    return this;
  }
  contains(node: SelectionNode): boolean {
    return node === this || this.childNodes.some((child) => child.contains(node));
  }
  matches(selector: string) {
    return selector.split(", ").some((part) => {
      if (!part.startsWith("[")) return part === this.tagName.toLowerCase();
      const [attribute, value] = part.slice(1, -1).split("=");
      return (
        Object.hasOwn(this.attributes, attribute!) &&
        (value === undefined || this.attributes[attribute!] === value)
      );
    });
  }
  closest(selector: string): SelectionNode | null {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null);
  }
}

function textNode(text: string) {
  return new SelectionNode("#text", text);
}

function assistantSource(...children: SelectionNode[]) {
  return new SelectionNode("DIV", "", { "data-assistant-citation-source": "assistant" }).append(
    ...children,
  );
}

function nativeSelection(
  start: [SelectionNode, number],
  end: [SelectionNode, number],
  backwards = false,
) {
  let root = start[0];
  while (root.parentElement !== null) root = root.parentElement;
  // Give every DOM boundary its own position, including element boundaries
  // immediately before text offset 0 and after its final character.
  const positions = new Map<SelectionNode, number[]>();
  let position = 0;
  const index = (node: SelectionNode) => {
    const offsets = [position++];
    positions.set(node, offsets);
    if (node.nodeType === 3) {
      for (let offset = 0; offset < node.length; offset++) offsets.push(position++);
    } else {
      for (const child of node.childNodes) {
        index(child);
        offsets.push(position++);
      }
    }
  };
  index(root);
  const at = (node: SelectionNode, offset: number) => positions.get(node)![offset]!;

  class SelectionRange {
    constructor(
      public startContainer: SelectionNode,
      public startOffset: number,
      public endContainer: SelectionNode,
      public endOffset: number,
    ) {}
    get collapsed() {
      return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    }
    get commonAncestorContainer() {
      let ancestor = this.startContainer;
      while (!ancestor.contains(this.endContainer)) ancestor = ancestor.parentElement!;
      return ancestor;
    }
    cloneRange() {
      return new SelectionRange(
        this.startContainer,
        this.startOffset,
        this.endContainer,
        this.endOffset,
      );
    }
    setStart(node: SelectionNode, offset: number) {
      this.startContainer = node;
      this.startOffset = offset;
    }
    setEnd(node: SelectionNode, offset: number) {
      this.endContainer = node;
      this.endOffset = offset;
    }
    intersectsNode(node: SelectionNode) {
      const parent = node.parentElement;
      if (parent === null) return true;
      const offset = parent.childNodes.indexOf(node);
      return (
        at(parent, offset) < at(this.endContainer, this.endOffset) &&
        at(parent, offset + 1) > at(this.startContainer, this.startOffset)
      );
    }
  }

  const range = new SelectionRange(...start, ...end);
  const anchor = backwards ? end : start;
  const focus = backwards ? start : end;
  return {
    isCollapsed: range.collapsed,
    rangeCount: 1,
    anchorNode: anchor[0],
    anchorOffset: anchor[1],
    focusNode: focus[0],
    focusOffset: focus[1],
    getRangeAt: () => range,
  } as unknown as Selection;
}

function capture(viewport: SelectionNode, selection: Selection) {
  return captureAssistantTextSelection(viewport as unknown as HTMLElement, selection);
}

describe("captureAssistantTextSelection", () => {
  it.each([
    { boundary: "next text", backwards: false },
    { boundary: "next block", backwards: false },
    { boundary: "parent", backwards: false },
    { boundary: "next text", backwards: true },
    { boundary: "next block", backwards: true },
    { boundary: "parent", backwards: true },
  ])(
    "captures a paragraph ending at $boundary, backwards=$backwards",
    ({ boundary, backwards }) => {
      const quote = textNode("A paragraph 😀 cafe\u0301.");
      const source = assistantSource(new SelectionNode("P").append(quote));
      const nextText = textNode("Another response.");
      const nextBlock = assistantSource(new SelectionNode("P").append(nextText));
      const viewport = new SelectionNode("MAIN").append(source, nextBlock);
      const end: [SelectionNode, number] =
        boundary === "next text"
          ? [nextText, 0]
          : boundary === "next block"
            ? [nextBlock, 0]
            : [viewport, 1];
      const selection = nativeSelection([quote, 0], end, backwards);
      const captured = capture(viewport, selection);

      expect(captured?.source).toBe(source);
      expect(captured?.selector).toEqual(selector(quote.data));
      expect(captured?.range.endContainer).toBe(quote);
      expect(captured?.range.endOffset).toBe(quote.length);
      expect(selection.getRangeAt(0).endContainer).toBe(end[0]);
      expect(selection.getRangeAt(0).endOffset).toBe(end[1]);
    },
  );

  it("finds the source when both endpoints are parent boundaries", () => {
    const quote = textNode("Only this response.");
    const source = assistantSource(new SelectionNode("P").append(quote));
    const viewport = new SelectionNode("MAIN").append(source, assistantSource(textNode("Next.")));
    expect(capture(viewport, nativeSelection([viewport, 0], [viewport, 1]))?.selector).toEqual(
      selector(quote.data),
    );
  });

  it("captures the final paragraph when Chromium extends to the timestamp paragraph boundary", () => {
    const quote = textNode("The final paragraph.");
    const source = assistantSource(
      new SelectionNode("P").append(textNode("Earlier answer.")),
      new SelectionNode("P").append(quote),
    );
    const timestampText = textNode("1:50 AM");
    const timestamp = new SelectionNode("P").append(timestampText);
    new SelectionNode("MAIN").append(
      new SelectionNode("DIV").append(source, new SelectionNode("DIV").append(timestamp)),
    );
    const selection = nativeSelection([quote, 0], [timestamp, 0]);
    selection.toString = () => `${quote.data}\n\n\n`;

    expect(capture(source, selection)?.selector).toEqual(
      selector(quote.data, {
        start: "Earlier answer. ".length,
        end: "Earlier answer. The final paragraph.".length,
        prefix: "Earlier answer. ",
      }),
    );
    expect(capture(source, nativeSelection([quote, 0], [timestampText, 1]))).toBeNull();
  });

  it("captures a triple-clicked response that ends before a tool row and the next response", () => {
    const quote = textNode("Recording your answers in the session note:");
    const source = assistantSource(new SelectionNode("P").append(quote));
    const nextParagraph = new SelectionNode("P").append(textNode("1. What it means."));
    const viewport = new SelectionNode("MAIN").append(
      source,
      new SelectionNode("DIV", "", { "data-select-none": "" }).append(textNode("echo ok")),
      new SelectionNode("H3", "", { "data-select-none": "" }).append(textNode("T3 Code")),
      assistantSource(nextParagraph),
    );

    expect(capture(viewport, nativeSelection([quote, 0], [nextParagraph, 0]))?.selector).toEqual(
      selector(quote.data),
    );
  });

  it("does not attribute an empty starting endpoint to the previous response", () => {
    const previous = textNode("Previous response.");
    const quote = textNode("Selected response.");
    const source = assistantSource(quote);
    const viewport = new SelectionNode("MAIN").append(assistantSource(previous), source);
    const captured = capture(
      viewport,
      nativeSelection([previous, previous.length], [quote, quote.length]),
    );
    expect(captured?.source).toBe(source);
    expect(captured?.selector).toEqual(selector(quote.data));
  });

  it.each([false, true])(
    "rejects actual overlap with another response, backwards=%s",
    (backwards) => {
      const first = textNode("Repeated quote.");
      const second = textNode(first.data);
      const viewport = new SelectionNode("MAIN").append(
        assistantSource(first),
        assistantSource(second),
      );
      expect(capture(viewport, nativeSelection([first, 0], [second, 1], backwards))).toBeNull();
    },
  );

  it("accepts a control endpoint only when none of its text is selected", () => {
    const quote = textNode("A paragraph.");
    const control = textNode("Copy");
    const source = assistantSource(
      new SelectionNode("P").append(quote),
      new SelectionNode("BUTTON").append(control),
    );
    expect(capture(source, nativeSelection([quote, 0], [control, 0]))?.selector).toEqual(
      selector(quote.data),
    );
    expect(capture(source, nativeSelection([quote, 0], [control, 1]))).toBeNull();
  });

  it.each([
    new SelectionNode("BUTTON"),
    new SelectionNode("SPAN", "", { role: "button" }),
    new SelectionNode("DIV", "", { contenteditable: "true" }),
    new SelectionNode("SPAN", "", { hidden: "" }),
    new SelectionNode("SPAN", "", { "aria-hidden": "true" }),
  ])("rejects selected text at excluded endpoints: %j", (excluded) => {
    const quote = textNode("A paragraph.");
    const control = textNode("Excluded");
    const source = assistantSource(quote, excluded.append(control));
    expect(capture(source, nativeSelection([quote, 0], [control, 1]))).toBeNull();
    expect(capture(source, nativeSelection([control, 0], [control, control.length]))).toBeNull();
  });

  it("keeps exact multiline Unicode text and omits interior controls and hidden text", () => {
    const first = textNode("Before 😀 ");
    const code = textNode("first line\r\n  second line\t🚀");
    const source = assistantSource(
      new SelectionNode("P").append(first, new SelectionNode("EM").append(textNode("cafe\u0301"))),
      new SelectionNode("BUTTON").append(textNode("Copy")),
      new SelectionNode("SPAN", "", { hidden: "" }).append(textNode("Hidden")),
      new SelectionNode("PRE").append(new SelectionNode("CODE").append(code)),
    );
    expect(
      capture(source, nativeSelection([first, 0], [code, code.length], true))?.selector,
    ).toEqual(selector("Before 😀 cafe\u0301\nfirst line\r\n  second line\t🚀"));
  });

  it("rejects a source outside the supplied viewport", () => {
    const quote = textNode("Outside.");
    assistantSource(quote);
    expect(
      capture(new SelectionNode("MAIN"), nativeSelection([quote, 0], [quote, quote.length])),
    ).toBeNull();
  });
});
