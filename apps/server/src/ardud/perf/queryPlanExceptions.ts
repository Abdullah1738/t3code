// Waivers bind one captured statement to one exact reviewed planner finding.
export const queryPlanExceptions = [
  {
    route: "shell.selection",
    queryHash: "2ae357a3818c0e5fb4e0dff3177b6ce326a1c2318a2b57bb8349de773f250f73",
    pattern: "^SCAN\\ t\\ USING\\ INDEX\\ sqlite_autoindex_orchestration_v2_projection_threads_1$",
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
  },
  {
    route: "shell.selection",
    queryHash: "2ae357a3818c0e5fb4e0dff3177b6ce326a1c2318a2b57bb8349de773f250f73",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
  },
  {
    route: "shell.selection",
    queryHash: "2ae357a3818c0e5fb4e0dff3177b6ce326a1c2318a2b57bb8349de773f250f73",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
  },
  {
    route: "shell.client-selection",
    queryHash: "cee0d1252df0831198bb09470f638d1abd3c7b0e7a69b297b537354377530164",
    pattern: "^SCAN\\ t\\ USING\\ INDEX\\ sqlite_autoindex_orchestration_v2_projection_threads_1$",
    reason:
      "The M0 shell derivation (same as shell.selection) with idle subagents dropped through the live-run partial indexes. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
  },
  {
    route: "shell.client-selection",
    queryHash: "cee0d1252df0831198bb09470f638d1abd3c7b0e7a69b297b537354377530164",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "The M0 shell derivation (same as shell.selection) with idle subagents dropped through the live-run partial indexes. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
  },
  {
    route: "shell.client-selection",
    queryHash: "cee0d1252df0831198bb09470f638d1abd3c7b0e7a69b297b537354377530164",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    reason:
      "The M0 shell derivation (same as shell.selection) with idle subagents dropped through the live-run partial indexes. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
  },
  {
    route: "shell.recent-page",
    queryHash: "a95dd95f396ba7995c675ecca4467e4613f88c3c9c58b03d1f0fab3bd4c9acfd",
    pattern: "^SCAN\\ t\\ USING\\ INDEX\\ ardud_v2_threads_updated_idx$",
    reason:
      "The M0 shell derivation (same as shell.selection) read in index order, newest first: the scan stops at the page limit and the sorts are the per-row subqueries'. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
  },
  {
    route: "shell.recent-page",
    queryHash: "a95dd95f396ba7995c675ecca4467e4613f88c3c9c58b03d1f0fab3bd4c9acfd",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "The M0 shell derivation (same as shell.selection) read in index order, newest first: the scan stops at the page limit and the sorts are the per-row subqueries'. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
  },
  {
    route: "shell.recent-page",
    queryHash: "a95dd95f396ba7995c675ecca4467e4613f88c3c9c58b03d1f0fab3bd4c9acfd",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    reason:
      "The M0 shell derivation (same as shell.selection) read in index order, newest first: the scan stops at the page limit and the sorts are the per-row subqueries'. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
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
    queryHash: "569234241364e03255371b2a0c6dc0d1559655d9af8509b143cabee0b8c39fa6",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
  },
  {
    route: "board.thread-state",
    queryHash: "569234241364e03255371b2a0c6dc0d1559655d9af8509b143cabee0b8c39fa6",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    reason:
      "Existing M0 shell derivation; replace with indexed materialized views in M1/M3. re-reviewed #1607: SQL changed by #1543 444ac4bb0d; plan diff in card",
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
