export function boardRenameValue(value: string, current: string): string | null {
  const name = value.trim();
  return name === "" || name === current.trim() ? null : name;
}
