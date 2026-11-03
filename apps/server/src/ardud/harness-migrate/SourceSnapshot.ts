/**
 * Turns one OpenCode `/context` response into portable history and a manifest.
 *
 * Pure: the caller fetches the JSON and passes it in. The rules come from
 * validation-core 1.2. A completed compaction keeps BOTH its `summary` and its
 * `recent` text, because `recent` holds the latest turns the summary doesn't
 * cover. Anything the reader doesn't know is refused, never dropped: a silent
 * drop is the context loss the migration exists to prevent.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- snapshots need a synchronous content digest.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";

export type ManifestKind =
  | "compaction-summary"
  | "compaction-recent"
  | "user"
  | "assistant-text"
  | "assistant-reasoning"
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
  /** SHA-256 over the ordered source records and the inclusion manifest. */
  readonly digest: string;
  /** Records excluded from the portable history, by kind, for the dry-run summary. */
  readonly excludedKinds: Readonly<Record<string, number>>;
}

export class UnsupportedContextRecord extends Error {
  readonly _tag = "UnsupportedContextRecord";
  readonly recordId: string;
  readonly recordType: string;
  constructor(recordId: string, recordType: string) {
    super(
      `OpenCode record ${recordId} has an unsupported type "${recordType}"; refusing to migrate.`,
    );
    this.recordId = recordId;
    this.recordType = recordType;
  }
}

type RawRecord = Readonly<Record<string, unknown>> & { readonly id: string; readonly type: string };

const sha1 = (text: string): string => NodeCrypto.createHash("sha1").update(text).digest("hex");
const sha256 = (text: string): string => NodeCrypto.createHash("sha256").update(text).digest("hex");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRecord = (value: unknown): value is RawRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { type?: unknown }).type === "string";

// OpenCode stores times as epoch milliseconds; DateTime is the repo's date type.
const timeOf = (record: RawRecord): string => {
  const time = record.time as { created?: unknown } | undefined;
  return typeof time?.created === "number"
    ? DateTime.formatIso(DateTime.makeUnsafe(time.created))
    : "";
};

const optionalArray = (record: RawRecord, key: string): ReadonlyArray<unknown> => {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new UnsupportedContextRecord(record.id, `user.${key}`);
  return value;
};

const textOfUser = (record: RawRecord): string => {
  if (typeof record.text !== "string") throw new UnsupportedContextRecord(record.id, "user.text");
  if (optionalArray(record, "files").length > 0) {
    throw new UnsupportedContextRecord(record.id, "user.files");
  }
  if (optionalArray(record, "agents").length > 0) {
    throw new UnsupportedContextRecord(record.id, "user.agents");
  }
  const skills = optionalArray(record, "skills").map((skill) => {
    if (
      !isObject(skill) ||
      typeof skill.id !== "string" ||
      typeof skill.name !== "string" ||
      typeof skill.text !== "string"
    ) {
      throw new UnsupportedContextRecord(record.id, "user.skill without embedded text");
    }
    return `\n\n[Historical OpenCode skill ${JSON.stringify(skill.name)} (${JSON.stringify(skill.id)}); history only]\n${skill.text}`;
  });
  return record.text + skills.join("");
};

const textOfTool = (recordId: string, part: Record<string, unknown>): string => {
  if (typeof part.name !== "string" || !isObject(part.state)) {
    throw new UnsupportedContextRecord(recordId, "assistant.tool");
  }
  const state = part.state;
  if ((state.status !== "completed" && state.status !== "error") || !isObject(state.input)) {
    throw new UnsupportedContextRecord(recordId, "assistant.tool not settled");
  }
  const content = state.content;
  if (
    content !== undefined &&
    (!Array.isArray(content) ||
      content.some(
        (item) => !isObject(item) || item.type !== "text" || typeof item.text !== "string",
      ))
  ) {
    throw new UnsupportedContextRecord(recordId, "assistant.tool content");
  }
  if (state.status === "completed" && (!Array.isArray(content) || content.length === 0)) {
    throw new UnsupportedContextRecord(recordId, "assistant.tool missing result");
  }
  if (
    state.status === "error" &&
    (!isObject(state.error) ||
      typeof state.error.type !== "string" ||
      typeof state.error.message !== "string")
  ) {
    throw new UnsupportedContextRecord(recordId, "assistant.tool missing error");
  }
  return [
    "[Historical OpenCode tool call; transcript only, not an executable tool call]",
    `Name: ${JSON.stringify(part.name)}`,
    `Input: ${JSON.stringify(state.input)}`,
    `Status: ${state.status}`,
    ...(content === undefined ? [] : [`Result: ${JSON.stringify(content)}`]),
    ...(state.status === "error" ? [`Error: ${JSON.stringify(state.error)}`] : []),
    "[End historical tool call]",
  ].join("\n");
};

