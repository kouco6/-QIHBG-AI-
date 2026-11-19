"""Package only this independent V2 project; never include the parent workspace."""
import argparse,hashlib,json,stat,tempfile,zipfile,re,os
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
IGNORE={'node_modules','dist','.runtime','data','release','__pycache__','.git','.cache','.vite','.pytest_cache','test-results','playwright-report'}
SUFFIX={'.zip','.sha256','.pyc','.pyo','.tsbuildinfo','.log','.db','.sqlite','.sqlite3','.pem','.key','.bak','.tmp'}
PRIVATE={'private-token','session-key','control.json','.DS_Store','.env','.env.development.local'}
PATTERN=re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|AKIA[0-9A-Z]{16})\b')
def allowed(path):
    return not IGNORE.intersection(path.parts) and path.suffix not in SUFFIX and path.name not in PRIVATE and '.local' not in path.name and not path.name.startswith(('._','secrets','credentials')) and (not path.name.startswith('.env') or path.name=='.env.example')
def sha(data):return hashlib.sha256(data).hexdigest()
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'release/QIHBG-platform-V2.0-standalone-source-20261119.zip')
    args=parser.parse_args();snapshot={}
    for folder,dirs,files in os.walk(ROOT,followlinks=False):
        dirs[:]=[d for d in dirs if d not in IGNORE and not (Path(folder)/d).is_symlink()]
        for name in files:
            path=Path(folder)/name;rel=path.relative_to(ROOT)
            if not allowed(rel) or path.is_symlink() or name=='SOURCE-MANIFEST.json':continue
            data=path.read_bytes()
            if data.startswith(b'SQLite format 3\0') or PATTERN.search(data):raise ValueError('Private data detected: '+str(rel))
            snapshot[rel.as_posix()]=(data,stat.S_IMODE(path.stat().st_mode),path)
    assert not any(n.startswith(('modules/','portal/','config/')) for n in snapshot)
    for forbidden in ['services/ai-gateway/public/index.html','services/ai-gateway/public/login.html','services/ai-gateway/public/login.js','services/ai-gateway/installer/install.mjs']:
        assert forbidden not in snapshot,forbidden
    required=['web/src/App.tsx','backend/http_server.py','backend/identity.py','baseline/manifest.json','services/ai-gateway/src/server.mjs','scripts/run.py','README.md','进度&规则.md']
    assert all(n in snapshot for n in required),'Missing V2 source'
    manifest={'format':'qihbg-v2-independent-source-v1','date':'2026-11-19','scope':'Independent V2 frontend, capabilities, necessary backend, task service and V2 baseline; no original platform shell or unrelated modules',
              'files':[{'path':n,'size':len(b),'sha256':sha(b)} for n,(b,_,_) in sorted(snapshot.items())]}
    manifest_bytes=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()
    snapshot['SOURCE-MANIFEST.json']=(manifest_bytes,0o644,None)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    prefix='QIHBG-platform-V2.0/'
    with tempfile.TemporaryDirectory(dir=args.output.parent,prefix='packing-v2-') as tmp:
        output=Path(tmp)/args.output.name
        with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
            for name,(body,mode,_) in sorted(snapshot.items()):
                entry=zipfile.ZipInfo(prefix+name,(2026,11,19,0,0,0));entry.create_system=3;entry.external_attr=(stat.S_IFREG|mode)<<16
                z.writestr(entry,body,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
        with zipfile.ZipFile(output) as z:
            assert z.testzip() is None
            assert len(z.namelist())==len(set(z.namelist()))==len(snapshot)
            for name,(body,_,origin) in snapshot.items():
                assert z.read(prefix+name)==body,name
                if origin:assert origin.read_bytes()==body,'Source changed: '+name
        checksum=sha(output.read_bytes());output.replace(args.output)
    args.output.with_suffix('.zip.sha256').write_text(checksum+'  '+args.output.name+'\n')
    (ROOT/'SOURCE-MANIFEST.json').write_bytes(manifest_bytes)
    print(json.dumps({'file':str(args.output),'files':len(snapshot),'MiB':round(args.output.stat().st_size/1024**2,2),'sha256':checksum,'verified':True},ensure_ascii=False))
if __name__=='__main__':main()
