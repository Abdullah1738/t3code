import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

interface TextProps {
  readonly children?: ReactNode;
  readonly numberOfLines?: number;
  readonly "aria-hidden"?: boolean;
  readonly onTextLayout?: (event: { nativeEvent: { lines: ReadonlyArray<unknown> } }) => void;
}

const texts = vi.hoisted(() => [] as TextProps[]);

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
    onPress: () => void;
  }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      aria-expanded={props.accessibilityState?.expanded}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
  Linking: { openURL: async () => {} },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: TextProps) => {
    texts.push(props);
    return <span data-lines={props.numberOfLines ?? "all"}>{props.children}</span>;
  },
  AppTextInput: () => null,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/ControlPill", () => ({ ControlPill: () => null }));

import { FoldText } from "./parts";

const TEXT = "Built and pushed in the Robob fork. It needs a signed build plus a restart.";
const OTHER = "A restart interrupts every running lane turn and background helper.";

let host: HTMLDivElement;
let root: Root;

const render = (text = TEXT) =>
  act(() =>
    root.render(
      <FoldText text={text} lines={4} className="text-[15px] leading-6 text-foreground" />,
    ),
  );

/** The latest render of the shown text and of its hidden unclamped copy. */
const latest = () => {
  const shown = texts.findLast(
    (props) => props["aria-hidden"] !== true && [TEXT, OTHER].includes(props.children as string),
  )!;
  const copy = texts.findLast((props) => props["aria-hidden"] === true)!;
  return { shown, copy };
};

const layOut = (lineCount: number) =>
  act(() =>
    latest().copy.onTextLayout!({ nativeEvent: { lines: Array.from({ length: lineCount }) } }),
  );

const toggle = () => host.querySelector<HTMLButtonElement>("button");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  texts.length = 0;
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("clamps text the hidden copy lays out past the fold and opens it with Show all", () => {
  render();
  expect(latest().shown.numberOfLines).toBe(4);
  expect(latest().copy.numberOfLines).toBeUndefined();
  expect(toggle()).toBeNull();

  layOut(9);
  expect(toggle()?.getAttribute("aria-label")).toBe("Show all");
  expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

  act(() => toggle()!.click());
  expect(latest().shown.numberOfLines).toBeUndefined();
  expect(toggle()?.getAttribute("aria-label")).toBe("Show less");
  expect(toggle()?.getAttribute("aria-expanded")).toBe("true");

  act(() => toggle()!.click());
  expect(latest().shown.numberOfLines).toBe(4);
});

it("shows no Show all when the text fits", () => {
  render();
  layOut(4);
  expect(toggle()).toBeNull();
});

it("drops the toggle when the open text fits after a rotation", () => {
  render();
  layOut(6);
  act(() => toggle()!.click());
  layOut(3);
  expect(toggle()).toBeNull();
});

it("folds replacement text again instead of keeping the old text open", () => {
  render();
  layOut(9);
  act(() => toggle()!.click());
  expect(latest().shown.numberOfLines).toBeUndefined();

  render(OTHER);
  expect(latest().shown.children).toBe(OTHER);
  expect(latest().shown.numberOfLines).toBe(4);
  expect(toggle()).toBeNull();
  layOut(7);
  expect(toggle()?.getAttribute("aria-label")).toBe("Show all");
  expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

  act(() => toggle()!.click());
  render(TEXT);
  layOut(2);
  expect(latest().shown.numberOfLines).toBe(4);
  expect(toggle()).toBeNull();
});
