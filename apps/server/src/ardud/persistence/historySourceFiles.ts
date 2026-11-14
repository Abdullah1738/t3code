import type * as Path from "effect/Path";

/** Also serialized into the readonly export worker; keep runtime dependencies explicit. */
export function resolveHistoryBasePath(
  path: Pick<Path.Path, "dirname" | "basename" | "join">,
  sourcePath: string,
  rows: ReadonlyArray<{ readonly filename: unknown }>,
) {
  if (rows.length === 0) return undefined;
  const filename = rows[0]!.filename;
  if (
    rows.length !== 1 ||
    typeof filename !== "string" ||
    !/^statev2\.pre-shrink-[^/\\]+\.sqlite$/.test(filename) ||
    path.basename(filename) !== filename
  )
    throw new Error("Invalid readonly history base filename");
  return path.join(path.dirname(sourcePath), filename);
}
