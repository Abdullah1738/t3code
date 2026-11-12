"""Diskless, count-only inspection of historical recall containers."""
import contextlib
import io
import re
import zlib
import sqlite3
import subprocess
import threading
import zipfile

from redact import RedactionError, contains, decode_cell, qi, tables, patterns
from redact_sqlite_space import regions
from redact_zip_layout import validate as validate_zip_layout
from redact_fts import physical_hits

MAX_IMAGE_BYTES = 128 * 1024 * 1024
MAX_DEPTH = 8


class Prefix(io.RawIOBase):
    def __init__(self, prefix, stream):
        self.prefix, self.stream = memoryview(prefix), stream

    def readable(self):
        return True

    def readinto(self, target):
        if self.prefix:
            n = min(len(target), len(self.prefix))
            target[:n] = self.prefix[:n]
            self.prefix = self.prefix[n:]
            return n
        chunk = self.stream.read(len(target))
        target[:len(chunk)] = chunk
        return len(chunk)


class EncodedTap(io.RawIOBase):
    def __init__(self, source, needle):
        self.source,self.needle,self.tail,self.hits=source,needle,b'',0
        self.overlap=max(map(len,patterns(needle)))-1

    def readable(self):
        return True

    def readinto(self, target):
        chunk=self.source.read(len(target))
        data=self.tail+chunk
        self.hits+=int(contains(data,self.needle))
        self.tail=data[-self.overlap:] if self.overlap else b''
        target[:len(chunk)]=chunk
        return len(chunk)


def bounded_image(stream):
    data = stream.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise RedactionError('seekable container exceeds diskless inspection budget')
    return data


def sqlite_hits(data, needle):
    # Serialized WAL-mode images otherwise try to open an external WAL. Snapshot
    # sidecars are fenced separately; inspect the complete checkpointed image.
    image=bytearray(data)
    image[18:20]=b'\x01\x01'
    with contextlib.closing(sqlite3.connect(':memory:')) as con:
        con.deserialize(image)
        return sqlite_scan(con,data,needle)


def sqlite_scan(con,data,needle):
    page_size=int.from_bytes(data[16:18],'big')
    if page_size==1:page_size=65536
    if not page_size or len(data)!=int.from_bytes(data[28:32],'big')*page_size:
        raise RedactionError('SQLite image contains unclassified trailing bytes')
    con.execute('PRAGMA cache_size=-8192')
    con.execute('PRAGMA mmap_size=0')
    con.execute('PRAGMA temp_store=MEMORY')
    con.execute('PRAGMA query_only=ON')
    if con.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise RedactionError('SQLite image failed integrity inspection')
    hits = 0
    kinds = tables(con)
    roots=[1]+[r[0] for r in con.execute('SELECT rootpage FROM sqlite_schema WHERE rootpage>0')]
    for table, kind in kinds.items():
        if kind != 'table':
            continue
        columns = [r[1] for r in con.execute(f'PRAGMA table_info({qi(table)})')]
        for row in con.execute(f'SELECT * FROM {qi(table)}'):
            if any(contains(decode_cell(k,v),needle) for k,v in zip(columns,row)):return 1
    query = '"' + needle.decode().replace('"','""') + '"'
    for name,kind in kinds.items():
        if kind!='virtual':continue
        sql=con.execute('SELECT sql FROM sqlite_schema WHERE name=?',(name,)).fetchone()[0]
        if not re.search(r'\busing\s+fts[345]\b',sql,re.I):
            raise RedactionError('unsupported SQLite virtual table')
        table=qi(name)
        hits+=con.execute(f'SELECT count(*) FROM {table} WHERE {table} MATCH ?',(query,)).fetchone()[0]
        if hits:return hits
        hits+=physical_hits(con,name,sql,needle)
    hits += int(needle in data)
    if hits:
        return hits
    if data[20] or int.from_bytes(data[52:56],'big'):
        raise RedactionError('SQLite reserved or pointer-map space needs explicit inspection')
    uncertain=False
    for free in regions(data,roots):
        if not any(free):
            continue
        if contains(free,needle):
            return 1
        for match in re.finditer(rb'\x78[\x01\x5e\x9c\xda]',free):
            decoder=zlib.decompressobj()
            try:
                decoded=decoder.decompress(free[match.start():],MAX_IMAGE_BYTES+1)
            except zlib.error:
                continue
            if contains(decoded,needle):
                return 1
        uncertain=True
    if uncertain:
        raise RedactionError('unallocated SQLite bytes cannot be certified clean')
    return 0


