"""Inspect persisted FTS5 terms independently of live posting visibility."""
import re
import sqlite3
import contextlib

from redact import RedactionError, qi, selector_variants


def varint(data, offset, limit):
    value=0
    for i in range(9):
        if offset+i>=limit:raise RedactionError('incomplete FTS5 varint')
        byte=data[offset+i]
        value=(value<<8|byte) if i==8 else (value<<7|(byte&127))
        if byte<128 or i==8:return value,offset+i+1
    raise RedactionError('invalid FTS5 varint')


def leaf_terms(data):
    # FTS5's page footer lists delta-encoded term offsets. Each page starts
    # with a complete term; subsequent terms reuse a prefix of their predecessor.
    if len(data)<4:raise RedactionError('incomplete FTS5 leaf')
    end=int.from_bytes(data[2:4],'big')
    if not 4<=end<=len(data):raise RedactionError('invalid FTS5 leaf size')
    offset=end;position=0;previous=b'';first=True
    while offset<len(data):
        delta,offset=varint(data,offset,len(data));position+=delta
        if not delta or not 4<=position<end:raise RedactionError('invalid FTS5 term offset')
        cursor=position;keep=0
        if not first:keep,cursor=varint(data,cursor,end)
        size,cursor=varint(data,cursor,end)
        if not size or keep>len(previous) or cursor+size>end:
            raise RedactionError('invalid FTS5 prefix-compressed term')
        previous=previous[:keep]+data[cursor:cursor+size];first=False
        yield previous


def physical_hits(con, name, sql, needle):
    if not re.search(r'\busing\s+fts5\b',sql,re.I):
        raise RedactionError('physical inspection requires FTS5')
    if re.search(r'\b(tokenize|tokendata)\s*=',sql,re.I):
        raise RedactionError('custom FTS tokenizer needs physical inspection support')
    # The default unicode61 tokenizer is also used by recall's two indexes.
    # A separate in-memory index avoids changing the historical image.
    choices=tuple(selector_variants(needle))
    with contextlib.closing(sqlite3.connect(':memory:')) as probe:
        probe.execute('CREATE VIRTUAL TABLE selector USING fts5(value)')
        probe.execute("CREATE VIRTUAL TABLE vocabulary USING fts5vocab(selector,'instance')")
        def tokenize(text):
            probe.execute('DELETE FROM selector')
            probe.execute('INSERT INTO selector(value) VALUES(?)',(text,))
            return tuple(row[0].encode() for row in probe.execute('SELECT term FROM vocabulary ORDER BY offset'))
        tokens=tokenize(''.join(row[0] for row in choices))
        wanted=set(tokens)
        # A second JSON layer may itself Unicode-escape an earlier escape's
        # spelling. Include that finite alphabet when propagating uncertainty.
        units={row[0]:row for row in (*choices,*selector_variants(b'\\u0123456789abcdefABCDEFbtnfr/"'))}
        obligations={char:tuple(tokenize(option) for option in row) for char,row in units.items()}
    needed=wanted|{token for forms in obligations.values() for form in forms for token in form}
    if not needed:return 0
    def matcher_for(missing):
        return re.compile(b'(?=('+b'|'.join(re.escape(t) for t in sorted(missing,key=len,reverse=True))+b'))') if missing else None
    matcher=matcher_for(needed)
    found=set()
    for rowid,data in con.execute(f'SELECT id,block FROM {qi(name+"_data")} WHERE id>10'):
        segment=rowid>>37
        if segment>65535:continue  # Contentless-delete tombstone hash pages.
        if not segment or ((rowid>>31)&63):continue  # Doclist indexes contain integers.
        if not rowid&0x7fffffff:raise RedactionError('invalid FTS5 segment page')
        before=len(found)
        for term in leaf_terms(data):
            if matcher and term[:1]==b'0':
                for match in matcher.finditer(term[1:]):
                    value=match.group(1)
                    if value not in found:found.update(token for token in needed-found if token in value)
        if len(found)!=before:matcher=matcher_for(needed-found)
    if wanted and wanted<=found:
        if len(tokens)==1:
            # A longer normalized word is evidence of a possible substring,
            # not proof of the literal's original spelling or boundaries.
            return 1
        # Term presence alone cannot prove adjacency across deleted postings.
        raise RedactionError('physical FTS terms cannot rule out a deleted selector phrase')
    possible={char for char,forms in obligations.items() if all(t in found for t in forms[0])}
    encoded=False
    for char,forms in obligations.items():
        if any(form and all(t in found for t in form) for form in forms[1:]):
            possible.add(char);encoded=True
    if encoded:
        # Terms have no recoverable JSON string boundaries or deleted-posting
        # adjacency. Close over nested escape spellings, retaining uncertainty
        # whenever any accepted mixture could still represent the selector.
        changed=True
        while changed:
            changed=False
            for char,row in units.items():
                if char not in possible and any(all(c in possible for c in option) for option in row[1:]):
                    possible.add(char);changed=True
        if all(row[0] in possible for row in choices):
            raise RedactionError('physical FTS terms cannot rule out an encoded selector')
    return 0
