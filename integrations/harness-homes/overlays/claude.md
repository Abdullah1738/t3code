# Claude Code tool mechanics

- MCP tools appear as `mcp__<server>__<tool>`; T3 tools are
  `mcp__t3-code__*` (the harness may normalize the server name).
- Skills load with the `Skill` tool by skill name.
- `Bash` runs shell commands. To select a working directory, use e.g.
  `cd /absolute/path/to/worktree && <command>` inside the command.
- Native subagents use the Task/Agent tool; questions use AskUserQuestion.
