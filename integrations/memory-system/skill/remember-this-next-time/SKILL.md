---
name: remember-this-next-time
description: Save an explicit standing instruction when Abdullah says remember this next time, next time do X, or don't do Y again.
---

# Remember this next time

When Abdullah gives a standing instruction, save his wording to the rules index with
`recall_remember`. This is separate from searching old transcripts. Rules are checked
on the first prompt, after compaction, and before actions they cover.

Pass these fields:

- `text`: his instruction, intact. Don't turn a suggestion or an unapproved proposal
  into a rule. Save the correction, not the surrounding conversation.
- `scope`: an absolute project directory for project-only rules, `crpko` for an
  explicitly Crpko-wide instruction, or an empty string for a general instruction.
- `actions`: action labels when clear, such as `message`, `comment`, `git.push`,
  `git.commit`, `file.write`, `deploy`, `order`, `booking`, or `payment`. Omit this
  field if unclear; the index derives conservative triggers from the source text.
- `recipient`: the named recipient, if the instruction is specific to someone.
- `source_session` and `source_event`: the current session and event reference when
  available. Keep the citation so a future check can show where it came from.

Use the server's `recall_remember` tool. If it isn't exposed in this harness, use
`recall remember --help` for the installed CLI's supported arguments. Never write
SQLite or edit runtime files directly. Don't claim it was saved unless the save
returns the rule with its citation; report an unavailable save plainly.

Keep the acknowledgement short. Saving a rule does not authorize the action it
describes, and old rules do not override the current request. Block only when a
specific applicable cited instruction clearly conflicts with the proposed action;
otherwise supply context and proceed under the current request.
