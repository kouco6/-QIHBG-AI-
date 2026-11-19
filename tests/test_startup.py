"""Launch the real V2 entrypoint with fresh data; never use existing accounts."""
import http.client,json,re,secrets,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class StartupTests(unittest.TestCase):
    def test_real_entry_initial_login_and_forced_password_change(self):
        with tempfile.TemporaryDirectory(prefix='v2-entry-') as temporary:
            child=subprocess.Popen([sys.executable,'-B',str(ROOT/'scripts/run.py'),'--port','0','--data-dir',temporary],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                first=child.stdout.readline();second=child.stdout.readline()
                password=re.search(r'临时密码：([^；]+)',first)
                url=re.search(r'http://127.0.0.1:(\d+)/',second)
                self.assertTrue(password is not None,'Initial credential was not generated')
                self.assertTrue(url is not None,'Independent entry failed to start')
                port=int(url[1]);origin=f'http://127.0.0.1:{port}'
                def req(path,body=None,cookie=None):
                    c=http.client.HTTPConnection('127.0.0.1',port,timeout=10)
                    headers={'Origin':origin,'Content-Type':'application/json'}
                    if cookie:headers['Cookie']=cookie
                    c.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,headers)
                    r=c.getresponse();data=r.read();status=r.status;cookie=r.getheader('Set-Cookie');c.close();return status,data,cookie
                self.assertEqual(req('/')[0],200)
                status,_,cookie=req('/platform/login',{'login':'bg','password':password[1]});self.assertEqual(status,200)
                self.assertTrue(json.loads(req('/platform/session',cookie=cookie)[1])['must_change_password'])
                final=secrets.token_urlsafe(20)
                self.assertEqual(req('/platform/password',{'old_password':password[1],'password':final},cookie)[0],200)
                status,_,cookie=req('/platform/login',{'login':'bg','password':final});self.assertEqual(status,200)
                self.assertFalse(json.loads(req('/platform/session',cookie=cookie)[1])['must_change_password'])
                self.assertEqual(req('/experience/')[0],404)
            finally:
                child.terminate()
                try:child.wait(timeout=10)
                except subprocess.TimeoutExpired:child.kill();child.wait()
                child.stdout.close();child.stderr.close()
if __name__=='__main__':unittest.main()
