"""Populate ONLY the temporary browser fixture with synthetic business records."""
import json,sys,sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from test_planning_migration import history,migration
from exhibitions import Exhibitions
fixture=json.loads(Path(sys.argv[1]).read_text());data=Path(fixture['data'])
if not data.parent.name.startswith('v2-independent-'):raise ValueError('仅允许临时验收目录')
with sqlite3.connect(data/'identity.sqlite3') as db:account=db.execute('SELECT id FROM account WHERE login=?',(fixture['admin']['login'],)).fetchone()[0]
store=Exhibitions(data);admin={'id':account,'name':'合成管理员','role':'admin'}
topic=store.topic({'action':'create','name':'合成机器人专题'},admin)['id']
month=datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m')
base={'name':'合成机器人与设计展','venue':'合成展馆','group':'推荐','startDate':month+'-15','endDate':month+'-25','city':'上海','industry':'机器人','reason':'用于交互验收的合成调研方向','content':'合成展示内容，不代表真实展会。','topicIds':[topic]}
store.save(base,admin)
store.save(base|{'name':'合成日期待定展','schedule':'tbd','startDate':'','endDate':''},admin)
archived=store.save(base|{'name':'合成已归档展'},admin)['id'];store.archive(archived,1,True,admin)
source=data/'synthetic-history.sqlite3';history(source)
as_of=datetime.now(ZoneInfo('UTC')).isoformat(timespec='microseconds')
dest=data/'planning-statistics'/(account+'.sqlite3');dest.parent.mkdir()
migration.project_projection(source,dest,as_of)
fixture['xlsx']=str(data/'synthetic.xlsx')
from test_exhibitions import workbook
Path(fixture['xlsx']).write_bytes(workbook());Path(sys.argv[1]).write_text(json.dumps(fixture))
print('Synthetic planning browser fixture ready')
