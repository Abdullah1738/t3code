"""Inspect persisted FTS5 terms independently of live posting visibility."""
import re
import sqlite3
import contextlib

from redact import RedactionError, qi


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
    with contextlib.closing(sqlite3.connect(':memory:')) as probe:
        probe.execute('CREATE VIRTUAL TABLE selector USING fts5(value)')
        probe.execute('INSERT INTO selector(value) VALUES(?)',(needle.decode(),))
        probe.execute("CREATE VIRTUAL TABLE vocabulary USING fts5vocab(selector,'instance')")
        tokens=[row[0].encode() for row in probe.execute('SELECT term FROM vocabulary ORDER BY offset')]
        wanted=set(tokens)
    if not wanted:return 0
    found=set()
    for rowid,data in con.execute(f'SELECT id,block FROM {qi(name+"_data")} WHERE id>10'):
        segment=rowid>>37
        if segment>65535:continue  # Contentless-delete tombstone hash pages.
        if not segment or ((rowid>>31)&63):continue  # Doclist indexes contain integers.
        if not rowid&0x7fffffff:raise RedactionError('invalid FTS5 segment page')
        for term in leaf_terms(data):
            if term[:1]==b'0':found.update(token for token in wanted if token in term[1:])
    if found==wanted:
        if len(tokens)==1:
            # A longer normalized word is evidence of a possible substring,
            # not proof of the literal's original spelling or boundaries.
            return 1
        # Term presence alone cannot prove adjacency across deleted postings.
        raise RedactionError('physical FTS terms cannot rule out a deleted selector phrase')
    return 0
