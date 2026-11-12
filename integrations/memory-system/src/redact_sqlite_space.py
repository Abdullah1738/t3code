"""Locate SQLite space outside live cells without writing a database image."""
from redact import RedactionError


def regions(data, roots):
    page_size = int.from_bytes(data[16:18],'big') or 65536
    if page_size == 1:
        page_size = 65536
    usable = page_size-data[20]
    def page(number):
        start=(number-1)*page_size
        if number<1 or start+page_size>len(data):
            raise RedactionError('invalid SQLite page reference')
        return data[start:start+page_size]
    def u16(p,offset):
        return int.from_bytes(p[offset:offset+2],'big')
    def u32(p,offset):
        return int.from_bytes(p[offset:offset+4],'big')
    def varint(p,offset):
        value=0
        for i in range(9):
            b=p[offset+i]
            value=(value<<8 | b) if i==8 else (value<<7 | (b&127))
            if b<128 or i==8:
                return value,i+1
        raise RedactionError('invalid SQLite varint')
    # One byte per page keeps accounting near26MiB for a100GiB/4KiB image.
    flags=bytearray(len(data)//page_size)
    def mark(number,bits):
        if not 1<=number<=len(flags):raise RedactionError('invalid SQLite page reference')
        flags[number-1]|=bits
    pending=list(roots)
    while pending:
        number=pending.pop()
        if not 1<=number<=len(flags):raise RedactionError('invalid SQLite page reference')
        if flags[number-1]&2:
            continue
        mark(number,3)
        p=page(number);h=100 if number==1 else 0;kind=p[h]
        if kind not in (2,5,10,13):
            raise RedactionError('unsupported SQLite btree page')
        interior=kind in (2,5);header=h+(12 if interior else 8)
        count=u16(p,h+3);start=u16(p,h+5) or 65536
        end=header+count*2
        if not (end<=start<=usable):
            raise RedactionError('invalid SQLite cell area')
        yield p[end:start]
        if p[h+7]:
            # Tiny fragments have no location map. Never certify them absent.
            raise RedactionError('fragmented SQLite free space needs deeper inspection')
        free=u16(p,h+1);free_seen=set()
        while free:
            if free in free_seen or free<start or free+4>usable:
                raise RedactionError('invalid SQLite free block')
            free_seen.add(free);size=u16(p,free+2)
            if size<4 or free+size>usable:
                raise RedactionError('invalid SQLite free block size')
            yield p[free+4:free+size]
            free=u16(p,free)
        if interior:
            pending.append(u32(p,h+8))
        for i in range(count):
            cell=u16(p,header+i*2)
            if interior:
                pending.append(u32(p,cell));cell+=4
            if kind==5:
                continue
            payload,width=varint(p,cell);cell+=width
            if kind==13:
                _,width=varint(p,cell);cell+=width
            maximum=usable-35 if kind==13 else ((usable-12)*64)//255-23
            minimum=((usable-12)*32)//255-23
            if payload<=maximum:
                continue
            local=minimum+(payload-minimum)%(usable-4)
            if local>maximum:
                local=minimum
            overflow=u32(p,cell+local);remaining=payload-local;chain=set()
            while remaining:
                if overflow in chain:
                    raise RedactionError('cyclic SQLite overflow')
                chain.add(overflow);mark(overflow,1);op=page(overflow);used=min(remaining,usable-4)
                if remaining<=usable-4:
                    yield op[4+used:usable]
                remaining-=used;overflow=u32(op,0)
    trunk=int.from_bytes(data[32:36],'big')
    while trunk:
        if not 1<=trunk<=len(flags):raise RedactionError('invalid SQLite freelist page')
        if flags[trunk-1]&4:
            raise RedactionError('cyclic SQLite freelist')
        mark(trunk,5);p=page(trunk);count=u32(p,4)
        if 8+count*4>usable:
            raise RedactionError('invalid SQLite freelist')
        for i in range(count):
            leaf=u32(p,8+i*4);mark(leaf,1)
            yield page(leaf)
        yield p[8+count*4:usable]
        trunk=u32(p,0)

    if 0 in flags:
        raise RedactionError('unclassified SQLite pages remain')
