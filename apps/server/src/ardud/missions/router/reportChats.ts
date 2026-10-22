// @effect-diagnostics nodeBuiltinImport:off - read-only lookups into the iMessage bridge's SQLite files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { defaultInboundSources } from "../asks/inbound.ts";

/**
 * Which bridge chat a report names. The chat agent passes its session
 * (`ardud-control:thread:<id>@<generation>`, as the bridge hands it out) or
 * the chat's slug; both resolve to the slug the bridge keeps the chat under.
 */
export class ReportChats extends Context.Service<
  ReportChats,
  {
    /** The chat's slug (`owner`, `moni`, `group-...`), or null when no bridge chat matches. */
    readonly resolve: (chat: string) => Effect.Effect<string | null>;
  }
>()("t3/ardud/missions/router/reportChats") {}

export interface ReportChatSources {
  /** His direct chat's store; its slug is `owner`. */
  readonly bridgeDatabase: string;
  /** One folder per other chat, each with a `state.sqlite`. */
  readonly chatsDirectory: string;
}

const OWNER = "owner";
/** The bridge's own slugs: lowercase, dots allowed, up to 80 plus a `-<n>` collision suffix. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** `ardud-control:thread:<id>@3`, `ardud-control:thread:<id>` and `<id>` all name thread `<id>`. */
const threadOf = (session: string) => {
  const bare = session.trim().replace(/@\d+$/, "");
  return bare.slice(bare.lastIndexOf(":") + 1);
};

const routeThread = (database: string): string | null => {
  if (!NodeFS.existsSync(database)) return null;
  try {
    const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM kv WHERE key = 'route'").get() as
        | { value: string }
        | undefined;
      if (row === undefined) return null;
      const route: unknown = JSON.parse(row.value);
      if (typeof route !== "object" || route === null || !("id" in route)) return null;
      return typeof route.id === "string" && route.id.length > 0 ? threadOf(route.id) : null;
    } finally {
      db.close();
    }
  } catch {
    // A store the bridge is rewriting or never routed names no chat.
    return null;
  }
};

const stores = (sources: ReportChatSources) => {
  const others = NodeFS.existsSync(sources.chatsDirectory)
    ? NodeFS.readdirSync(sources.chatsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== OWNER && SLUG.test(entry.name))
        .map((entry) => entry.name)
        .toSorted()
        .map((slug) => ({
          slug,
          database: NodePath.join(sources.chatsDirectory, slug, "state.sqlite"),
        }))
    : [];
  return [{ slug: OWNER, database: sources.bridgeDatabase }, ...others].filter((store) =>
    NodeFS.existsSync(store.database),
  );
};

export const resolveReportChat = (sources: ReportChatSources, chat: string): string | null => {
  const wanted = chat.trim();
  if (wanted.length === 0) return null;
  const all = stores(sources);
  const bySlug = all.find((store) => store.slug === wanted);
  if (bySlug !== undefined) return bySlug.slug;
  const thread = threadOf(wanted);
  if (thread.length === 0) return null;
  return all.find((store) => routeThread(store.database) === thread)?.slug ?? null;
};

export const reportChatsFrom = (sources: ReportChatSources) =>
  ReportChats.of({
    resolve: Effect.fn("ReportChats.resolve")(function* (chat: string) {
      return yield* Effect.sync(() => resolveReportChat(sources, chat));
    }),
  });

export const layer = Layer.sync(ReportChats, () => reportChatsFrom(defaultInboundSources()));
