import { create } from "zustand";

const STORAGE_KEY = "robob:needs-you:single-keys";

const read = (): boolean => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
};

/** Whether one-letter shortcuts (A, X, S, 1 to 9...) act. Arrows and Escape always do. */
export const useSingleKeys = create<{ readonly on: boolean }>(() => ({ on: read() }));

export function setSingleKeys(on: boolean) {
  useSingleKeys.setState({ on });
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private mode: the choice lasts for this visit only.
  }
}
