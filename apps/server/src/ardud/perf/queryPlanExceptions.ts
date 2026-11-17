// Waivers bind one captured statement to one exact reviewed planner finding.
export const queryPlanExceptions = [
  {
    route: "shell.selection",
    queryHash: "1dab1c416ebe0419680fec03ec0acfbe22326eb010e44df7c7caf57371b5985a",
    pattern: "^SCAN t USING INDEX ardud_recovery_active_threads_idx$",
    reason:
      "The existing full active-shell fallback now scans the narrower active-ID partial index instead of the primary key. Its query and sorting are unchanged; recovery itself uses a bounded indexed range. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.client-selection",
    queryHash: "11788b147c0090844a688326eb0322fd0a8be4671ea82a5bfa6b490664b55200",
    pattern: "^SCAN t USING INDEX ardud_recovery_active_threads_idx$",
    reason:
      "The existing full client-shell fallback now scans the narrower active-ID partial index instead of the primary key. Its query and sorting are unchanged; recovery itself uses a bounded indexed range. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.selection",
    queryHash: "1dab1c416ebe0419680fec03ec0acfbe22326eb010e44df7c7caf57371b5985a",
    pattern: "^SCAN\\ t\\ USING\\ INDEX\\ sqlite_autoindex_orchestration_v2_projection_threads_1$",
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.selection",
    queryHash: "1dab1c416ebe0419680fec03ec0acfbe22326eb010e44df7c7caf57371b5985a",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.selection",
    queryHash: "1dab1c416ebe0419680fec03ec0acfbe22326eb010e44df7c7caf57371b5985a",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    historyTables: [
      "ardud_archive.ardud_turn_items",
      "ardud_base.orchestration_v2_projection_turn_items",
    ],
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.client-selection",
    queryHash: "11788b147c0090844a688326eb0322fd0a8be4671ea82a5bfa6b490664b55200",
    pattern: "^SCAN\\ t\\ USING\\ INDEX\\ sqlite_autoindex_orchestration_v2_projection_threads_1$",
    reason:
      "The M0 shell derivation (same as shell.selection) with idle subagents dropped through the live-run partial indexes. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.client-selection",
    queryHash: "11788b147c0090844a688326eb0322fd0a8be4671ea82a5bfa6b490664b55200",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "The M0 shell derivation (same as shell.selection) with idle subagents dropped through the live-run partial indexes. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.client-selection",
    queryHash: "11788b147c0090844a688326eb0322fd0a8be4671ea82a5bfa6b490664b55200",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    historyTables: [
      "ardud_archive.ardud_turn_items",
      "ardud_base.orchestration_v2_projection_turn_items",
    ],
    reason:
      "The M0 shell derivation (same as shell.selection) with idle subagents dropped through the live-run partial indexes. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.recent-page",
    queryHash: "e76691c2f75495212f76b6c068cd9588910bcc90c491b87e523a7b19462189d0",
    pattern: "^SCAN\\ t\\ USING\\ INDEX\\ ardud_v2_threads_updated_idx$",
    reason:
      "The M0 shell derivation (same as shell.selection) read in index order, newest first: the scan stops at the page limit and the sorts are the per-row subqueries'. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.recent-page",
    queryHash: "e76691c2f75495212f76b6c068cd9588910bcc90c491b87e523a7b19462189d0",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "The M0 shell derivation (same as shell.selection) read in index order, newest first: the scan stops at the page limit and the sorts are the per-row subqueries'. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "shell.recent-page",
    queryHash: "e76691c2f75495212f76b6c068cd9588910bcc90c491b87e523a7b19462189d0",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    historyTables: [
      "ardud_archive.ardud_turn_items",
      "ardud_base.orchestration_v2_projection_turn_items",
    ],
    reason:
      "The M0 shell derivation (same as shell.selection) read in index order, newest first: the scan stops at the page limit and the sorts are the per-row subqueries'. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "sweep.threads-with-pull-requests",
    queryHash: "6fdcccdbe09fd257750a34b85e921d104c6ae04dcf1b5494238b668394d3aa9d",
    pattern:
      "^SCAN\\ orchestration_v2_projection_threads\\ USING\\ INDEX\\ ardud_v2_threads_pull_requests_idx$",
    reason:
      "A full scan of the partial index that holds only threads with pull request links, in the query's order; it replaces a scan of every thread row.",
  },
  {
    route: "board.thread-state",
    queryHash: "14679415f6aab949da62cee93cf53f8856167190ca3c47a2b0b75981488909d4",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "board.thread-state",
    queryHash: "14679415f6aab949da62cee93cf53f8856167190ca3c47a2b0b75981488909d4",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    historyTables: [
      "ardud_archive.ardud_turn_items",
      "ardud_base.orchestration_v2_projection_turn_items",
    ],
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card. Re-reviewed #1814: d1a400173d only adds whitespace from optional MCP clauses; the full EXPLAIN plan is identical.",
  },
  {
    route: "discussion.messages",
    queryHash: "e91fc4c1fd03b03ca0b825971d9037d56a82c88175121c41ac5e0d3173f8ace8",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason: "Bounded page reordering after LIMIT 50.",
  },
  {
    route: "turn-start.scopes",
    queryHash: "bdc81af65b515b103c838c1705cc9095321cfb5e74696c090752611344e27a43",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "Existing checkpoint metadata ordering after indexed ID selection; this lane bounds bind count.",
  },
  {
    route: "turn-start.history",
    queryHash: "9909f9aa617527a5bf630e848966cfad87762ee842e0d8e71df315244c2e1078",
    pattern: "^CO\\-ROUTINE\\ ardud_history_turn_items$",
    reason:
      "Explicit history read across hot/delta/base; preserves existing transcript order and indexed thread/run selection.",
  },
  {
    route: "turn-start.history",
    queryHash: "9909f9aa617527a5bf630e848966cfad87762ee842e0d8e71df315244c2e1078",
    pattern: "^SEARCH\\ cold\\ USING\\ INDEX\\ ardud_turn_items_thread_idx\\ \\(thread_id=\\?\\)$",
    reason:
      "Explicit history read across hot/delta/base; preserves existing transcript order and indexed thread/run selection.",
  },
  {
    route: "turn-start.history",
    queryHash: "9909f9aa617527a5bf630e848966cfad87762ee842e0d8e71df315244c2e1078",
    pattern:
      "^SEARCH\\ base\\ USING\\ INDEX\\ orchestration_v2_projection_turn_items_thread_run_idx\\ \\(thread_id=\\?\\ AND\\ run_id=\\?\\)$",
    reason:
      "Explicit history read across hot/delta/base; preserves existing transcript order and indexed thread/run selection.",
  },
  {
    route: "turn-start.history",
    queryHash: "9909f9aa617527a5bf630e848966cfad87762ee842e0d8e71df315244c2e1078",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "Explicit history read across hot/delta/base; preserves existing transcript order and indexed thread/run selection.",
  },
  {
    route: "turn-start.history",
    queryHash: "9909f9aa617527a5bf630e848966cfad87762ee842e0d8e71df315244c2e1078",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    historyTables: ["ardud_history_turn_items"],
    reason:
      "Explicit history read across hot/delta/base; preserves existing transcript order and indexed thread/run selection.",
  },
  {
    route: "projects.selection",
    queryHash: "4e82d09a3a20ba3175fd7c6938d1088f79c137001e61615f768eef85cfdb2dc5",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason: "Preserve project creation order after indexed project-ID selection.",
  },
  {
    route: "auth.connected",
    queryHash: "b254f316b575e36e75110e1c63187bc4f63408d96a2e410d5d5a2733316b6f1d",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "Existing session issue-time ordering; expiry/connected membership semantics are unchanged.",
  },
  {
    route: "shell.providers.large",
    queryHash: "4559a59114dc1a870cd540d55beb5fef7be74a852ad0639c29710acff422bab2",
    pattern: "^SCAN orchestration_v2_projection_provider_threads$",
    reason:
      "Preserve the existing >1000-ID sequential scan strategy for near-full provider selections; JSON bounds variables without reintroducing random reads.",
  },
] as const;
