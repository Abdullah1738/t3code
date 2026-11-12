export const NEEDS_YOU_VIEWS = ["queue", "history", "reference"] as const;
export type NeedsYouView = (typeof NEEDS_YOU_VIEWS)[number];

export interface NeedsYouSearch {
  readonly view?: Exclude<NeedsYouView, "queue">;
  /** The ask (or batch) in focus, by its queue key. */
  readonly ask?: string;
  /** Only this board's asks. */
  readonly board?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export function parseNeedsYouSearch(raw: Record<string, unknown>): NeedsYouSearch {
  const view = raw.view === "history" || raw.view === "reference" ? raw.view : undefined;
  const ask = text(raw.ask);
  const board = text(raw.board);
  return {
    ...(view ? { view } : {}),
    ...(ask ? { ask } : {}),
    ...(board ? { board } : {}),
  };
}

/** The search with a patch applied; a key patched to `undefined` is dropped. */
export function patchNeedsYouSearch(
  search: NeedsYouSearch,
  patch: { readonly [K in keyof NeedsYouSearch]?: NeedsYouSearch[K] | undefined },
): NeedsYouSearch {
  return parseNeedsYouSearch({ ...search, ...patch });
}
