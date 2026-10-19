import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

type GlassStyle = Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;

/**
 * Writes the glass opacity inline only once the user moves it off the default,
 * so a theme's own stylesheet default (Desk is opaque) applies until then.
 */
export function applyGlassOpacity(style: GlassStyle, glassOpacity: number): void {
  if (glassOpacity === DEFAULT_UNIFIED_SETTINGS.glassOpacity) {
    style.removeProperty("--glass-opacity");
  } else {
    style.setProperty("--glass-opacity", `${glassOpacity}%`);
  }
  if (glassOpacity === 100) {
    style.setProperty("--glass-blur", "0px");
  } else {
    style.removeProperty("--glass-blur");
  }
}
