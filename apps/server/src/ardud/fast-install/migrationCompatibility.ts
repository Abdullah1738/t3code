export function assertMigrationCompatibility(
  recorded: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
  manifest: ReadonlyArray<readonly [number, string]>,
) {
  const known = new Map(manifest);
  // Historical site-local V1 IDs are allowed by the server's existing migration policy.
  const incompatible = recorded.filter(
    (row) => row.migration_id >= 55 && known.get(row.migration_id) !== row.name,
  );
  if (incompatible.length > 0) {
    throw new Error(
      `Incompatible migrations: ${incompatible.map((row) => `${row.migration_id}:${row.name}`).join(", ")}`,
    );
  }
}