class SingleGzip(io.RawIOBase):
    def __init__(self, source):
        self.source,self.pending,self.finished=source,b'',False
        self.decoder=zlib.decompressobj(31)

    def readable(self):return True

    def readinto(self,target):
        if self.finished:return 0
        while True:
            chunk=self.pending or self.source.read(1<<20)
            if not chunk:raise RedactionError('incomplete gzip member')
            value=self.decoder.decompress(chunk,len(target))
            self.pending=self.decoder.unconsumed_tail
            if self.decoder.eof:
                if self.decoder.unused_data or self.source.read(1):
                    raise RedactionError('additional gzip members or trailing bytes need explicit inspection')
                self.finished=True
            if value:
                target[:len(value)]=value
                return len(value)
            if self.finished:return 0


def single_zstd_frame(source):
    def exact(n):
        value=source.read(n)
        if len(value)!=n:raise RedactionError('incomplete zstd frame')
        return value
    magic=exact(4)
    if magic!=b'\x28\xb5\x2f\xfd':raise RedactionError('unsupported zstd frame')
    yield magic
    descriptor=exact(1);yield descriptor
    flags=descriptor[0]
    if flags&0x18:raise RedactionError('unsupported zstd header flags')
    single=bool(flags&32)
    extra=(0 if single else 1)+(0,1,2,4)[flags&3]+((1 if single else 0),2,4,8)[flags>>6]
    yield exact(extra)
    while True:
        header=exact(3);yield header
        block=int.from_bytes(header,'little');kind=(block>>1)&3;size=block>>3
        if kind==3:raise RedactionError('unsupported zstd block')
        remaining=1 if kind==1 else size
        while remaining:
            chunk=exact(min(remaining,1<<20));remaining-=len(chunk);yield chunk
        if block&1:break
    if flags&4:yield exact(4)
    if source.read(1):raise RedactionError('additional zstd frames or trailing bytes need explicit inspection')


