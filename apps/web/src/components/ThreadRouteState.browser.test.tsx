import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThreadRouteState } from "./ThreadRouteState";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe("thread route recovery", () => {
  it.each(["loading", "deleted", "no-access", "unavailable"] as const)(
    "renders %s with a working way back",
    async (state) => {
      const back = vi.fn();
      const retry = vi.fn();
      await act(() => root.render(<ThreadRouteState state={state} back={back} retry={retry} />));
      expect(container.textContent?.trim().length).toBeGreaterThan(0);
      const buttons = [...container.querySelectorAll("button")];
      await act(() => buttons.find((button) => button.textContent === "Back")!.click());
      expect(back).toHaveBeenCalledOnce();
      const retryButton = buttons.find((button) => button.textContent === "Retry");
      expect(Boolean(retryButton)).toBe(state === "loading" || state === "unavailable");
      if (retryButton) {
        await act(() => retryButton.click());
        expect(retry).toHaveBeenCalledOnce();
      }
    },
  );
});
