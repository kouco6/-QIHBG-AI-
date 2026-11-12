#!/usr/bin/env python3
"""WorkBuddy Round-1 test harness (stdlib only; not a production adapter).

Implements official localassistant API request shapes and controlled local file validation.
Does not implement OAuth, direct Skill selection, or native WorkBuddy session completion.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

API_BASE = 'https://www.workbuddy.cn/openapi/v2'
DIMENSIONS = [
    '产品线齐全','行业应用场景','证书资质全','技术先进',
    '功能强','性能稳','AI 智慧力','成本优势',
    '控标能力强','应标能力强','外观高档大气','体验感好',
]
REQUIRED_HEADERS = [
    '## 研究目标', '## 研究边界', '## GPT研究任务', '## GPT成果章节结构',
    '## 任务与章节映射', '## 前置依赖', '## 证据与检索要求',
]
META_KEYS = ('project_id','dimension_id','research_cycle_id','run_id','document_type')


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(path)


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def slug(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', value):
        raise ValueError('ID只允许1-100位英文字母、数字、下划线、点或连字符')
    if value in ('.', '..'):
        raise ValueError('无效ID')
    return value


def instruction(run):
    output = (Path(run['output_dir']) / '正式研究任务包.md').as_posix()
    dimension = DIMENSIONS[int(run['dimension_id'].split('-')[1]) - 1]
    return f'''# 企划设计BG｜WorkBuddy第一轮研究任务规划

本轮只进行**研究问题拆解与规划核验**，不要开展深度研究或写企划结论。

## 项目和运行绑定（不可修改）
- 产品名称：{run['product_name']}
- 产品类型：{run['product_type']}
- project_id：{run['project_id']}
- dimension_id：{run['dimension_id']}（{dimension}）
- research_cycle_id：{run['research_cycle_id']}
- run_id：{run['run_id']}
- 正式候选输出路径：`{output}`

## 要求显式调用两个已安装 Skill
1. 专业Skill：`bg-product-line-planning`（样例，仅适用于“产品线齐全”；其它维度需替换成其正式专业Skill）。
2. 公共Skill：`bg-research-plan-validator`（研究规划核验Skill）。
必须先按当前维度专业Skill拆分任务，再用公共Skill检查研究目标、边界、深度、证据、任务-章节映射与前置依赖；在WorkBuddy执行记录中保留两个Skill被实际加载/调用的证据。**只写出技能名字不代表真的调用成功。**

## 输出约定（必须满足）
仅交付候选研究任务包，不要启动GPT，也不要在本阶段生成最终正文。
必须在上述指定路径写入 UTF-8 Markdown 文件，最少包含如下 frontmatter：
```yaml
---
project_id: {run['project_id']}
dimension_id: {run['dimension_id']}
research_cycle_id: {run['research_cycle_id']}
run_id: {run['run_id']}
document_type: research_task_package
---
```
并按顺序编写如下 Markdown 主章节：
- `## 研究目标`
- `## 研究边界`
- `## GPT研究任务`（按 Task-01、Task-02 编号；每个问题包含要求的深度）
- `## GPT成果章节结构`（按章列名称、预期内容、最低证据）
- `## 任务与章节映射`（逐个 Task 对应成果章节）
- `## 前置依赖`（写明可并行任务及需前置任务；没有依赖也需明确）
- `## 证据与检索要求`（优先级、来源类型、日期、URL、未获取时写法）

## 硬性业务约束
- 研究任务按当前产品特点动态调整，但只针对维度“{dimension}”，禁止自动扩展到其它11个企划维度。
- 研究任务应能由用户分批交给不同GPT对话独立执行；有依赖任务写清启动条件，平台不负责控制GPT内部执行。
- 研究规划核验失败时继续内部修正候选，不得把草稿作为正式任务包。
- 研究包仅供GPT后续研究；不得填写未经验证的数据或凭空生成项目样本。
- WorkBuddy必须写入上述工作目录；不能仅在聊天中返回文本。若无文件读写权限，明确报错，不要声称成功。
'''


def prepare(root, project_id, dimension_id, cycle_id, product_name, product_type):
    slug(project_id)
    slug(cycle_id)
    if dimension_id not in [f'DIM-{i:02d}' for i in range(1, 13)]:
        raise ValueError('dimension_id必须是DIM-01...DIM-12')
    if dimension_id != 'DIM-01':
        raise ValueError('此POC只有DIM-01的专业Skill样例。其它维度必须先配置其对应的专业Skill，不能错用DIM-01')
    if product_type not in ('单品', '系统'):
        raise ValueError('product_type只能是单品或系统')
    if not product_name.strip():
        raise ValueError('产品名称不能为空')
    run_id = 'r1-' + uuid4().hex[:16]
    # isolated output per run; do not reuse a project-wide flat filename
    run_dir = Path(root).expanduser().resolve() / project_id / dimension_id / cycle_id / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    result = dict(project_id=project_id,dimension_id=dimension_id,research_cycle_id=cycle_id,
                  run_id=run_id,product_name=product_name.strip(),product_type=product_type,
                  output_dir=str(run_dir),created_at=utcnow(),state='PREPARED',
                  skill_pair=['bg-product-line-planning','bg-research-plan-validator'],
                  skill_load_evidence='UNVERIFIED',dispatch_mode='not_dispatched')
    save_json(run_dir / 'run.json', result)
    (run_dir / 'WorkBuddy执行指令.md').write_text(instruction(result), encoding='utf-8')
    return run_dir


def parse_yaml_minimal(md):
    # only accepts plain scalar keys in an initial frontmatter; not a generic YAML parser
    match = re.match(r'\A---\s*\n(.*?)\n---\s*(?:\n|\Z)', md, flags=re.S)
    if not match:
        return None
    data={}
    for row in match.group(1).splitlines():
        m=re.match(r'^([a-z_][a-z0-9_]*):\s*(.*?)\s*$',row)
        if m:
            data[m.group(1)]=m.group(2).strip('"\'')
    return data


def section(md, heading):
    match = re.search(r'(?m)^' + re.escape(heading) + r'\s*$', md)
    if not match:
        return ''
    tail = md[match.end():]
    next_heading = re.search(r'(?m)^##\s+', tail)
    return tail[:next_heading.start()] if next_heading else tail


def validate(run_dir, promote=False):
    run_dir=Path(run_dir).resolve()
    run=load_json(run_dir / 'run.json')
    dest=run_dir / '正式研究任务包.md'
    errors=[]
    if not dest.exists() or not dest.is_file():
        errors.append('未发现正式研究任务包.md（WorkBuddy未产出可读文件）')
        text=''
    else:
        try:
            text=dest.read_text(encoding='utf-8-sig')
        except (UnicodeError,OSError) as exc:
            text='';errors.append('文件不可读/UTF-8无效：'+str(exc))
    if text:
        if len(text.strip())<350:
            errors.append('内容过短，不能证明任务包达到最低结构深度')
        meta=parse_yaml_minimal(text)
        if not meta:
            errors.append('缺少文件开头的YAML frontmatter')
        else:
            for k in META_KEYS:
                expected=('research_task_package' if k=='document_type' else run.get(k))
                if meta.get(k)!=expected:
                    errors.append(f'{k}不一致（预期：{expected}）')
        missing=[x for x in REQUIRED_HEADERS if not re.search(r'(?m)^'+re.escape(x)+r'\s*$',text)]
        if missing:
            errors.append('缺少必填章节：'+', '.join(missing))
        tasks = set(re.findall(r'\bTask[-‐‑–—]?0*(\d+)\b', section(text, '## GPT研究任务'), re.I))
        if len(tasks) < 2:
            errors.append('GPT研究任务至少需要两个独立编号（Task-01、Task-02）')
        mapping = section(text, '## 任务与章节映射')
        if tasks and any(not re.search(r'\bTask[-‐‑–—]?0*' + re.escape(task) + r'\b', mapping, re.I) for task in tasks):
            errors.append('任务与章节映射未覆盖全部 GPT 研究任务')
        if len(section(text, '## GPT成果章节结构').strip()) < 40:
            errors.append('GPT成果章节结构内容不足')
        if len(section(text, '## 前置依赖').strip()) < 20:
            errors.append('前置依赖说明内容不足')
    report={'run_id':run['run_id'],'checked_at':utcnow(),'valid_structure':not errors,
            'errors':errors,'skill_load_evidence':run.get('skill_load_evidence','UNVERIFIED'),
            'file_sha256':hashlib.sha256(text.encode('utf-8')).hexdigest() if text else None,
            'file_path':str(dest)}
    save_json(run_dir / 'validation.json',report)
    if promote:
        # Content-only validation cannot prove both skills were actually loaded.
        if errors:
            raise ValueError('校验未通过，不能发布正式任务包：'+'; '.join(errors))
        if run.get('skill_load_evidence') != 'VERIFIED_BY_OPERATOR':
            raise ValueError('双Skill真实加载未核实；请按WorkBuddy执行日志人工验证后再考虑正式发布')
        run['state']='OFFICIAL_READY'
        run['official_sha256']=report['file_sha256']
        run['official_at']=utcnow()
        save_json(run_dir / 'run.json',run)
        report['official_ready']=True
        save_json(run_dir / 'validation.json',report)
    return report


def _call_api(method, endpoint, token, payload=None, timeout=15):
    if not token:
        raise RuntimeError('没有WORKBUDDY_ACCESS_TOKEN：需要先在官方开放平台获批应用和OAuth授权')
    url=API_BASE+endpoint
    raw=json.dumps(payload,ensure_ascii=False).encode('utf-8') if payload is not None else None
    headers={'Authorization':'Bearer '+token,'Accept':'application/json'}
    if raw is not None:
        headers['Content-Type']='application/json'
    req=urllib.request.Request(url,data=raw,method=method,headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=timeout) as response:
            parsed=json.loads(response.read(2_000_000).decode('utf-8'))
    except urllib.error.HTTPError as err:
        raise RuntimeError(f'WorkBuddy HTTP {err.code}（检查Open API授权/Scope/PC在线）') from err
    except (urllib.error.URLError, TimeoutError) as err:
        raise RuntimeError('WorkBuddy请求超时/网络异常：若发送超时，实际投递状态未知，切勿直接重复发送') from err
    if not isinstance(parsed,dict) or parsed.get('code')!=0:
        raise RuntimeError(f'WorkBuddy接口返回错误：{str(parsed.get("msg", "invalid response"))[:150]}')
    return parsed.get('data') or {}


def dispatch(run_dir, confirm, token=None):
    if not confirm:
        raise RuntimeError('必须显式传入 --yes-send；默认仅生成本地交接资料')
    run_dir=Path(run_dir).resolve()
    run=load_json(run_dir/'run.json')
    if run['state'] not in ('PREPARED','FAILED_BEFORE_SEND'):
        raise RuntimeError('当前run不允许再次发送（避免重复生成远程任务）')
    token = token or os.environ.get('WORKBUDDY_ACCESS_TOKEN')
    online=_call_api('GET','/localassistant',token)
    if online.get('online') is not True:
        raise RuntimeError('官方接口返回本地WorkBuddy助理不在线，未发送任务')
    # Crash/timeout after send may create an unknown remote job: mark locally before sending.
    run['state']='SEND_UNCERTAIN';run['dispatch_mode']='official_localassistant_api'
    run['send_attempt_at']=utcnow();save_json(run_dir/'run.json',run)
    body=(run_dir/'WorkBuddy执行指令.md').read_text(encoding='utf-8')
    result=_call_api('POST','/localassistant/message',token,{'content':body,'msg_type':'text'})
    msgid=result.get('message_id')
    if not msgid:
        raise RuntimeError('WorkBuddy没有返回message_id；状态未知，不可自动重复提交')
    run['state']='SENT';run['workbuddy_message_id']=msgid;run['dispatched_at']=utcnow()
    save_json(run_dir/'run.json',run)
    return {'run_id':run['run_id'],'state':'SENT','workbuddy_message_id':msgid,
            'note':'已收到投递回执；Skill调用/MD实际落盘仍未验证'}


def fetch_reply(run_dir, token=None):
    run_dir=Path(run_dir).resolve();run=load_json(run_dir/'run.json')
    mid=run.get('workbuddy_message_id')
    if not mid:raise RuntimeError('没有官方本地助理message_id；不能查询增量回执')
    token=token or os.environ.get('WORKBUDDY_ACCESS_TOKEN')
    q=urllib.parse.urlencode({'message_id':mid})
    result=_call_api('GET','/localassistant/message?'+q,token)
    messages=result.get('messages') or []
    assistant=[x for x in messages if x.get('role')=='assistant']
    # Do not treat assistant messages as proof the actual MD was written.
    summary={'fetched_at':utcnow(),'message_id':mid,'returned_messages':len(messages),
             'assistant_messages':len(assistant),'note':'仅为消息观测，不能证明双Skill调用或MD落盘'}
    save_json(run_dir/'message_observation.json',summary)
    return summary


def mark_skills_verified(run_dir):
    run_dir=Path(run_dir).resolve();run=load_json(run_dir/'run.json')
    # Explicit human check is intentionally required, not derived from prompt text.
    run['skill_load_evidence']='VERIFIED_BY_OPERATOR';run['skill_verified_at']=utcnow()
    save_json(run_dir/'run.json',run)
    return run


def main():
    parser=argparse.ArgumentParser(description='WorkBuddy第一轮可复用本地技术POC：默认不发网请求')
    cmd=parser.add_subparsers(dest='action',required=True)
    p=cmd.add_parser('prepare');p.add_argument('--root',required=True)
    p.add_argument('--project-id',required=True);p.add_argument('--dimension-id',required=True)
    p.add_argument('--cycle-id',required=True);p.add_argument('--product-name',required=True);p.add_argument('--product-type',required=True)
    for action in ('check','send','poll','mark-skill-evidence','promote'):
        x=cmd.add_parser(action);x.add_argument('--run-dir',required=True)
        if action=='send':x.add_argument('--yes-send',action='store_true')
    a=parser.parse_args()
    try:
        if a.action=='prepare':output={'run_dir':str(prepare(a.root,a.project_id,a.dimension_id,a.cycle_id,a.product_name,a.product_type))}
        elif a.action=='check':output=validate(a.run_dir)
        elif a.action=='send':output=dispatch(a.run_dir,a.yes_send)
        elif a.action=='poll':output=fetch_reply(a.run_dir)
        elif a.action=='mark-skill-evidence':output={'skill_evidence':mark_skills_verified(a.run_dir)['skill_load_evidence']}
        else:output=validate(a.run_dir,promote=True)
        print(json.dumps(output,ensure_ascii=False,indent=2))
    except Exception as exc:
        print(json.dumps({'error':str(exc),'success':False},ensure_ascii=False),file=sys.stderr)
        return 2
    return 0

if __name__=='__main__':sys.exit(main())
