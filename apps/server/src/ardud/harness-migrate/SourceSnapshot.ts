/**
 * Turns one OpenCode `/context` response into portable history and a manifest.
 *
 * Pure: the caller fetches the JSON and passes it in. The rules come from
 * validation-core 1.2. A completed compaction keeps BOTH its `summary` and its
 * `recent` text, because `recent` holds the latest turns the summary doesn't
 * cover. Anything the reader doesn't know is refused, never dropped: a silent
 * drop is the context loss the migration exists to prevent.
 */
import * as DateTime from "effect/DateTime";

export type ManifestKind =
  | "compaction-summary"
  | "compaction-recent"
  | "user"
  | "assistant-text"
  | "system"
  | "synthetic"
  | "skill"
  | "shell"
  | "tool";

export interface ManifestEntry {
  readonly recordId: string;
  readonly kind: ManifestKind;
  readonly sha1: string;
  readonly included: boolean;
  /** Why the record is excluded; absent when included. */
  readonly why?: string;
}

export interface PortableHistoryTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
  /** Labelled so the target model reads it as history, never as a live instruction. */
  readonly label: string;
}

export interface SourceSnapshot {
  readonly turns: ReadonlyArray<PortableHistoryTurn>;
  readonly manifest: ReadonlyArray<ManifestEntry>;
  /** sha1 over the ordered record ids and kinds; changes when any record is added or removed. */
  readonly digest: string;
  /** Records excluded from the portable history, by kind, for the dry-run summary. */
  readonly excludedKinds: Readonly<Record<string, number>>;
}

export class UnsupportedContextRecord extends Error {
  readonly _tag = "UnsupportedContextRecord";
  readonly recordId: string;
  readonly recordType: string;
  constructor(recordId: string, recordType: string) {
    super(`OpenCode record ${recordId} has an unsupported type "${recordType}"; refusing to migrate.`);
    this.recordId = recordId;
    this.recordType = recordType;
  }
}

type RawRecord = Readonly<Record<string, unknown>> & { readonly id: string; readonly type: string };

// A pure FNV-1a 32-bit fingerprint, not a security hash. It only has to change when
// the record text changes, and the reader stays free of Node and effectful Crypto.
const sha1 = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const isRecord = (value: unknown): value is RawRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { type?: unknown }).type === "string";

// OpenCode stores times as epoch milliseconds; DateTime is the repo's date type.
const timeOf = (record: RawRecord): string => {
  const time = record.time as { created?: unknown } | undefined;
  return typeof time?.created === "number" ? DateTime.formatIso(DateTime.makeUnsafe(time.created)) : "";
};

const textOfUser = (record: RawRecord): string => {
  const text = typeof record.text === "string" ? record.text : "";
  const files = Array.isArray(record.files) ? record.files.length : 0;
  return files === 0 ? text : `${text}\n[${files} attached file(s) not carried over]`;
};

const textOfAssistant = (record: RawRecord): string => {
  const content = Array.isArray(record.content) ? (record.content as ReadonlyArray<RawRecord>) : [];
  return content
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
};

/**
 * Builds the portable history from the `/context` records, in source order.
 * Throws UnsupportedContextRecord on the first record it can't represent.
 */
export function buildSourceSnapshot(input: {
  readonly records: ReadonlyArray<unknown>;
}): SourceSnapshot {
  const turns: Array<PortableHistoryTurn> = [];
  const manifest: Array<ManifestEntry> = [];
  const excludedKinds: Record<string, number> = {};
  const exclude = (kind: string) => {
    excludedKinds[kind] = (excludedKinds[kind] ?? 0) + 1;
  };
  for (const raw of input.records) {
    if (!isRecord(raw)) {
      throw new UnsupportedContextRecord("(malformed)", typeof raw);
    }
    const record = raw;
    switch (record.type) {
      case "compaction": {
        // Only a completed compaction is usable. A running or failed one is ignored
        // here and recorded as excluded, so the manifest shows it was seen.
        if (record.status !== "completed") {
          manifest.push({
            recordId: record.id,
            kind: "compaction-summary",
            sha1: sha1(JSON.stringify(record)),
            included: false,
            why: `compaction status ${String(record.status)} is not usable`,
          });
          exclude("compaction-not-completed");
          break;
        }
        const summary = typeof record.summary === "string" ? record.summary : "";
        const recent = typeof record.recent === "string" ? record.recent : "";
        manifest.push({
          recordId: record.id,
          kind: "compaction-summary",
          sha1: sha1(summary),
          included: true,
        });
        manifest.push({
          recordId: record.id,
          kind: "compaction-recent",
          sha1: sha1(recent),
          included: true,
        });
        turns.push({
          role: "user",
          text: summary,
          timestamp: timeOf(record),
          label: "[Compacted history summary from OpenCode]",
        });
        turns.push({
          role: "user",
          text: recent,
          timestamp: timeOf(record),
          label: "[Recent turns kept by the OpenCode compaction]",
        });
        break;
      }
      case "user": {
        const text = textOfUser(record);
        manifest.push({ recordId: record.id, kind: "user", sha1: sha1(text), included: true });
        turns.push({ role: "user", text, timestamp: timeOf(record), label: "[User]" });
        break;
      }
      case "assistant": {
        const text = textOfAssistant(record);
        manifest.push({
          recordId: record.id,
          kind: "assistant-text",
          sha1: sha1(text),
          included: text.length > 0,
          ...(text.length > 0 ? {} : { why: "assistant turn has no text" }),
        });
        if (text.length > 0) {
          turns.push({
            role: "assistant",
            text,
            timestamp: timeOf(record),
            label: "[Assistant]",
          });
        } else {
          exclude("assistant-no-text");
        }
        break;
      }
      case "system":
      case "synthetic":
      case "skill":
      case "shell": {
        // Model-facing text that reached the model, kept as labelled history.
        const text =
          typeof record.text === "string"
            ? record.text
            : typeof record.output === "string"
              ? record.output
              : "";
        manifest.push({ recordId: record.id, kind: record.type, sha1: sha1(text), included: true });
        turns.push({
          role: "user",
          text,
          timestamp: timeOf(record),
          label: `[${record.type} from OpenCode, history only]`,
        });
        break;
      }
      case "agent-switched":
      case "model-switched":
      case "location-switched":
      case "idle": {
        // Session metadata, not conversation. Recorded as excluded with a reason.
        manifest.push({
          recordId: record.id,
          kind: "system",
          sha1: sha1(record.type),
          included: false,
          why: `${record.type} is session metadata, not conversation`,
        });
        exclude(record.type);
        break;
      }
      default:
        throw new UnsupportedContextRecord(record.id, record.type);
    }
  }
  const digest = sha1(manifest.map((entry) => `${entry.recordId}:${entry.kind}`).join("\n"));
  return { turns, manifest, digest, excludedKinds };
}
