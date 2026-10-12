import { createContext } from "react";
import type { GestureResponderEvent } from "react-native";

/**
 * Runs a press inside a long-press menu's child only when the menu allows it.
 * Buttons nested in that child use it so a release during menu presentation
 * cannot act and open the menu at once. Null outside such a menu.
 */
export const ControlPillMenuPressGate = createContext<
  ((event: GestureResponderEvent, press: (event: GestureResponderEvent) => void) => void) | null
>(null);
