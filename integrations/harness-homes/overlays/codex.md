# Codex tool mechanics

- Codex has its own code mode: `exec` calls `tools.exec_command` for shell
  commands. MCP tools are called directly by name; T3 tools are on the
  `t3-code` MCP server.
- Read skills with the shell from `$CODEX_HOME/skills/<name>/SKILL.md`.
- GPT models and GPT subagents using Codex can generate images themselves
  with Codex's built-in image tool.
- Treat tool names and provider IDs in the shared instructions as examples from
  their original harness, not a reason to call OpenCode. Use this harness's
  tools and T3 `delegate_task` with a current provider/model from capabilities.
- The shared skill directories are the source of truth; do not copy or rewrite
  skills into this home. Native skill discovery replaces OpenCode's compact
  skill-catalog plugin.
- Never open live `statev2.sqlite` or `opencode.db` from shell commands or
  scripts, including read-only SQL. Use the T3 tools/APIs, recall, logs, or an
  existing isolated copy. A fresh copy/VACUUM reads the live DB too; ask first.
