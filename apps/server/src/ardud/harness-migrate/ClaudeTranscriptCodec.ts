/**
 * Writes a Claude Code native session from already-labelled history. The records
 * use the shape Claude Code 2.1.x writes for plain user and assistant text, copied
 * from an existing transcript. Historical tool calls are never written as tool_use
 * blocks: a tool_use id with no live process behind it would leave the CLI waiting
 * for a result that never comes, so the caller turns tool history into labelled text.
 */
export interface PortableTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** ISO-8601 time the turn was written at the source. */
  readonly timestamp: string;
}

export interface EncodeClaudeTranscriptInput {
  readonly sessionId: string;
  readonly cwd: string;
  /** The Claude Code version recorded on each record. */
  readonly version: string;
  /** In source order, oldest first. */
  readonly turns: ReadonlyArray<PortableTurn>;
  /**
   * Supplies each record uuid. The caller passes a source backed by Effect's
   * `Crypto` service, so the codec stays pure and fails loudly if none is given.
   */
  readonly newUuid: () => string;
}

export interface EncodedClaudeTranscript {
  /** The file body: one JSON record per line, newline-terminated. */
  readonly content: string;
  /** Every record uuid, oldest first. */
  readonly recordUuids: ReadonlyArray<string>;
  /** Where the first resume starts: the last record. */
  readonly headUuid: string;
}

export function encodeClaudeTranscript(
  input: EncodeClaudeTranscriptInput,
): EncodedClaudeTranscript {
  // A file with no conversation record can't be resumed, and the adapter would
  // refuse it later. Refuse to write it.
  if (input.turns.length === 0) {
    throw new Error("Claude history needs at least one turn to resume.");
  }
  const newUuid = input.newUuid;
  const recordUuids: Array<string> = [];
  const lines: Array<string> = [];
  let parentUuid: string | null = null;
  for (const turn of input.turns) {
    const uuid = newUuid();
    recordUuids.push(uuid);
    lines.push(
      JSON.stringify({
        parentUuid,
        isSidechain: false,
        userType: "external",
        entrypoint: "sdk-cli",
        cwd: input.cwd,
        sessionId: input.sessionId,
        version: input.version,
        type: turn.role,
        message:
          turn.role === "user"
            ? { role: "user", content: turn.text }
            : { role: "assistant", content: [{ type: "text", text: turn.text }] },
        uuid,
        timestamp: turn.timestamp,
      }),
    );
    parentUuid = uuid;
  }
  const headUuid = recordUuids[recordUuids.length - 1];
  if (headUuid === undefined) throw new Error("unreachable: turns is non-empty");
  return { content: `${lines.join("\n")}\n`, recordUuids, headUuid };
}
