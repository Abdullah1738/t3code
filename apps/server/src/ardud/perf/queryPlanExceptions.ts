// Waivers bind one captured statement to one exact reviewed planner finding.
export const queryPlanExceptions = [
  {
    route: "shell.selection",
    queryHash: "1d4cf785c489c8217fc17ac594e1d57c6f46557bcc449a40fed02bcc869237bb",
    pattern: "^SCAN\\ t\\ USING\\ INDEX\\ sqlite_autoindex_orchestration_v2_projection_threads_1$",
    reason: "Existing M0 shell derivation; replace with indexed materialized views in M1/M3.",
  },
  {
    route: "shell.selection",
    queryHash: "1d4cf785c489c8217fc17ac594e1d57c6f46557bcc449a40fed02bcc869237bb",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason: "Existing M0 shell derivation; replace with indexed materialized views in M1/M3.",
  },
  {
    route: "shell.selection",
    queryHash: "1d4cf785c489c8217fc17ac594e1d57c6f46557bcc449a40fed02bcc869237bb",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    reason: "Existing M0 shell derivation; replace with indexed materialized views in M1/M3.",
  },
  {
    route: "board.thread-state",
    queryHash: "ddadfd7116f5f1550d086ce91157d3915c22eeec29cc94cb31ab1e7cc7d67442",
    pattern: "^USE\\ TEMP\\ B\\-TREE\\ FOR\\ ORDER\\ BY$",
    reason: "Existing M0 shell derivation; replace with indexed materialized views in M1/M3.",
  },
  {
    route: "board.thread-state",
    queryHash: "ddadfd7116f5f1550d086ce91157d3915c22eeec29cc94cb31ab1e7cc7d67442",
    pattern: "^Interactive\\ query\\ references\\ history/archive$",
    reason: "Existing M0 shell derivation; replace with indexed materialized views in M1/M3.",
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
