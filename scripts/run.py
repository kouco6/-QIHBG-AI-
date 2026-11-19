"""Start the independent V2 server without original portal or experience services."""
import argparse, os, secrets, signal, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT / 'backend'))
from identity import Identity
from http_server import Server
from runtime import Settings, Modules, workspace_lock

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8780)
    parser.add_argument('--data-dir',type=Path)
    parser.add_argument('--node')
    args=parser.parse_args()
    if sys.version_info<(3,12): raise ValueError('需要 Python 3.12+')
    if not (ROOT/'web/dist/index.html').is_file(): raise ValueError('请先执行 python3.12 scripts/build.py')
    settings=Settings(args.port,args.data_dir,args.node)
    with workspace_lock(settings.data):
        identity=Identity(settings.data/'identity.sqlite3')
        with identity.db() as db: empty = not db.execute('SELECT 1 FROM account LIMIT 1').fetchone()
        if empty:
            password=secrets.token_urlsafe(18);salt=secrets.token_hex(16)
            identity.bootstrap('bg','BG',salt,identity.password_hash(password,salt),'v2-bg')
            print('新实例首次登录账号：bg；临时密码：'+password+'；首次登录须修改。',flush=True)
        modules=Modules(settings)
        try:
            with Server(settings,identity,modules) as server:
                print(f'V2.0 http://127.0.0.1:{server.server_port}/  数据目录：{settings.data}',flush=True)
                def stop(*_): raise KeyboardInterrupt
                for name in ['SIGINT','SIGTERM','SIGHUP']:
                    if hasattr(signal,name):signal.signal(getattr(signal,name),stop)
                try:server.serve_forever()
                except KeyboardInterrupt:pass
        finally:modules.close()

if __name__=='__main__':main()
