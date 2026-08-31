"""Build a pointer-normalised digest of a .blend using ONLY the DNA1 block
the file itself carries. If two byte-different saves of the same state hash
equal here, a deterministic .blend digest is constructible with no vendor help."""
import struct,sys,hashlib,re

def read_blocks(path):
    d=open(path,'rb').read()
    assert d[:7]==b'BLENDER'
    ps = 8 if d[7:8]==b'-' else 4
    en = '<' if d[8:9]==b'v' else '>'
    off=12; out=[]
    while off<len(d):
        code=d[off:off+4]; size=struct.unpack(en+'i',d[off+4:off+8])[0]
        old=struct.unpack(en+('Q' if ps==8 else 'I'),d[off+8:off+8+ps])[0]
        sdna,cnt=struct.unpack(en+'ii',d[off+8+ps:off+16+ps])
        hdr=16+ps
        out.append(dict(code=code,size=size,old=old,sdna=sdna,cnt=cnt,
                        data=bytearray(d[off+hdr:off+hdr+size])))
        if code==b'ENDB': break
        off+=hdr+size
    return out,ps,en

def parse_dna(buf,en):
    o=0
    assert buf[o:o+4]==b'SDNA'; o+=4
    assert buf[o:o+4]==b'NAME'; o+=4
    n=struct.unpack(en+'i',buf[o:o+4])[0]; o+=4
    names=[]
    for _ in range(n):
        e=buf.index(b'\0',o); names.append(buf[o:e].decode()); o=e+1
    o=(o+3)&~3
    assert buf[o:o+4]==b'TYPE'; o+=4
    n=struct.unpack(en+'i',buf[o:o+4])[0]; o+=4
    types=[]
    for _ in range(n):
        e=buf.index(b'\0',o); types.append(buf[o:e].decode()); o=e+1
    o=(o+3)&~3
    assert buf[o:o+4]==b'TLEN'; o+=4
    tlen=list(struct.unpack(en+'%dh'%len(types),buf[o:o+2*len(types)])); o+=2*len(types)
    o=(o+3)&~3
    assert buf[o:o+4]==b'STRC'; o+=4
    ns=struct.unpack(en+'i',buf[o:o+4])[0]; o+=4
    structs=[]
    for _ in range(ns):
        t,fc=struct.unpack(en+'hh',buf[o:o+4]); o+=4
        fields=[]
        for _ in range(fc):
            ft,fn=struct.unpack(en+'hh',buf[o:o+4]); o+=4
            fields.append((ft,fn))
        structs.append((t,fields))
    by_type={s[0]:i for i,s in enumerate(structs)}
    return names,types,tlen,structs,by_type

ARR=re.compile(r'\[(\d+)\]')
def name_arraylen(nm):
    n=1
    for m in ARR.finditer(nm): n*=int(m.group(1))
    return n

def field_size(ft,fn,names,tlen,ps):
    nm=names[fn]; a=name_arraylen(nm)
    if nm.startswith('*') or nm.startswith('(*'):
        return ps*a
    return tlen[ft]*a

def normalise(block,structs,by_type,names,types,tlen,ps,en,ptr_index):
    """Walk each struct instance in the block and overwrite pointer fields
    with the canonical index of the block they address."""
    if block['sdna']==0: return          # raw/unstructured DATA
    si=block['sdna']
    if si>=len(structs): return
    t,fields=structs[si]
    esz=tlen[t]
    fmt='Q' if ps==8 else 'I'
    def walk(base,sidx):
        t2,flds=structs[sidx]
        off=base
        for ft,fn in flds:
            nm=names[fn]; a=name_arraylen(nm); sz=field_size(ft,fn,names,tlen,ps)
            if nm.startswith('*') or nm.startswith('(*'):
                for k in range(a):
                    p=off+k*ps
                    if p+ps<=len(block['data']):
                        v=struct.unpack_from(en+fmt,block['data'],p)[0]
                        struct.pack_into(en+fmt,block['data'],p,ptr_index.get(v,0xFFFFFFFF if v else 0))
            elif ft in by_type and tlen[ft]>0:
                for k in range(a):
                    walk(off+k*tlen[ft],by_type[ft])
            off+=sz
    for i in range(max(block['cnt'],1)):
        if (i+1)*esz<=len(block['data']):
            walk(i*esz,si)

def digest(path,verbose=False):
    blocks,ps,en=read_blocks(path)
    dna=[b for b in blocks if b['code']==b'DNA1'][0]
    names,types,tlen,structs,by_type=parse_dna(bytes(dna['data']),en)
    ptr_index={b['old']:i for i,b in enumerate(blocks)}
    h=hashlib.sha256()
    for i,b in enumerate(blocks):
        if b['code'] in (b'TEST',):     # thumbnail: skip? keep for now
            pass
        normalise(b,structs,by_type,names,types,tlen,ps,en,ptr_index)
        h.update(b['code']); h.update(struct.pack('<iii',b['size'],b['sdna'],b['cnt']))
        h.update(bytes(b['data']))
    if verbose: print("  blocks",len(blocks),"structs",len(structs),"names",len(names))
    return h.hexdigest()

if __name__=='__main__':
    for p in sys.argv[1:]:
        print(p, digest(p)[:32])

def norm_blocks(path):
    blocks,ps,en=read_blocks(path)
    dna=[b for b in blocks if b['code']==b'DNA1'][0]
    names,types,tlen,structs,by_type=parse_dna(bytes(dna['data']),en)
    ptr_index={b['old']:i for i,b in enumerate(blocks)}
    for b in blocks: normalise(b,structs,by_type,names,types,tlen,ps,en,ptr_index)
    return blocks,structs,types
