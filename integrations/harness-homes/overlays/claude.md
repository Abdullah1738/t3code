# Claude Code tool mechanics

- MCP tools appear as `mcp__<server>__<tool>`; T3 tools are
  `mcp__t3-code__*` (the harness may normalize the server name).
- Skills load with the `Skill` tool by skill name.
- `Bash` runs shell commands. To select a working directory, use e.g.
  `cd /absolute/path/to/worktree && <command>` inside the command.
- Native subagents use the Task/Agent tool; questions use AskUserQuestion.
- Treat tool names and provider IDs in the shared instructions as examples from
  their original harness, not a reason to call OpenCode. Use this harness's
  tools and T3 `delegate_task` with a current provider/model from capabilities.
- The shared skill directories are the source of truth; do not copy or rewrite
  skills into this home. Native skill discovery replaces OpenCode's compact
  skill-catalog plugin.
- Never open live `statev2.sqlite` or `opencode.db` from shell commands or
  scripts, including read-only SQL. Use the T3 tools/APIs, recall, logs, or an
  existing isolated copy. A fresh copy/VACUUM reads the live DB too; ask first.
