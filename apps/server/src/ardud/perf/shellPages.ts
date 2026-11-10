/**
 * ardud: cursors for the paged shell snapshot (HTTP `GET /api/orchestration/shell?paged=true`
 * and the socket's paged snapshot).
 *
 * Pages walk the thread list by thread id, 500 rows at a time, so on a large list the
 * threads someone is working in arrive at arbitrary points of a load that can take
 * minutes. A client that asks for `recentFirst` gets one extra page up front: the 500 most
 * recently updated rows. Its cursor then starts the same id walk from the beginning, so
 * every row is still delivered by the walk and the recent rows simply arrive twice (the
 * client merges rows by id). The cursor is opaque to clients: they echo `nextAfter` back.
 *
 * `ROBOB_SHELL_RECENT_FIRST=0` ignores the request and pages by id from the start.
 */
export const SHELL_PAGE_SIZE = 500;

/** `nextAfter` of the recent-first page. Not a thread id: it starts the id walk. */
export const SHELL_WALK_START_CURSOR = "!recent-first";

export interface ShellPageRead {
  readonly recentFirst?: true;
  readonly afterThreadId?: string;
}

/** What to read for the page a client asked for with `after`. */
export const shellPageRead = (after: string | undefined, recentFirst: boolean): ShellPageRead =>
  after === undefined
    ? recentFirst
      ? { recentFirst: true }
      : {}
    : // The walk's first page; also accepted when the switch is off, so a load that began
      // before a restart with the switch flipped still continues.
      after === SHELL_WALK_START_CURSOR
      ? {}
      : { afterThreadId: after };

/**
 * The cursor after a page read with `limit: SHELL_PAGE_SIZE + 1`. `rows` are the rows read
 * (up to one more than a page), in the order read.
 */
export const shellPageNextAfter = (
  read: ShellPageRead,
  rows: ReadonlyArray<{ readonly id: string }>,
): string | null =>
  rows.length <= SHELL_PAGE_SIZE
    ? null
    : read.recentFirst === true
      ? SHELL_WALK_START_CURSOR
      : rows[SHELL_PAGE_SIZE - 1]!.id;
