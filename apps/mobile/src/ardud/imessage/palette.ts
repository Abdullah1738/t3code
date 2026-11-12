import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";

// Messages' own colours, as web's imessage.css sets them, so the chat reads as Messages
// on every surface. The light link is the app's primary, as it is on web.
const LIGHT = {
  incoming: "#e9e9eb",
  incomingInk: "#111113",
  outgoing: "#0071e3",
  raised: "#f4f4f5",
  dot: "#007aff",
  link: "#1b4ed8",
  agent: "#eaf1fb",
  agentInk: "#1d3f73",
  note: "#fbf3df",
  noteInk: "#5c4400",
} as const;

const DARK = {
  incoming: "#26262a",
  incomingInk: "#f5f5f5",
  outgoing: "#0071e3",
  raised: "#1c1c1e",
  dot: "#0a84ff",
  link: "#8db4ff",
  agent: "#16233a",
  agentInk: "#b4cdf5",
  note: "#2a2410",
  noteInk: "#ecd38f",
} as const;

export type IMessagePalette = typeof LIGHT | typeof DARK;

export function useIMessagePalette(): IMessagePalette {
  return useAppearancePreferences().themeAppearance === "dark" ? DARK : LIGHT;
}
