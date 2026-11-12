"""Seek existing encrypted restic blobs without a plaintext filesystem copy."""
import bisect
import contextlib
import importlib
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import struct
import subprocess
import sys
import uuid

from redact import RedactionError


def apsw_module():
    try:return importlib.import_module('apsw')
    except ImportError:
        site=Path(__file__).resolve().parents[1]/'venv/redact-reader/lib'/f'python{sys.version_info.major}.{sys.version_info.minor}/site-packages'
        if site.is_dir():sys.path.insert(0,str(site))
        try:return importlib.import_module('apsw')
        except ImportError:raise RedactionError('install the diskless restic reader dependencies') from None


def password(env):
    if env.get('RESTIC_PASSWORD'):return env['RESTIC_PASSWORD']
    if env.get('RESTIC_PASSWORD_FILE'):return Path(env['RESTIC_PASSWORD_FILE']).read_text().rstrip('\r\n')
    command=shlex.split(env.get('RESTIC_PASSWORD_COMMAND',''))
    if not command:raise RedactionError('restic password configuration missing')
    result=subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,env=env)
    if result.returncode:raise RedactionError('restic password helper failed')
    return result.stdout.decode().rstrip('\r\n')


class BlobImage:
    def __init__(self,repo,snapshot,path):
        from redact_backups import restic,restic_env
        entry=PurePosixPath(path)
        tree=restic(repo,'cat','tree',snapshot+':'+str(entry.parent),json_output=True)
        nodes=[n for n in tree['nodes'] if n['name']==entry.name and n['type']=='file']
        if len(nodes)!=1:raise RedactionError('snapshot file identity mismatch')
        node=nodes[0];self.size=node['size'];self.ids=node.get('content',[])
        executable=Path(os.environ.get('RECALL_RESTIC_READER',Path(__file__).resolve().parents[1]/'bin/recall-restic-reader'))
        if not executable.is_file():raise RedactionError('install the diskless restic reader helper')
        self.proc=subprocess.Popen([str(executable),str(repo)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        try:
            self.send({'password':password(restic_env()),'ids':self.ids})
            sizes=json.loads(self.proc.stdout.readline())
            if len(sizes)!=len(self.ids) or any(not isinstance(n,int) or n<=0 for n in sizes):
                raise RedactionError('invalid restic blob sizes')
            self.offsets=[0]
            for size in sizes:self.offsets.append(self.offsets[-1]+size)
            if self.offsets[-1]!=self.size:raise RedactionError('snapshot file length mismatch')
        except BaseException:
            self.close();raise

    def send(self,value):
        self.proc.stdin.write(json.dumps(value).encode()+b'\n');self.proc.stdin.flush()

    def exact(self,count):
        value=bytearray()
        while len(value)<count:
            part=self.proc.stdout.read(count-len(value))
            if not part:raise RedactionError('restic reader stopped')
            value.extend(part)
        return bytes(value)

    def __len__(self):return self.size

    def __getitem__(self,key):
        if isinstance(key,int):
            if key<0:key+=self.size
            if not 0<=key<self.size:raise IndexError()
            return self[key:key+1][0]
        start,end,step=key.indices(self.size)
        if step!=1:raise RedactionError('unsupported restic byte range')
        result=bytearray()
        while start<end:
            index=bisect.bisect_right(self.offsets,start)-1
            count=min(end-start,self.offsets[index+1]-start,1<<20)
            self.send({'id':self.ids[index],'offset':start-self.offsets[index],'count':count})
            if struct.unpack('>I',self.exact(4))[0]!=count:raise RedactionError('restic range length mismatch')
            result.extend(self.exact(count));start+=count
        return bytes(result)

    def __contains__(self,needle):
        tail=b''
        for start in range(0,self.size,1<<20):
            value=tail+self[start:min(start+(1<<20),self.size)]
            if needle in value:return True
            tail=value[-(len(needle)-1):] if len(needle)>1 else b''
        return False

    def close(self):
        # EOF lets the helper's deferred unlock run; never kill a read lock owner.
        if self.proc.stdin and not self.proc.stdin.closed:self.proc.stdin.close()
        self.proc.stdout.close();self.proc.wait()


@contextlib.contextmanager
def sqlite_connection(image):
    apsw=apsw_module()
    class File:
        def xRead(self,amount,offset):
            value=image[offset:offset+amount]
            if offset<20 and offset+len(value)>18:
                value=bytearray(value)
                for position in (18,19):
                    if offset<=position<offset+len(value):value[position-offset]=1
                value=bytes(value)
            return value
        def xFileSize(self):return len(image)
        def xClose(self):pass
        def xLock(self,level):pass
        def xUnlock(self,level):pass
        def xCheckReservedLock(self):return False
        def xFileControl(self,operation,pointer):return False
        def xSectorSize(self):return 4096
        def xDeviceCharacteristics(self):return apsw.SQLITE_IOCAP_IMMUTABLE
    class VFS(apsw.VFS):
        def xOpen(self,name,flags):
            if flags[0]&(apsw.SQLITE_OPEN_READWRITE|apsw.SQLITE_OPEN_CREATE):raise apsw.ReadOnlyError()
            flags[1]=apsw.SQLITE_OPEN_READONLY
            return File()
        def xAccess(self,name,flags):return False
        def xFullPathname(self,name):return name
    name='recall-redact-'+uuid.uuid4().hex
    vfs=VFS(name,'')
    con=None
    try:
        con=apsw.Connection('snapshot',flags=apsw.SQLITE_OPEN_READONLY,vfs=name)
        con.limit(apsw.SQLITE_LIMIT_LENGTH,128<<20)
        yield con
    finally:
        if con is not None:con.close()
        vfs.unregister()
