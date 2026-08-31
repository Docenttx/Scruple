"""Canonical .blend digest: pointers -> block index; named runtime fields zeroed;
UI/window datablocks excluded. Uses only DNA1, which the file carries."""
import sys,struct,hashlib
sys.path.insert(0,'/data/oss-study/cad/blendlab')
import canon
ZERO={('ID','recalc_after_undo_push'),('ID','session_uuid'),('ID','recalc'),
      ('ID','tag'),('ID','us'),('SessionUUID','uuid_'),
      ('Mesh','face_sets_color_seed'),('CurveProfile','changed_timestamp'),
      ('CurveMapping','cm[4]'),('Link','*next')}
UI_CODES={b'WM\0\0',b'WS\0\0',b'SN\0\0',b'TEST',b'REND',b'GLOB'}
UI_STRUCTS={'wmWindowManager','wmWindow','WorkSpace','bScreen','ScrArea','ScrEdge',
            'ScrVert','SpaceLink','ARegion','View3D','RegionView3D','WorkSpaceLayout',
            'WorkSpaceDataRelation','wmWindowManager','uiList','ScrAreaMap','Panel'}
def zero_rec(b,structs,types,names,tlen,ps,sidx,base,depth):
    if depth>3 or sidx>=len(structs): return
    t,flds=structs[sidx]; sname=types[t]; off=base
    for ft,fn in flds:
        nm=names[fn]; sz=canon.field_size(ft,fn,names,tlen,ps)
        if (sname,nm) in ZERO:
            b['data'][off:off+sz]=b'\0'*sz
        elif ft in by_type_g and not nm.startswith('*') and tlen[ft]>0:
            zero_rec(b,structs,types,names,tlen,ps,by_type_g[ft],off,depth+1)
        off+=sz

by_type_g={}

def zero_named(b,structs,types,names,tlen,ps,sidx,base=0,depth=0):
    if depth>4 or sidx>=len(structs): return
    t,flds=structs[sidx]; sname=types[t]; off=base
    for ft,fn in flds:
        nm=names[fn]; sz=canon.field_size(ft,fn,names,tlen,ps)
        if (sname,nm) in ZERO:
            b['data'][off:off+sz]=b'\0'*sz
        off+=sz
def digest(path):
    blocks,ps,en=canon.read_blocks(path)
    dna=[x for x in blocks if x['code']==b'DNA1'][0]
    names,types,tlen,structs,by_type=canon.parse_dna(bytes(dna['data']),en)
    global by_type_g
    by_type_g=by_type
    pi={x['old']:i for i,x in enumerate(blocks)}
    h=hashlib.sha256(); kept=0
    for b in blocks:
        canon.normalise(b,structs,by_type,names,types,tlen,ps,en,pi)
        sname=types[structs[b['sdna']][0]] if b['sdna']<len(structs) else 'raw'
        if b['code'] in UI_CODES or sname in UI_STRUCTS: continue
        if b['sdna']<len(structs):
            # zero named runtime fields, incl. the embedded ID sub-struct
            t,flds=structs[b['sdna']]; off=0
            for ft,fn in flds:
                sz=canon.field_size(ft,fn,names,tlen,ps)
                if (types[t],names[fn]) in ZERO: b['data'][off:off+sz]=b'\0'*sz
                elif ft in by_type and not names[fn].startswith('*') and tlen[ft]>0:
                    zero_rec(b,structs,types,names,tlen,ps,by_type[ft],off,0)
                off+=sz
        kept+=1
        h.update(b['code']); h.update(struct.pack('<iii',b['size'],b['sdna'],b['cnt']))
        h.update(bytes(b['data']))
    return h.hexdigest(),kept
for p in sys.argv[1:]:
    d,k=digest(p); print(f"{p:22} {d[:32]}  blocks_hashed={k}")
