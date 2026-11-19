"""Install locked frontend dependencies if missing and build only the V2 application."""
from pathlib import Path
import os,shutil,subprocess
root=Path(__file__).resolve().parents[1]
web=root/'web'
npm=shutil.which('npm')
if not npm:raise SystemExit('需要 Node.js 22.18+ 与 npm')
if not (web/'node_modules/vite/bin/vite.js').is_file():
    subprocess.run([npm,'ci','--ignore-scripts','--no-audit','--no-fund'],cwd=web,check=True,shell=os.name=='nt')
subprocess.run([npm,'run','build'],cwd=web,check=True,shell=os.name=='nt')
