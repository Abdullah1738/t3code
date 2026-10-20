import {
  markAsset,
  type AssetMark,
  type AssetReview,
} from "@t3tools/client-runtime/ardud/missions";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { writeFileAtomically } from "../../lib/atomic-file";
import { SerializedAsyncQueue } from "../../lib/serialized-async-queue";

// Per-image review marks stay on the phone until the answer goes, so leaving
// the screen or restarting the app keeps them. One small document holds
// every open review.

const AssetMarkSchema = Schema.Struct({
  verdict: Schema.NullOr(Schema.Literals(["ok", "change"])),
  note: Schema.String,
  pin: Schema.NullOr(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
});
const decodeDocument = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Record(Schema.String, AssetMarkSchema)),
);

const NO_MARKS: AssetReview = {};
let reviews: Readonly<Record<string, AssetReview>> = {};
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const queue = new SerializedAsyncQueue();

const emit = () => {
  for (const listener of listeners) listener();
};

async function reviewFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, "mission-review");
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, "marks.json");
}

function load(): Promise<void> {
  loading ??= (async () => {
    try {
      const file = await reviewFile();
      if (!file.exists) return;
      const saved = decodeDocument(JSON.parse(await file.text()));
      if (saved._tag === "Some") {
        // Marks made before the file finished loading win.
        reviews = { ...saved.value, ...reviews };
        emit();
      }
    } catch {
      // An unreadable document only loses old marks.
    }
  })();
  return loading;
}

function save() {
  void queue.run(async () => {
    try {
      await writeFileAtomically(await reviewFile(), JSON.stringify(reviews));
    } catch {
      // Marks stay for this session.
    }
  });
}

function update(key: string, next: AssetReview | null) {
  const rest = Object.fromEntries(Object.entries(reviews).filter(([other]) => other !== key));
  reviews = next === null || Object.keys(next).length === 0 ? rest : { ...rest, [key]: next };
  emit();
  save();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** One record's marks, with a setter per image and a reset once sent. */
export function useReviewMarks(key: string) {
  useEffect(() => {
    void load();
  }, []);
  const marks = useSyncExternalStore(subscribe, () => reviews[key] ?? NO_MARKS);
  const mark = useCallback(
    (assetId: string, change: Partial<AssetMark>) =>
      update(key, markAsset(reviews[key] ?? NO_MARKS, assetId, change)),
    [key],
  );
  const clear = useCallback(() => update(key, null), [key]);
  return { marks, mark, clear };
}
