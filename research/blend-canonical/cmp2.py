import struct,collections
def blocks(p):
    d=open(p,'rb').read(); off=12; out=[]
    while off<len(d):
        code=d[off:off+4]; size=struct.unpack('<i',d[off+4:off+8])[0]
        old=struct.unpack('<Q',d[off+8:off+16])[0]
        sdna,cnt=struct.unpack('<ii',d[off+16:off+24])
        out.append(dict(code=code,size=size,old=old,sdna=sdna,cnt=cnt,off=off,data=d[off+24:off+24+size]))
        if code==b'ENDB': break
        off+=24+size
    return d,out
d1,b1=blocks('p1.1'); d2,b2=blocks('p2.1')
print("same block count:", len(b1)==len(b2))
struct_same=all(x['code']==y['code'] and x['size']==y['size'] and x['sdna']==y['sdna'] and x['cnt']==y['cnt'] for x,y in zip(b1,b2))
print("code/size/sdna/count identical for every block:", struct_same)
hdr_ptr_diff=sum(1 for x,y in zip(b1,b2) if x['old']!=y['old'])
print("blocks whose header old-pointer differs:", hdr_ptr_diff, "of", len(b1))
paydiff=[(x['code'],x['sdna']) for x,y in zip(b1,b2) if x['data']!=y['data']]
print("blocks whose PAYLOAD differs:", len(paydiff))
print(collections.Counter(paydiff).most_common(10))
# Are all differing payload bytes 8-aligned 8-byte words that look like heap pointers?
tot=0; ptrlike=0
for x,y in zip(b1,b2):
    if x['data']==y['data']: continue
    a,b=x['data'],y['data']
    i=0
    while i+8<=len(a):
        if a[i:i+8]!=b[i:i+8]:
            tot+=1
            va=struct.unpack('<Q',a[i:i+8])[0]; vb=struct.unpack('<Q',b[i:i+8])[0]
            # heap pointers on linux arm64 userspace: large, page-ish
            if va>0x1000 and vb>0x1000 and va<0x0000800000000000 and vb<0x0000800000000000:
                ptrlike+=1
        i+=8
print("differing 8-byte words:",tot," of which pointer-range:",ptrlike)
