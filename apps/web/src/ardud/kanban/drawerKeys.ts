/** ↑ is -1 and ↓ is 1; null when the key belongs to typing, a menu or a shortcut. */
export function stepFromKey(event: {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
  readonly target: EventTarget | null;
}): -1 | 1 | null {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.defaultPrevented || event.isComposing) return null;
  const target = event.target as { closest?: unknown } | null;
  if (target && typeof target.closest === "function") {
    const owned = (target.closest as (selector: string) => unknown).call(
      target,
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="listbox"], [role="combobox"], [role="slider"]',
    );
    if (owned !== null) return null;
  }
  return event.key === "ArrowUp" ? -1 : 1;
}
