import sys,json,secrets,tempfile,threading,unittest,http.client,io,zipfile
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from identity import Identity
from http_server import Server
from planning_templates import archive

class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='v2-backend-')
        data=Path(self.tmp.name)
        self.identity=Identity(data/'identity.sqlite3')
        self.initial,self.password=secrets.token_urlsafe(20),secrets.token_urlsafe(20)
        salt=secrets.token_hex(16)
        self.identity.bootstrap('test-admin','测试管理员',salt,self.identity.password_hash(self.initial,salt),'v2-admin')
        token,_=self.identity.login('test-admin',self.initial,False)
        self.identity.change_password(token,self.initial,self.password)
        self.token,_=self.identity.login('test-admin',self.password,False)
        settings=SimpleNamespace(port=0,data=data,provision_account=lambda login,name,previous:previous or 'v2-'+login)
        self.server=Server(settings,self.identity,None)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def req(self,path,method='GET',data=None,token=True,origin=True,raw=False):
        h={}
        if token:h['Cookie']='bg_platform_session='+self.token
        if origin:h['Origin']=f'http://127.0.0.1:{self.server.server_port}'
        if data is not None:
            h['Content-Type']='application/octet-stream' if raw else 'application/json'
            data=data if raw else json.dumps(data)
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=20)
        c.request(method,path,body=data,headers=h);r=c.getresponse();b=r.read();headers=dict(r.getheaders());status=r.status;c.close()
        return status,b,headers
    def test_personnel_crud_and_live_session_authority(self):
        status,body,_=self.req('/platform/accounts','POST',{'login':'member','name':'测试人员','role':'user','tags':['企划'],'password':self.initial})
        self.assertEqual(status,201);person=json.loads(body)
        self.assertEqual(self.req('/platform/accounts/'+person['id'],'PATCH',{'name':'更新姓名'})[0],200)
        self.assertEqual(self.req('/platform/accounts/'+person['id'],'PATCH',{'active':False})[0],200)
        self.assertEqual(self.req('/platform/accounts/'+person['id'],'DELETE')[0],405)
        self.assertEqual(self.req('/platform/accounts','POST',{},origin=False)[0],403)
        self.assertNotIn('experience',json.loads(self.req('/platform/session')[1]))
    def test_twelve_dimension_baseline_and_sandbox(self):
        status,body,_=self.req('/platform/v2/planning-templates');self.assertEqual(status,200,body)
        cat=json.loads(body);version=next(v for v in cat['items'] if v['id']==cat['active'])
        self.assertEqual(len(version['dimensions']),12)
        for value in version['dimensions'].values():
            url='/platform/v2/planning-templates/preview/'+cat['previewTicket']+'/'+cat['active']+'/'+value['entry']
            code,html,headers=self.req(url,token=False)
            self.assertEqual(code,200);self.assertIn('sandbox allow-scripts',headers['Content-Security-Policy']);self.assertIn(b'v2-theme',html)
        self.assertEqual(len(json.loads(self.req('/platform/v2/planning-templates/samples')[1])),12)
    def test_template_import_apply_and_rollback(self):
        _,body,_=self.req('/platform/v2/planning-templates');cat=json.loads(body)
        files={p.relative_to(ROOT/'baseline').as_posix():p.read_bytes() for p in (ROOT/'baseline').rglob('*') if p.is_file()}
        m=json.loads(files['manifest.json']);m['version']='2.0.0-test';files['manifest.json']=json.dumps(m).encode()
        status,b,_=self.req('/platform/v2/planning-templates/import','POST',archive(files),raw=True);self.assertEqual(status,201,b)
        new=json.loads(b)
        status,b,_=self.req('/platform/v2/planning-templates/apply','POST',{'id':new['id'],'revision':cat['revision']});self.assertEqual(status,200,b)
        current=json.loads(b)
        self.assertEqual(self.req('/platform/v2/planning-templates/apply','POST',{'id':cat['active'],'revision':current['revision']})[0],200)
    def test_removed_interfaces_and_asset_authorization(self):
        for path in ['/work/bg','/bg/','/experience/','/portal/index.html','/platform/planning-templates']:
            self.assertEqual(self.req(path)[0],404,path)
        self.assertEqual(self.req('/ai/scaffold.html',token=False)[0],401)
        self.assertEqual(self.req('/ai/login')[0],404)
        self.assertEqual(self.req('/v2/../backend/identity.py')[0],400)
if __name__=='__main__':unittest.main()
