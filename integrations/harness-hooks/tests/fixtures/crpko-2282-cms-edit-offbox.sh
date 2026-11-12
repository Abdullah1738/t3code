python3 - <<'PY'
p='app/data/aurora_stores/cms_read/statements.py';s=open(p).read().replace('"convert_to(\'backoffice:cms:document\', \'UTF8\')"','f"decode(\'{b\'backoffice:cms:document\'.hex()}\', \'hex\')"').replace('"convert_to(\'backoffice:cms:bundle\', \'UTF8\')"','f"decode(\'{b\'backoffice:cms:bundle\'.hex()}\', \'hex\')"');open(p,'w').write(s)
PY
uv run --no-sync ruff format app/data/aurora_stores/cms_read/statements.py
offbox run --bg --include tmp/cms-publication-check/postgres.sh -- bash tmp/cms-publication-check/postgres.sh