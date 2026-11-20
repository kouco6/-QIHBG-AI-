"""Explicit one-time legacy import. Never starts or writes to the old platform.

Default is a reviewable snapshot/report. --apply publishes verified projections;
existing V2 business databases are never overwritten. Identity secrets/sessions
are neither copied nor reported. Unmapped sources remain in the private archive.
"""
import argparse
from contextlib import closing
import json
import os
import re
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from dashboard_snapshot import digest, rows, SnapshotLedger
from dashboard import query_dashboard

def read_db(path):
    return sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)

def backup(source, target):
    with closing(read_db(source)) as src, closing(sqlite3.connect(target)) as dest:
        src.backup(dest)
        dest.execute('PRAGMA journal_mode=DELETE')
    target.chmod(0o600)

def accounts(path):
    with closing(read_db(path)) as db:
        # Deliberately exclude passwords, salts, sessions and personal names.
        return rows(db, 'SELECT id,login,active,role FROM account')

def content_of(state, pid):
    def collection(name):
        container = state.get(name)
        value = container.get(pid) if isinstance(container, dict) else None
        return value if isinstance(value, dict) else {}
    bodies = {k: v['text'] for k,v in collection('bodies').items() if isinstance(v,dict) and isinstance(v.get('text'),str) and v['text'].strip()}
    structures = {}
    for dimension,item in collection('showcases').items():
        if not isinstance(item,dict): continue
        current,draft = item.get('current'),item.get('draft')
        if isinstance(draft,dict):
            if item.get('applied') is False and draft == current: continue
            structures[dimension] = draft
        elif isinstance(current,dict) and item.get('applied') is not False:
            structures[dimension] = current
    return {'bodies': bodies, 'structures': structures}

def project_projection(source, target, as_of):
    """Validate source state/fact hashes before discarding project bodies."""
    with closing(read_db(source)) as src, closing(sqlite3.connect(target)) as dest:
        revision, raw = src.execute('SELECT revision,value FROM app_state WHERE id=1').fetchone()
        state = json.loads(raw)
        meta = dict(src.execute('SELECT key,value FROM planning_meta'))
        if meta.get('schema_version') != '1': raise ValueError('不支持的企划事件版本')
        facts = rows(src, 'SELECT * FROM planning_project_facts')
        events = rows(src, 'SELECT * FROM planning_events ORDER BY occurred_at,seq')
        live = {f['project_id']: f for f in facts if not f['deleted_at']}
        projects = {p['id']:p for p in state['projects']}
        if set(live) != set(projects) or any(live[pid]['last_status'] != p['status'] or live[pid]['content_hash'] != digest(content_of(state,pid)) for pid,p in projects.items()):
            raise ValueError('项目状态与可信事件不一致，不能迁入统计')
        stamp = datetime.fromisoformat(as_of)
        if datetime.fromisoformat(meta['last_clock']) > stamp: raise ValueError('源事件时钟晚于迁移快照')
        if any(datetime.fromisoformat(e['occurred_at']) > stamp for e in events): raise ValueError('源库含未来事件')
        # Fixed schema names, values are always bound parameters.
        for table in ('app_state','planning_meta','planning_project_facts','planning_events'):
            schema = src.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
            dest.execute(schema)
        minimal = {'projects': [{k:p[k] for k in ('id','name','type','status')} for p in projects.values()]}
        dest.execute('INSERT INTO app_state (id,revision,value) VALUES (1,?,?)', (revision,json.dumps(minimal,ensure_ascii=False)))
        dest.executemany('INSERT INTO planning_meta VALUES (?,?)', list(meta.items()) + [('snapshot_as_of',as_of)])
        for table,records in [('planning_project_facts',facts),('planning_events',events)]:
            if records:
                columns = list(records[0]); names = ','.join(columns); placeholders = ','.join('?' for _ in columns)
                dest.executemany(f'INSERT INTO {table} ({names}) VALUES ({placeholders})', [tuple(r[c] for c in columns) for r in records])
        dest.commit()
        # Exercise every period against the reduced source before publication.
        for period in ('all','week','month','year'):
            query = 'period=' + period
            projected_result = query_dashboard(dest,SnapshotLedger(dest),query)
            original_result = query_dashboard(src,SnapshotLedger(src,as_of),query)
            if projected_result != original_result: raise ValueError('最小投影与完整源统计不一致')
        return {'projects':len(projects),'facts':len(facts),'events':len(events),'revision':revision}