@contextlib.contextmanager
def zstd_stream(source):
    proc = subprocess.Popen(['zstd','-dc'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    errors = []
    def feed():
        try:
            for chunk in single_zstd_frame(source):
                proc.stdin.write(chunk)
        except Exception as exc:
            errors.append(type(exc).__name__)
        finally:
            try:
                proc.stdin.close()
            except OSError as exc:
                errors.append(type(exc).__name__)
    worker = threading.Thread(target=feed,daemon=True)
    worker.start()
    try:
        yield proc.stdout
    finally:
        # Both decoders and restic must reach normal EOF to release their locks.
        while proc.stdout.read(1 << 20):
            pass
        proc.stdout.close()
        worker.join()
        if proc.wait() or errors:
            raise RedactionError('compressed stream inspection failed')


def gzip_input(source, needle):
    header=bytearray(source.read(10))
    if len(header)!=10 or header[3]&0xe0:
        raise RedactionError('invalid gzip header')
    flags=header[3];hits=0
    if flags&4:
        length=source.read(2)
        if len(length)!=2:raise RedactionError('incomplete gzip metadata')
        extra=source.read(int.from_bytes(length,'little'))
        header.extend(length+extra);hits+=int(contains(extra,needle))
    for bit in (8,16):
        if flags&bit:
            value=bytearray()
            while True:
                char=source.read(1)
                if not char:raise RedactionError('incomplete gzip metadata')
                if char==b'\0':break
                value.extend(char)
                if len(value)>MAX_IMAGE_BYTES:raise RedactionError('gzip metadata exceeds inspection budget')
            header.extend(value+b'\0');hits+=int(contains(bytes(value),needle))
    if flags&2:header.extend(source.read(2))
    return io.BufferedReader(Prefix(header,source)),hits


def zip_extra_hits(extra,needle):
    hits=int(contains(extra,needle));cursor=0
    while cursor<len(extra):
        if cursor+4>len(extra):raise RedactionError('incomplete ZIP extra field')
        end=cursor+4+int.from_bytes(extra[cursor+2:cursor+4],'little')
        if end>len(extra):raise RedactionError('incomplete ZIP extra payload')
        field=int.from_bytes(extra[cursor:cursor+2],'little');payload=extra[cursor+4:end]
        hits+=int(contains(payload,needle))
        # Binary prefixes can contain quotes. Try every quoted-string boundary
        # so a prefix cannot consume the opening quote of a JSON-valued field.
        hits+=sum(int(contains(m.group(1),needle)) for m in
                  re.finditer(rb'(?=("(?:[^"\\]|\\.)*"))',payload))
        if field in (0x7075,0x6375):
            if len(payload)<5 or payload[0]!=1:raise RedactionError('unsupported ZIP Unicode extra field')
            hits+=int(contains(payload[5:].decode('utf-8'),needle))
        cursor=end
    return hits


class ZipPayload(io.RawIOBase):
    """Count actual output; ZipExtFile truncates it to the directory's size."""
    def __init__(self,payload,member):
        self.source=io.BytesIO(payload);self.member=member
        self.decoder=zlib.decompressobj(-15) if member.compress_type==8 else None
        self.pending=b'';self.finished=False;self.size=0;self.crc=0

    def readable(self):return True

    def readinto(self,target):
        if self.finished:return 0
        while True:
            if self.decoder is None:
                value=self.source.read(len(target));self.finished=not value
            else:
                chunk=self.pending or self.source.read(1<<20)
                value=self.decoder.decompress(chunk,len(target));self.pending=self.decoder.unconsumed_tail
                if self.decoder.eof:
                    if self.decoder.unused_data or self.source.read(1):
                        raise RedactionError('unclassified ZIP compressed bytes')
                    self.finished=True
                elif not chunk and not value:
                    raise RedactionError('incomplete ZIP deflate stream')
            self.size+=len(value);self.crc=zlib.crc32(value,self.crc)
            if self.size>self.member.file_size or (self.finished and
                    (self.size!=self.member.file_size or self.crc!=self.member.CRC)):
                raise RedactionError('ZIP payload size or checksum mismatch')
            if value:
                target[:len(value)]=value
                return len(value)
            if self.finished:return 0


def inspect_stream(stream, needle, depth=0):
    if depth > MAX_DEPTH:
        raise RedactionError('nested container inspection limit reached')
    header = stream.read(16)
    prefixed = io.BufferedReader(Prefix(header,stream))
    if header == b'SQLite format 3\0':
        return sqlite_hits(bounded_image(prefixed),needle), True
    if header.startswith(b'\x28\xb5\x2f\xfd'):
        tap=EncodedTap(prefixed,needle)
        with zstd_stream(io.BufferedReader(tap)) as decoded:
            hits=inspect_stream(decoded,needle,depth+1)[0]
        return hits+tap.hits, True
    if header.startswith(b'\x1f\x8b'):
        source,metadata_hits=gzip_input(prefixed,needle)
        tap=EncodedTap(source,needle)
        decoded=io.BufferedReader(SingleGzip(io.BufferedReader(tap)))
        hits=inspect_stream(decoded,needle,depth+1)[0]
        return hits+tap.hits+metadata_hits, True
    if header.startswith((b'PK\x03\x04',b'PK\x05\x06')):
        encoded=bounded_image(prefixed)
        with zipfile.ZipFile(io.BytesIO(encoded)) as archive:
            records=validate_zip_layout(encoded,archive)
            hits = int(contains(encoded,needle)) + int(contains(archive.comment,needle))
            if any(m.filename.rstrip('/').lower().endswith(('-wal','-journal')) and m.file_size>0 for m in archive.infolist()):
                raise RedactionError('nested transactional sidecar needs database inspection')
            for member,start,end,local_name,local_extra in records:
                hits += sum(int(contains(v,needle)) for v in (member.filename,member.comment,local_name))
                hits += zip_extra_hits(member.extra,needle)+zip_extra_hits(local_extra,needle)
                with io.BufferedReader(ZipPayload(encoded[start:end],member)) as decoded:
                    hits += inspect_stream(decoded,needle,depth+1)[0]
            return hits, True
    if header.startswith((b'\x37\x7f\x06\x82',b'\x37\x7f\x06\x83',b'\xd9\xd5\x05\xf9\x20\xa1\x63\xd7')):
        raise RedactionError('transactional sidecar needs database inspection')
    if len(header)>=4 and 0x50<=header[0]<=0x5f and header[1:4]==b'\x2a\x4d\x18':
        raise RedactionError('skippable zstd metadata needs explicit inspection')
    return sum(int(contains(line,needle)) for line in prefixed), False
