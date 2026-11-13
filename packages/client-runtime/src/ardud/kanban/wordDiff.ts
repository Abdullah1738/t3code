/**
 * A word-level difference between two texts, for the change views of an ask
 * (After, Before, Changes, Side by side) and for "what changed since you last
 * looked". Pure.
 */

export interface DiffOp {
  /** `=` kept, `+` added, `-` removed, `~` a space between two changes. */
  readonly kind: "=" | "+" | "-" | "~";
  readonly text: string;
}

/** Past this many word pairs the table is too big: the texts are shown whole instead. */
const MAX_CELLS = 4_000_000;

const tokens = (text: string): Array<string> => text.split(/(\s+)/).filter((part) => part !== "");

/** The edits that turn `before` into `after`, word by word, runs merged. */
export function wordDiff(before: string, after: string): ReadonlyArray<DiffOp> {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...(before === "" ? [] : [{ kind: "-" as const, text: before }]),
      ...(after === "" ? [] : [{ kind: "+" as const, text: after }]),
    ];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: Array<{ kind: DiffOp["kind"]; text: string }> = [];
  const push = (kind: DiffOp["kind"], text: string) => {
    const last = ops.at(-1);
    if (last && last.kind === kind) last.text += text;
    else ops.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push("=", a[i]!);
      i += 1;
      j += 1;
    } else if (
      j < b.length &&
      (i === a.length || table[i * width + j + 1]! > table[(i + 1) * width + j]!)
    ) {
      push("+", b[j]!);
      j += 1;
    } else {
      push("-", a[i]!);
      i += 1;
    }
  }
  // A lone space between two changes joins them, so a rewritten phrase reads as one run.
  for (let k = 1; k < ops.length - 1; k += 1) {
    const op = ops[k]!;
    if (
      op.kind === "=" &&
      op.text.trim() === "" &&
      ops[k - 1]!.kind !== "=" &&
      ops[k + 1]!.kind !== "="
    ) {
      op.kind = "~";
    }
  }
  return ops;
}

export const wordCount = (text: string): number => (text.trim().match(/\S+/g) ?? []).length;

/** Words added and removed. */
export function diffCount(ops: ReadonlyArray<DiffOp>): {
  readonly added: number;
  readonly removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "+") added += wordCount(op.text);
    if (op.kind === "-") removed += wordCount(op.text);
  }
  return { added, removed };
}

/**
 * Whether the two texts are close enough to read as a marked-up difference:
 * at least half the words survive. A rewritten text reads better as was / now.
 */
export function diffReadsInline(
  ops: ReadonlyArray<DiffOp>,
  before: string,
  after: string,
): boolean {
  const kept = wordCount(
    ops
      .filter((op) => op.kind === "=")
      .map((op) => op.text)
      .join(" "),
  );
  return kept >= 0.5 * Math.max(wordCount(before), wordCount(after));
}

export type DiffSide = "both" | "before" | "after";

export interface DiffPiece {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
}

/**
 * The pieces to draw for one side: `both` marks removals and additions in one
 * text, `before` shows the old text with its removals marked, `after` the new
 * text with its additions marked.
 */
export function diffPieces(ops: ReadonlyArray<DiffOp>, side: DiffSide): ReadonlyArray<DiffPiece> {
  const pieces: Array<DiffPiece> = [];
  const push = (kind: DiffPiece["kind"], text: string) => {
    if (text === "") return;
    const last = pieces.at(-1);
    if (last && last.kind === kind) pieces[pieces.length - 1] = { kind, text: last.text + text };
    else pieces.push({ kind, text });
  };
  const endsInSpace = () => /\s$/.test(pieces.at(-1)?.text ?? " ");
  for (let index = 0; index < ops.length;) {
    const op = ops[index]!;
    if (op.kind === "=") {
      push("same", op.text);
      index += 1;
      continue;
    }
    // One run of changes: what it removed, then what it added.
    let removed = "";
    let added = "";
    for (; index < ops.length && ops[index]!.kind !== "="; index += 1) {
      const part = ops[index]!;
      if (part.kind !== "+") removed += part.text;
      if (part.kind !== "-") added += part.text;
    }
    if (side === "before") {
      if (removed.trim() === "") push("same", removed);
      else push("removed", removed);
    } else if (side === "after") {
      if (added.trim() === "") push("same", added);
      else push("added", added);
    } else {
      const raw = removed + added;
      if (/^\s/.test(raw) && !endsInSpace()) push("same", " ");
      if (removed.trim() !== "") push("removed", removed.trim());
      if (removed.trim() !== "" && added.trim() !== "") push("same", " ");
      if (added.trim() !== "") push("added", added.trim());
      if (/\s$/.test(removed) || /\s$/.test(added)) push("same", " ");
    }
  }
  return pieces;
}
