"""Temporary synthetic fixture for the independent V2 project."""
import sys,tempfile,secrets,json,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from identity import Identity
from runtime import Settings,Modules
from http_server import Server

def main():
    with tempfile.TemporaryDirectory(prefix='v2-independent-') as tmp:
        settings=Settings(0,Path(tmp)/'data')
        accounts=Identity(settings.data/'identity.sqlite3')
        initial,password,salt=secrets.token_urlsafe(24),secrets.token_urlsafe(24),secrets.token_hex(16)
        accounts.bootstrap('ai-admin','隔离管理员',salt,accounts.password_hash(initial,salt),'v2-fixture')
        session,_=accounts.login('ai-admin',initial,False)
        accounts.change_password(session,initial,password)
        session,_=accounts.login('ai-admin',password,False)
        fixture={'admin':{'login':'ai-admin','password':password}}
        for name in ['planner']:
            temporary,final=secrets.token_urlsafe(24),secrets.token_urlsafe(24)
            person=accounts.create_account(session,{'login':'ai-'+name,'name':'隔离用户','role':'user','tags':['企划'],'password':temporary},settings.provision_account)
            token,_=accounts.login(person['login'],temporary,False)
            accounts.change_password(token,temporary,final)
            fixture[name]={'login':person['login'],'password':final,'id':person['id']}
        modules=Modules(settings)
        try:
            with Server(settings,accounts,modules) as server:
                fixture['url']=f'http://127.0.0.1:{server.server_port}'
                fixture['data']=str(settings.data)
                file=Path(tmp)/'fixture.json';file.write_text(json.dumps(fixture));file.chmod(0o600)
                print(file,flush=True)
                try:server.serve_forever()
                except KeyboardInterrupt:pass
        finally:modules.close()
if __name__=='__main__':main()
