# Codex tool mechanics

- Codex has its own code mode: `exec` calls `tools.exec_command` for shell
  commands. MCP tools are called directly by name; T3 tools are on the
  `t3-code` MCP server.
- Read skills with the shell from `$CODEX_HOME/skills/<name>/SKILL.md`.
- GPT models and GPT subagents using Codex can generate images themselves
  with Codex's built-in image tool.
