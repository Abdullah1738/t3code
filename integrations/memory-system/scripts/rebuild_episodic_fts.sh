#!/bin/bash
# One-off: rebuild episodic_fts after fixing the external-content triggers.
cd "$HOME/.local/share/memory-system" || exit 1
date '+%F %T start'
sqlite3 data/memory.db <<'SQL'
.timeout 600000
.timer on
select count(*) from episodic_fts_docsize;
insert into episodic_fts(episodic_fts) values('rebuild');
select count(*) from episodic_fts_docsize;
select count(*) from episodic_events;
pragma wal_checkpoint(TRUNCATE);
SQL
date '+%F %T done'
