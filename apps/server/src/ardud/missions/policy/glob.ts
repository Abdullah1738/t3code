/**
 * Tiny path glob for criticality hard triggers. Supports `**` (any depth,
 * including none), `*` (within one segment) and `?` (one character). Paths are
 * repo-relative with `/` separators. A pattern without a `/` matches the base
 * name at any depth, like `.gitignore`.
 */
const cache = new Map<string, RegExp>();

function escape(char: string): string {
  return /[\\^$.|+()[\]{}]/.test(char) ? `\\${char}` : char;
}

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const normalized = pattern.startsWith("/")
    ? pattern.slice(1)
    : pattern.includes("/")
      ? pattern
      : `**/${pattern}`;
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") {
      const followedBySlash = normalized[index + 2] === "/";
      source += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escape(char);
    }
  }
  const regex = new RegExp(`^${source}$`);
  cache.set(pattern, regex);
  return regex;
}

export function matchesGlob(pattern: string, path: string): boolean {
  const clean = path.startsWith("./") ? path.slice(2) : path.replace(/^\/+/, "");
  return compile(pattern.trim()).test(clean);
}