def prepare(source, target, archive):
    source,target,archive = source.resolve(),target.resolve(),archive.resolve()
    if source == target or archive == source or archive.is_relative_to(source): raise ValueError('迁移副本不得写入旧数据目录')
    archive.mkdir(parents=True,exist_ok=False);archive.chmod(0o700)
    stamp=datetime.now(timezone.utc).isoformat(timespec='microseconds')
    previous=accounts(source/'identity.sqlite3');current=accounts(target/'identity.sqlite3')
    index={}
    for p in current: index.setdefault(p['login'].strip().lower(),[]).append(p)
    source_counts={}
    for p in previous:
        key=p['login'].strip().lower();source_counts[key]=source_counts.get(key,0)+1
    mapping={};unmapped=[]
    for p in previous:
        hits=index.get(p['login'].strip().lower(),[])
        if source_counts[p['login'].strip().lower()]==1 and len(hits)==1 and hits[0]['active']:
            mapping[p['id']]=hits[0]['id']
        else: unmapped.append({'sourceAccount':p['id'],'login':p['login'],'reason':'目标账号缺失、停用或登录名冲突'})
    manifest={'sourceData':str(source),'targetData':str(target),'asOf':stamp,'accountMap':mapping,'unmapped':unmapped,'statistics':[], 'errors':[], 'exhibitions':None}
    projected=archive/'projected';projected.mkdir(mode=0o700)
    exhibition=source/'exhibitions.sqlite3'
    if exhibition.is_file():
        backup(exhibition,archive/'exhibitions-source.sqlite3')
        backup(archive/'exhibitions-source.sqlite3',projected/'exhibitions.sqlite3')
        with closing(sqlite3.connect(projected/'exhibitions.sqlite3')) as db, db:
            manifest['exhibitions']={t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ('exhibition','exhibition_topic','exhibition_maintainer')}
            old=[r[0] for r in db.execute('SELECT account FROM exhibition_maintainer')]
            db.execute('DELETE FROM exhibition_maintainer')
            # Only enabled, currently authorized ordinary V2 members can be maintainers.
            with closing(read_db(target/'identity.sqlite3')) as identity:
                eligible={r[0] for r in identity.execute("SELECT a.id FROM account a JOIN grant_module g ON g.account=a.id WHERE a.active=1 AND a.role='user' AND g.module='bg'")}
            selected={mapping[p] for p in old if p in mapping and mapping[p] in eligible}
            db.executemany('INSERT INTO exhibition_maintainer VALUES (?)',[(p,) for p in selected])
            manifest['exhibitions']['mappedMaintainers']=len(selected)
            manifest['exhibitions']['unmappedMaintainers']=len(set(old))-len(selected)
    else: manifest['errors'].append({'source':'exhibitions','reason':'源展会库不存在'})
    for person in previous:
        account=person['id']
        if not re.fullmatch('[a-f0-9]{32}',account):
            manifest['errors'].append({'sourceAccount':account,'reason':'源账号标识格式不支持'});continue
        path=source/'bg'/account/'platform.sqlite3'
        if not path.is_file(): continue
        private=archive/(account+'-source.sqlite3');backup(path,private)
        dest=projected/((mapping.get(account,account))+'.sqlite3')
        try:
            summary=project_projection(private,dest,stamp);dest.chmod(0o600)
            manifest['statistics'].append({'sourceAccount':account,'targetAccount':mapping.get(account),'file':dest.name,**summary})
        except (sqlite3.Error,ValueError,KeyError,TypeError) as error:
            dest.unlink(missing_ok=True)
            manifest['errors'].append({'sourceAccount':account,'reason':str(error)})
    (archive/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2));(archive/'manifest.json').chmod(0o600)
    return manifest

def publish(target,archive):
    """No replace: a repeated import cannot erase V2 edits or an earlier snapshot."""
    manifest=json.loads((archive/'manifest.json').read_text())
    destinations=[]
    if manifest['exhibitions'] is not None: destinations.append((archive/'projected/exhibitions.sqlite3',target/'exhibitions.sqlite3'))
    for p in manifest['statistics']:
        if p['targetAccount']:
            destinations.append((archive/'projected'/p['file'],target/'planning-statistics'/p['file']))
    if any(dest.exists() for _,dest in destinations): raise ValueError('目标业务库已存在，拒绝覆盖；请核查迁移报告')
    installed = []
    try:
        for src,dest in destinations:
            dest.parent.mkdir(parents=True,exist_ok=True)
            # Fully write a private target-side temporary file before exclusive publication.
            with tempfile.NamedTemporaryFile(dir=dest.parent,delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(src.read_bytes()); stream.flush(); os.fsync(stream.fileno())
            try:
                temporary.chmod(0o600)
                os.link(temporary,dest)  # Fails atomically if another writer won.
                installed.append(dest)
            finally: temporary.unlink(missing_ok=True)
    except Exception:
        for dest in installed: dest.unlink()
        raise
    manifest['published']=[str(dest.relative_to(target)) for _,dest in destinations]
    (archive/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    return manifest

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-data',type=Path);p.add_argument('--target-data',type=Path,required=True)
    p.add_argument('--archive',type=Path,required=True);p.add_argument('--apply',action='store_true')
    args=p.parse_args()
    if args.archive.exists(): manifest=json.loads((args.archive/'manifest.json').read_text())
    else:
        if not args.source_data: p.error('制作副本时必须指定 --source-data')
        manifest=prepare(args.source_data,args.target_data,args.archive)
    if args.apply: manifest=publish(args.target_data,args.archive)
    print(json.dumps(manifest,ensure_ascii=False,indent=2))
if __name__=='__main__': main()