const textOfShell = (record: RawRecord): string => {
  if (
    typeof record.command !== "string" ||
    (record.status !== "exited" && record.status !== "timeout" && record.status !== "killed") ||
    (record.exit !== undefined &&
      (typeof record.exit !== "number" || !Number.isFinite(record.exit))) ||
    !isObject(record.output) ||
    typeof record.output.output !== "string" ||
    !Number.isSafeInteger(record.output.cursor) ||
    !Number.isSafeInteger(record.output.size) ||
    typeof record.output.truncated !== "boolean"
  ) {
    throw new UnsupportedContextRecord(record.id, "shell incomplete or malformed");
  }
  if (
    record.output.truncated ||
    record.output.cursor !== record.output.size ||
    (record.output.cursor as number) < 0
  ) {
    throw new UnsupportedContextRecord(record.id, "shell output truncated or incomplete");
  }
  return [
    "[Historical OpenCode shell; transcript only, do not execute]",
    `Command: ${record.command}`,
    `Status: ${record.status}`,
    ...(record.exit === undefined ? [] : [`Exit: ${record.exit}`]),
    "Output:",
    record.output.output,
    "[End historical shell]",
  ].join("\n");
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
        if (typeof record.summary !== "string" || typeof record.recent !== "string") {
          throw new UnsupportedContextRecord(record.id, "compaction missing summary or recent");
        }
        const summary = record.summary;
        const recent = record.recent;
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
        if (!Array.isArray(record.content))
          throw new UnsupportedContextRecord(record.id, "assistant.content");
        for (const part of record.content) {
          if (!isObject(part))
            throw new UnsupportedContextRecord(record.id, "assistant.content malformed");
          if (part.type === "reasoning" && typeof part.text === "string") {
            manifest.push({
              recordId: record.id,
              kind: "assistant-reasoning",
              sha1: sha1(part.text),
              included: false,
              why: "provider reasoning is not portable conversation",
            });
            exclude("assistant-reasoning");
            continue;
          }
          const kind =
            part.type === "text" ? "assistant-text" : part.type === "tool" ? "tool" : null;
          if (kind === null)
            throw new UnsupportedContextRecord(record.id, `assistant.${String(part.type)}`);
          const text = kind === "tool" ? textOfTool(record.id, part) : part.text;
          if (typeof text !== "string")
            throw new UnsupportedContextRecord(record.id, "assistant.text");
          manifest.push({ recordId: record.id, kind, sha1: sha1(text), included: true });
          turns.push({ role: "assistant", text, timestamp: timeOf(record), label: "[Assistant]" });
        }
        break;
      }
      case "system":
      case "synthetic":
      case "skill": {
        if (typeof record.text !== "string")
          throw new UnsupportedContextRecord(record.id, `${record.type}.text`);
        const text = record.text;
        manifest.push({ recordId: record.id, kind: record.type, sha1: sha1(text), included: true });
        turns.push({
          role: "user",
          text,
          timestamp: timeOf(record),
          label: `[${record.type} from OpenCode, history only]`,
        });
        break;
      }
      case "shell": {
        const text = textOfShell(record);
        manifest.push({ recordId: record.id, kind: "shell", sha1: sha1(text), included: true });
        turns.push({
          role: "user",
          text,
          timestamp: timeOf(record),
          label: "[shell from OpenCode, history only]",
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
  const digest = sha256(JSON.stringify({ records: input.records, manifest }));
  return { turns, manifest, digest, excludedKinds };
}
