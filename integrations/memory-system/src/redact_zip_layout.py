"""Reject ZIP bytes that the selected central directory does not describe."""
import struct

from redact import RedactionError


def validate(encoded,archive):
    # ZipFile deliberately supports self-extracting/concatenated archives. Those
    # prefixes and gaps cannot be certified by inspecting its last directory.
    central_end=archive.fp.tell()
    if encoded[central_end:central_end+4]!=b'PK\x05\x06' or central_end+22>len(encoded):
        raise RedactionError('unsupported ZIP directory trailer')
    comment_size=int.from_bytes(encoded[central_end+20:central_end+22],'little')
    if central_end+22+comment_size!=len(encoded):
        raise RedactionError('unclassified ZIP trailing bytes')
    cursor=0;records=[]
    for member in sorted(archive.infolist(),key=lambda m:m.header_offset):
        if member.header_offset!=cursor or encoded[cursor:cursor+4]!=b'PK\x03\x04':
            raise RedactionError('unclassified ZIP prefix or local-record gap')
        if cursor+30>len(encoded):raise RedactionError('incomplete ZIP local header')
        header=encoded[cursor:cursor+30]
        flags=int.from_bytes(header[6:8],'little');method=int.from_bytes(header[8:10],'little')
        if flags!=member.flag_bits or method!=member.compress_type or flags&1 or method not in (0,8):
            raise RedactionError('unsupported ZIP local record')
        if method==0 and member.compress_size!=member.file_size:
            raise RedactionError('inconsistent stored ZIP sizes')
        name_end=cursor+30+int.from_bytes(header[26:28],'little')
        start=name_end+int.from_bytes(header[28:30],'little')
        end=start+member.compress_size
        if end>archive.start_dir:raise RedactionError('overlapping ZIP records')
        name=encoded[cursor+30:name_end]
        if name.decode('utf-8' if flags&0x800 else 'cp437')!=member.orig_filename:
            raise RedactionError('inconsistent ZIP member names')
        records.append((member,start,end,name,encoded[name_end:start]))
        if flags&8:
            wide=header[18:22]==b'\xff'*4 or header[22:26]==b'\xff'*4
            expected=struct.pack('<IQQ' if wide else '<III',member.CRC,member.compress_size,member.file_size)
            candidates=[n for block in (expected,b'PK\x07\x08'+expected)
                        if encoded[end:end+(n:=len(block))]==block]
            if len(candidates)!=1:raise RedactionError('ambiguous ZIP data descriptor')
            end+=candidates[0]
        cursor=end
    if cursor!=archive.start_dir:
        raise RedactionError('unclassified ZIP local-record bytes')
    return records
