// @effect-diagnostics nodeBuiltinImport:off -- inspect only directory metadata after a storage failure.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";

export interface SqliteErrorContext {
  readonly file: string;
  readonly role: "primary" | "replica" | "unknown";
  readonly connection: string;
  readonly operation: string;
  readonly span: string;
  readonly volumeUnavailable?: boolean;
}

export type SqliteErrorObserver = (cause: unknown, context: SqliteErrorContext) => void;

export const ErrorObserver = Context.Reference<SqliteErrorObserver | undefined>(
  "t3/sqlite/ErrorObserver",
  { defaultValue: () => undefined },
);

// Metadata stays on the original cause through SqlError and domain wrappers.
const origins = new WeakMap<
  object,
  { context: SqliteErrorContext; report?: SqliteErrorObserver }
>();

export function annotateSqliteError(
  cause: unknown,
  context: SqliteErrorContext,
  report?: SqliteErrorObserver,
): unknown {
  context = {
    ...context,
    volumeUnavailable: context.volumeUnavailable ?? storageUnavailable(cause, context.file),
  };
  if (Predicate.isObject(cause)) origins.set(cause, { context, ...(report ? { report } : {}) });
  try {
    report?.(cause, context);
  } catch {
    /* Diagnostics cannot change a SQL result. */
  }
  return cause;
}

export function sqliteErrorDetails(value: unknown):
  | {
      errcode: number;
      errstr: string | undefined;
      context: SqliteErrorContext | undefined;
    }
  | undefined {
  const seen = new Set<unknown>();
  const visit = (item: unknown): ReturnType<typeof sqliteErrorDetails> => {
    if (!Predicate.isObject(item) || seen.has(item)) return undefined;
    seen.add(item);
    if (typeof item.errcode === "number" && Number.isInteger(item.errcode) && item.errcode > 0) {
      return {
        errcode: item.errcode,
        errstr: typeof item.errstr === "string" ? item.errstr.slice(0, 512) : undefined,
        context: origins.get(item)?.context,
      };
    }
    return visit(item.cause) ?? visit(item.reason) ?? visit(item.error);
  };
  return visit(value);
}

export function sqliteFailureContext(value: unknown): SqliteErrorContext | undefined {
  const seen = new Set<unknown>();
  let cause = value;
  while (Predicate.isObject(cause) && !seen.has(cause)) {
    seen.add(cause);
    const context = origins.get(cause)?.context;
    if (context) return context;
    cause = cause.cause ?? cause.reason;
  }
  return undefined;
}

export function reportSqliteError(value: unknown, span: string): void {
  const seen = new Set<unknown>();
  let cause = value;
  while (Predicate.isObject(cause) && !seen.has(cause)) {
    seen.add(cause);
    const origin = origins.get(cause);
    if (origin) {
      try {
        origin.report?.(cause, { ...origin.context, span });
      } catch {
        /* Keep the original failure. */
      }
      return;
    }
    cause = cause.cause ?? cause.reason;
  }
}

function storageUnavailable(value: unknown, file: string): boolean {
  const seen = new Set<unknown>();
  let cause = value;
  while (Predicate.isObject(cause) && !seen.has(cause)) {
    seen.add(cause);
    if (
      ["ENOENT", "EIO", "ENODEV", "ENXIO", "ESTALE"].includes(String(cause.code)) ||
      (typeof cause.errcode === "number" && (cause.errcode & 0xff) === 10)
    )
      return true;
    cause = cause.cause;
  }
  if (file === ":memory:" || file === "") return false;
  try {
    return !NodeFS.statSync(NodePath.dirname(file)).isDirectory();
  } catch {
    return true;
  }
}
