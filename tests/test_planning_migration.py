"""Independent synthetic history, isolation, snapshot equivalence and import protections."""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
import test_backend as backend
from test_exhibitions import record, workbook
from dashboard_snapshot import snapshot_dashboard, LedgerError, digest
from exhibitions import Exhibitions
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('migration',ROOT/'scripts/migrate_planning.py')
migration=importlib.util.module_from_spec(spec);spec.loader.exec_module(migration)
STAMP='2026-11-19T04:00:00.000000+00:00'

def history(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    projects=[{'id':pid,'name':'合成'+pid,'type':'测试','status':status} for pid,status in [('done','active'),('new','active'),('legacy','archived')]]
    state={'projects':projects,'bodies':{'done':{'01':{'text':'合成正文，不应迁入运行库'}}}}
    with sqlite3.connect(path) as db:
        db.executescript('''CREATE TABLE app_state(id INTEGER PRIMARY KEY,revision INTEGER,value TEXT);
        CREATE TABLE planning_meta(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE planning_project_facts(project_id TEXT PRIMARY KEY,origin TEXT,created_at TEXT,first_archived_at TEXT,deleted_at TEXT,last_status TEXT,content_hash TEXT);
        CREATE TABLE planning_events(seq INTEGER PRIMARY KEY,project_id TEXT,kind TEXT,occurred_at TEXT,status_after TEXT);''')
        db.execute('INSERT INTO app_state VALUES(1,5,?)',(json.dumps(state),))
        db.executemany('INSERT INTO planning_meta VALUES(?,?)',[('schema_version','1'),('coverage_start','2026-11-01T00:00:00.000000+00:00'),('last_clock','2026-11-18T00:00:00.000000+00:00'),('business_timezone','Asia/Shanghai'),('week_start','0')])
        for p in projects:
            pid=p['id'];created=None if pid=='legacy' else '2026-11-01T16:00:00.000000+00:00'
            db.execute('INSERT INTO planning_project_facts VALUES(?,?,?,?,?,?,?)',(pid,'legacy_unknown' if pid=='legacy' else 'tracked',created,'2026-11-10T16:00:00.000000+00:00' if pid=='done' else None,None,p['status'],digest(migration.content_of(state,pid))))
        db.execute('INSERT INTO planning_project_facts VALUES(?,?,?,?,?,?,?)',('deleted','tracked','2026-11-01T16:00:00.000000+00:00','2026-11-10T16:00:00.000000+00:00','2026-11-15T00:00:00.000000+00:00','archived',digest({})))
        db.executemany('INSERT INTO planning_events VALUES(?,?,?,?,?)',[(1,'done','created','2026-11-01T16:00:00.000000+00:00','active'),(2,'done','content_saved','2026-11-05T16:00:00.000000+00:00','active'),(3,'done','archived','2026-11-10T16:00:00.000000+00:00','archived'),(4,'done','restored','2026-11-12T16:00:00.000000+00:00','active'),(5,'new','created','2026-11-01T16:00:00.000000+00:00','active'),(6,'legacy','observed','2026-11-01T00:00:00.000000+00:00','archived')])

class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.data=Path(self.tmp.name);self.account='a'*32
        self.source=self.data/'source.sqlite3';history(self.source)
        self.dest=self.data/'planning-statistics'/(self.account+'.sqlite3');self.dest.parent.mkdir()
        migration.project_projection(self.source,self.dest,STAMP)
    def tearDown(self):self.tmp.cleanup()
    def test_trusted_metrics_overlap_deleted_unknown_and_frozen_clock(self):
        data=snapshot_dashboard(self.data,self.account,'period=all')
        self.assertEqual(data['metrics'],{'completedProjectCount':1,'inProgressProjectCount':1,'averageFirstCompletionDays':9.0})
        self.assertEqual(data['completedProjects'][0]['projectId'],'done')
        self.assertEqual(data['inProgressProjects'][0]['daysInProgress'],17)
        self.assertEqual(sum(p['completedProjectCount'] for p in data['trend']),1)
        self.assertEqual(data['coverage']['unknownFirstArchiveCount'],1)
        self.assertEqual(data['coverage']['unknownCreationCount'],1)
        self.assertEqual(data['asOf'],STAMP)
        self.assertIsNone(data['completedProjects'][0]['projectUrl'])
        with sqlite3.connect(self.dest) as db:
            value=db.execute('SELECT value FROM app_state').fetchone()[0]
            self.assertNotIn('合成正文',value)
        self.assertEqual(data,snapshot_dashboard(self.data,self.account,'period=all'))
    def test_ranges_future_empty_and_personal_scope(self):
        data=snapshot_dashboard(self.data,self.account,'period=custom&start=2026-11-11&end=2026-11-11')
        self.assertEqual(data['metrics']['completedProjectCount'],1)
        self.assertEqual(data['metrics']['inProgressProjectCount'],0)
        future=snapshot_dashboard(self.data,self.account,'period=month&anchor=2027-01-01')
        self.assertEqual(future['metrics']['completedProjectCount'],0)
        self.assertIsNone(future['metrics']['averageFirstCompletionDays'])
        for query in ['period=all&ownerId=x','period=custom&start=2026-11-20&end=2026-11-01','period=all&period=month','range=all','period=month&grain=month']:
            with self.subTest(query=query),self.assertRaises(LedgerError):snapshot_dashboard(self.data,self.account,query)
        with self.assertRaises(LedgerError):snapshot_dashboard(self.data,'b'*32,'period=all')
    def test_out_of_sync_source_is_rejected(self):
        with sqlite3.connect(self.source) as db:db.execute("UPDATE planning_project_facts SET content_hash='tampered' WHERE project_id='done'")
        with self.assertRaises(ValueError):migration.project_projection(self.source,self.data/'bad.sqlite3',STAMP)

class MigrationTests(unittest.TestCase):
    def test_account_mapping_unmapped_archive_no_credentials_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source';target=root/'target';source.mkdir();target.mkdir()
            a,b,c='a'*32,'b'*32,'c'*32
            for folder,people in [(source,[(a,'planner',1,'user'),(b,'missing',1,'user')]),(target,[(c,'planner',1,'user')])]:
                with sqlite3.connect(folder/'identity.sqlite3') as db:
                    db.executescript('CREATE TABLE account(id TEXT,login TEXT,active INTEGER,role TEXT);CREATE TABLE grant_module(account TEXT,module TEXT);')
                    db.executemany('INSERT INTO account VALUES(?,?,?,?)',people)
                    db.executemany('INSERT INTO grant_module VALUES(?,?)',[(p[0],'bg') for p in people])
            history(source/'bg'/a/'platform.sqlite3');history(source/'bg'/b/'platform.sqlite3')
            store=Exhibitions(source);store.save(record(),{'id':a,'name':'合成用户','role':'admin'});store.set_maintainers([a,b])
            before=(source/'exhibitions.sqlite3').read_bytes()
            archive=root/'archive';manifest=migration.prepare(source,target,archive)
            self.assertEqual(manifest['errors'],[])
            self.assertEqual(manifest['accountMap'],{a:c});self.assertEqual(len(manifest['unmapped']),1)
            self.assertEqual(len(manifest['statistics']),2)
            self.assertNotIn('password',json.dumps(manifest))
            migration.publish(target,archive)
            self.assertEqual(Exhibitions(target).maintainers(),[c])
            self.assertTrue((target/'planning-statistics'/(c+'.sqlite3')).exists())
            self.assertFalse((target/'planning-statistics'/(b+'.sqlite3')).exists())
            with self.assertRaises(ValueError):migration.publish(target,archive)
            self.assertEqual(before,(source/'exhibitions.sqlite3').read_bytes())

class PlanningHTTPTests(unittest.TestCase):
    setUp = backend.BackendTests.setUp
    tearDown = backend.BackendTests.tearDown
    req = backend.BackendTests.req
    def test_exhibition_live_authority_and_snapshot_isolation(self):
        prefix='/platform/v2/exhibitions'
        self.assertEqual(self.req(prefix,token=False)[0],401)
        self.assertEqual(self.req(prefix+'/records','POST',record(),origin=False)[0],403)
        self.assertEqual(self.req(prefix+'/records','POST',record())[0],201)
        self.assertEqual(self.req(prefix+'/import?filename=test.xlsx','POST',workbook(),raw=True)[0],200)
        person=self.identity.create_account(self.token,{'login':'planner','name':'合成用户','role':'user','tags':['企划'],'password':self.initial},lambda *_:None)
        token,_=self.identity.login('planner',self.initial,False)
        self.identity.change_password(token,self.initial,self.password);member,_=self.identity.login('planner',self.password,False)
        admin=self.token;self.token=member
        self.assertEqual(self.req(prefix+'/records','POST',record())[0],403)
        self.assertFalse(json.loads(self.req(prefix)[1])['canManage'])
        self.token=admin;self.assertEqual(self.req(prefix+'/maintainers','POST',{'ids':[person['id']]})[0],200)
        self.token=member;self.assertTrue(json.loads(self.req(prefix)[1])['canManage'])
        self.token=admin;self.req(prefix+'/maintainers','POST',{'ids':[]})
        self.token=member;self.assertEqual(self.req(prefix+'/records','POST',record())[0],403)
        self.assertEqual(self.req('/platform/v2/planning-dashboard?period=all')[0],503)
        data=self.server.settings.data
        source=data/'fixture.sqlite3';history(source)
        dest=data/'planning-statistics'/(person['id']+'.sqlite3');dest.parent.mkdir()
        migration.project_projection(source,dest,STAMP)
        self.assertEqual(self.req('/platform/v2/planning-dashboard?period=all')[0],200)
        self.assertEqual(self.req('/platform/v2/planning-dashboard?period=all&accountId=x')[0],403)
        self.token=admin;self.assertEqual(self.req('/platform/v2/planning-dashboard?period=all')[0],503)
        self.identity.update_account(admin,person['id'],{'active':False},lambda *_:None)
        self.token=member;self.assertEqual(self.req(prefix)[0],401)

if __name__=='__main__':unittest.main()
