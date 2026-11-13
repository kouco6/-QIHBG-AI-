"""Narrow W import into the existing state/ledger transaction; never applies P."""
import copy
import hashlib
import json

from planning_ledger import LedgerError, digest, encoded


def working_hash(state, project_id, dimension_id):
    return digest(state.get('showcases', {}).get(project_id, {}).get(dimension_id))


def migrate(db):
    db.execute('''CREATE TABLE IF NOT EXISTS research_w_imports (
        task_id TEXT NOT NULL, result_version INTEGER NOT NULL,
        project_id TEXT NOT NULL, dimension_id TEXT NOT NULL,
        source_hash TEXT NOT NULL, previous_store TEXT NOT NULL,
        imported_hash TEXT NOT NULL, committed_revision INTEGER NOT NULL,
        imported_at TEXT NOT NULL, PRIMARY KEY(task_id,result_version))''')
    for operation in ('UPDATE', 'DELETE'):
        db.execute(f'''CREATE TRIGGER IF NOT EXISTS research_w_imports_no_{operation.lower()}
            BEFORE {operation} ON research_w_imports
            BEGIN SELECT RAISE(ABORT,'research W backups are immutable'); END''')


def import_working(db, ledger, payload, validator):
    """Only the platform's private, verified-result route may call this primitive.

    Revision and full store digest protect edits in other tabs. The frontend
    separately flushes its local buffer before requesting a preview/confirmation.
    Original stores and receipts commit atomically with W and the project ledger.
    """
    db.execute('BEGIN IMMEDIATE')
    try:
        migrate(db)
        revision, raw = db.execute('SELECT revision,value FROM app_state WHERE id=1').fetchone()
        state = json.loads(raw)
        pid, did, task, version = (payload[k] for k in ('projectId', 'dimensionId', 'taskId', 'resultVersion'))
        project = next((p for p in state['projects'] if p['id'] == pid), None)
        if not project:
            raise LedgerError('PROJECT_NOT_FOUND', '当前账号下未找到该项目。', 404)
        if project['status'] != 'active':
            raise LedgerError('PROJECT_NOT_ACTIVE', '归档项目不可更新工作区。')
        result = payload['result']
        if (result.get('status') != 'succeeded' or result.get('resultAvailable') is not True
                or result.get('nativeInvocationVerified') is not True or result.get('readonly') is not True
                or any(result.get(k) != payload[k] for k in ('projectId', 'dimensionId', 'taskId', 'resultVersion'))):
            raise LedgerError('RESEARCH_RESULT_NOT_VERIFIED', '需要同任务同版本、原生执行验证通过的完整原件。')
        if not any(c.get('id') == result.get('cycleId') for c in state['cycles'].get(pid + '|' + did, [])):
            raise LedgerError('CYCLE_NOT_FOUND', '成果周期不属于当前项目维度。', 404)
        md, json_text = result.get('markdown'), result.get('jsonText')
        if not isinstance(md, str) or not md.strip() or not isinstance(json_text, str):
            raise LedgerError('RESEARCH_PAIR_INCOMPLETE', '必须完整收到同版MD及JSON。', 422)
        snapshot = json.loads(json_text)
        integrity = result['integrity']
        for role, text in [('markdown', md), ('json', json_text)]:
            data = text.encode('utf-8')
            if hashlib.sha256(data).hexdigest() != integrity[role]['sha256'] or len(data) != integrity[role]['bytes']:
                raise LedgerError('RESEARCH_RESULT_INTEGRITY_FAILED', '成果原件摘要或长度不符。')
        source_hash = digest([pid, did, task, version, integrity])
        previous = db.execute('SELECT project_id,dimension_id,source_hash,committed_revision FROM research_w_imports '
                              'WHERE task_id=? AND result_version=?', (task, version)).fetchone()
        if previous:
            if previous[:3] != (pid, did, source_hash):
                raise LedgerError('RESEARCH_IMPORT_CONFLICT', '已同步版本与本次来源不一致。')
            db.commit()
            return {'applied': True, 'duplicate': True, 'revision': revision, 'state': state,
                    'taskId': task, 'resultVersion': version, 'dimensionId': did, 'workingOnly': True}
        if type(payload['expectedRevision']) is not int or payload['expectedRevision'] != revision:
            raise LedgerError('STATE_REVISION_CONFLICT', '预览后工作区已有变化，请重新预览并确认。')
        if working_hash(state, pid, did) != payload['expectedWorkHash']:
            raise LedgerError('WORKING_CONTENT_CONFLICT', '当前W与确认时不符，未写入。')
        old = state.get('showcases', {}).get(pid, {}).get(did)
        if old and old.get('autoDirty') and payload.get('overwriteWorking') is not True:
            raise LedgerError('WORKING_EDITS_REQUIRE_CONFIRMATION', '当前W有编辑内容，须明确确认备份并覆盖。')
        next_state = copy.deepcopy(state)
        stores = next_state.setdefault('showcases', {}).setdefault(pid, {})
        stamp = ledger.now()
        # For a never-opened dimension, current is an unapplied baseline only.
        # A draft-kind version is W provenance, not a D save or P application.
        item = copy.deepcopy(old) if old else {
            'current': copy.deepcopy(snapshot), 'applied': False,
            'versions': [{'id': 'research-baseline-' + task, 'kind': 'baseline',
                          'label': '未应用初始内容', 'createdAt': stamp, 'snapshot': copy.deepcopy(snapshot)}]}
        if old:
            item['versions'].append({'id': 'research-backup-' + task, 'kind': 'working-backup',
                                     'label': '研究同步前W备份', 'createdAt': stamp,
                                     'snapshot': copy.deepcopy(old.get('draft') or old['current'])})
        item['draft'] = copy.deepcopy(snapshot)
        item['autoDirty'] = True
        item['researchSource'] = {'taskId': task, 'resultVersion': version, 'integrity': integrity}
        stores[did] = item
        saved = ledger.save(db, revision, next_state, validator, 'research-import:' + digest([task, version]), commit=False)
        db.execute('INSERT INTO research_w_imports VALUES (?,?,?,?,?,?,?,?,?)',
                   (task, version, pid, did, source_hash, encoded(old), digest(snapshot), saved['revision'], stamp))
        stored_revision, stored_raw = db.execute('SELECT revision,value FROM app_state WHERE id=1').fetchone()
        checked = json.loads(stored_raw)
        if stored_revision != saved['revision'] or checked['showcases'][pid][did]['draft'] != snapshot:
            raise LedgerError('RESEARCH_IMPORT_VERIFY_FAILED', '写入核对失败，已回滚。', 503)
        db.commit()
        return {**saved, 'applied': True, 'state': checked, 'taskId': task,
                'resultVersion': version, 'dimensionId': did, 'workingOnly': True}
    except Exception:
        db.rollback()
        raise
