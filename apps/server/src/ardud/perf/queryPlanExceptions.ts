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
] as const;
