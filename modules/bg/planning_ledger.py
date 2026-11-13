"""Trusted project facts and events in the existing BG SQLite database.

app_state remains the sole project/content store. These tables contain only
audit facts, content digests and write receipts, never a second project body.
"""
import copy
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


class LedgerError(Exception):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code, self.status = code, status


TIME_FIELDS = {'createdAt', 'updatedAt', 'firstArchivedAt', 'latestArchivedAt',
               'lastArchivedAt', 'lastContentSavedAt', 'lastProgressAt'}


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode('utf-8')).hexdigest()


def content_of(state, project_id):
    """Business content only: not versions, timestamps, UI flags or AI runs.

    A working snapshot takes precedence over its published copy. Publishing the
    same content, saving version metadata, or opening an unedited sample is not
    a second content change. Legacy MD imports count only when actually saved.
    """
    def collection(name):
        container = state.get(name)
        value = container.get(project_id) if isinstance(container, dict) else None
        return value if isinstance(value, dict) else {}
    bodies = {key: value['text'] for key, value in collection('bodies').items()
              if isinstance(value, dict) and isinstance(value.get('text'), str) and value['text'].strip()}
    structures = {}
    for dimension, item in collection('showcases').items():
        if not isinstance(item, dict):
            continue
        current, draft = item.get('current'), item.get('draft')
        if isinstance(draft, dict):
            if item.get('applied') is False and draft == current:
                continue  # Unedited initial demonstration content.
            structures[dimension] = draft
        elif isinstance(current, dict) and item.get('applied') is not False:
            structures[dimension] = current
    return {'bodies': bodies, 'structures': structures}


def request_digest(state):
    value = copy.deepcopy(state)
    for project in value.get('projects', []):
        if isinstance(project, dict):
            for key in TIME_FIELDS:
                project.pop(key, None)
    return digest(value)


def rows(db, sql, args=()):
    cursor = db.execute(sql, args)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


class ProjectLedger:
    def __init__(self, clock=None, business_timezone='Asia/Shanghai', week_start=0):
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.zone = ZoneInfo(business_timezone)
        self.timezone = business_timezone
        if type(week_start) is not int or not 0 <= week_start <= 6:
            raise ValueError('业务周起始日须为0（周一）至6（周日）。')
        self.week_start = week_start

    def now(self):
        value = self.clock()
        if value.tzinfo is None:
            raise ValueError('Business clock must be timezone-aware')
        return value.astimezone(timezone.utc).isoformat(timespec='microseconds')

    def migrate(self, db, state, revision):
        """Called inside connect's transaction. Never rewrites old app_state.

        All pre-ledger projects are conservatively legacy_unknown. In particular,
        a later re-archive cannot manufacture their historical first completion.
        """
        existing = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'planning_meta' in existing:
            previous = dict(db.execute('SELECT key,value FROM planning_meta'))
            required = {'planning_project_facts', 'planning_events', 'planning_write_receipts'}
            if previous.get('schema_version') and not required.issubset(existing):
                raise LedgerError('PLANNING_STORAGE_INCOMPLETE', '事件库表缺失，不能重建空表后假装历史完整。', 503)
        db.execute('''CREATE TABLE IF NOT EXISTS planning_meta (
            key TEXT PRIMARY KEY, value TEXT NOT NULL)''')
        db.execute('''CREATE TABLE IF NOT EXISTS planning_project_facts (
            project_id TEXT PRIMARY KEY, origin TEXT NOT NULL,
            created_at TEXT, first_archived_at TEXT, latest_archived_at TEXT,
            last_content_saved_at TEXT, last_progress_at TEXT, deleted_at TEXT,
            observed_at TEXT NOT NULL, baseline_status TEXT NOT NULL,
            last_status TEXT NOT NULL, content_hash TEXT NOT NULL)''')
        db.execute('''CREATE TABLE IF NOT EXISTS planning_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
            project_id TEXT NOT NULL, kind TEXT NOT NULL,
            occurred_at TEXT NOT NULL, status_after TEXT NOT NULL,
            state_revision INTEGER NOT NULL, request_key TEXT NOT NULL,
            content_hash TEXT, UNIQUE(request_key,project_id,kind))''')
        db.execute('CREATE INDEX IF NOT EXISTS planning_event_project_time ON planning_events(project_id,occurred_at,seq)')
        db.execute('CREATE INDEX IF NOT EXISTS planning_event_kind_time ON planning_events(kind,occurred_at)')
        db.execute('''CREATE TABLE IF NOT EXISTS planning_write_receipts (
            request_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
            expected_revision INTEGER NOT NULL, committed_revision INTEGER NOT NULL,
            committed_at TEXT NOT NULL, response TEXT NOT NULL)''')
        db.execute('''CREATE TRIGGER IF NOT EXISTS planning_first_archive_immutable
            BEFORE UPDATE OF first_archived_at ON planning_project_facts
            WHEN OLD.first_archived_at IS NOT NULL AND NEW.first_archived_at IS NOT OLD.first_archived_at
            BEGIN SELECT RAISE(ABORT,'first archive is immutable'); END''')
        db.execute('''CREATE TRIGGER IF NOT EXISTS planning_created_immutable
            BEFORE UPDATE OF created_at ON planning_project_facts
            WHEN NEW.created_at IS NOT OLD.created_at
            BEGIN SELECT RAISE(ABORT,'creation fact is immutable'); END''')
        for operation in ('UPDATE', 'DELETE'):
            db.execute(f'''CREATE TRIGGER IF NOT EXISTS planning_events_no_{operation.lower()}
                BEFORE {operation} ON planning_events
                BEGIN SELECT RAISE(ABORT,'project events are immutable'); END''')
        meta = dict(db.execute('SELECT key,value FROM planning_meta'))
        if meta.get('schema_version'):
            if meta['schema_version'] != '1':
                raise LedgerError('PLANNING_SCHEMA_UNSUPPORTED', '企划事件库版本不兼容。', 503)
            if meta['business_timezone'] != self.timezone or int(meta['week_start']) != self.week_start:
                raise LedgerError('BUSINESS_CALENDAR_CHANGED', '业务时区或周起始日与已启用的事件库不一致，需先评估变更。', 503)
            return
        stamp = self.now()
        for project in state['projects']:
            pid, status = project['id'], project['status']
            db.execute('''INSERT INTO planning_project_facts
                (project_id,origin,observed_at,baseline_status,last_status,content_hash)
                VALUES (?,'legacy_unknown',?,?,?,?)''', (pid, stamp, status, status, digest(content_of(state, pid))))
            self.event(db, pid, 'observed', stamp, status, revision, 'migration-v1')
        db.executemany('INSERT INTO planning_meta VALUES (?,?)', [
            ('schema_version', '1'), ('coverage_start', stamp), ('last_clock', stamp),
            ('business_timezone', self.timezone), ('week_start', str(self.week_start))])

    @staticmethod
    def event(db, pid, kind, stamp, status, revision, key, content_hash=None):
        event_id = str(uuid.uuid4())
        db.execute('''INSERT INTO planning_events
            (event_id,project_id,kind,occurred_at,status_after,state_revision,request_key,content_hash)
            VALUES (?,?,?,?,?,?,?,?)''', (event_id, pid, kind, stamp, status, revision, key, content_hash))
        return event_id

    @staticmethod
    def facts(db):
        return {row['project_id']: row for row in rows(db, 'SELECT * FROM planning_project_facts')}

    def check_sync(self, state, facts):
        projects = {p['id']: p for p in state['projects']}
        live = {pid for pid, fact in facts.items() if not fact['deleted_at']}
        if live != set(projects) or any(
                facts[pid]['last_status'] != project['status'] or
                facts[pid]['content_hash'] != digest(content_of(state, pid))
                for pid, project in projects.items()):
            raise LedgerError('PROJECT_LEDGER_OUT_OF_SYNC', '检测到事件记录之外的项目变化，须先核查，不能推造历史事件。')

    @staticmethod
    def project_times(fact):
        return {'createdAt': fact['created_at'], 'firstArchivedAt': fact['first_archived_at'],
                'latestArchivedAt': fact['latest_archived_at'],
                'lastContentSavedAt': fact['last_content_saved_at'], 'lastProgressAt': fact['last_progress_at'],
                'firstArchiveUnknown': fact['origin'] == 'legacy_unknown', 'deletedAt': fact['deleted_at']}

    @staticmethod
    def protect_times(project, old, fact, stamp, changed):
        # Old, untrusted display values are retained; statistics never use them.
        for key in TIME_FIELDS:
            project.pop(key, None)
            if old and key in old:
                project[key] = old[key]
        if fact['created_at']:
            project['createdAt'] = fact['created_at']
        for key, column in [('firstArchivedAt', 'first_archived_at'), ('latestArchivedAt', 'latest_archived_at'),
                            ('lastContentSavedAt', 'last_content_saved_at'), ('lastProgressAt', 'last_progress_at')]:
            if fact[column]:
                project[key] = fact[column]
        if changed:
            project['updatedAt'] = stamp

    def save(self, db, expected, incoming, validator, idempotency_key=None, *, commit=True):
        if type(expected) is not int or expected < 0 or not isinstance(incoming, dict):
            raise LedgerError('INVALID_STATE_REQUEST', '保存版本或内容无效。', 400)
        if idempotency_key is not None and not re.fullmatch(r'[A-Za-z0-9._:-]{8,128}', idempotency_key):
            raise LedgerError('INVALID_IDEMPOTENCY_KEY', '幂等标识格式无效。', 422)
        try:
            body_hash = request_digest(incoming)
        except (TypeError, ValueError, AttributeError):
            raise LedgerError('INVALID_STATE_REQUEST', '保存内容无效。', 400) from None
        key = digest(['explicit', idempotency_key]) if idempotency_key else digest(['revision', expected, body_hash])
        if not db.in_transaction:
            db.execute('BEGIN IMMEDIATE')
        try:
            revision, raw = db.execute('SELECT revision,value FROM app_state WHERE id=1').fetchone()
            receipt = rows(db, 'SELECT * FROM planning_write_receipts WHERE request_key=?', (key,))
            if receipt:
                receipt = receipt[0]
                if receipt['request_hash'] != body_hash:
                    raise LedgerError('IDEMPOTENCY_CONFLICT', '同一幂等标识不能用于不同内容。')
                if revision != receipt['committed_revision']:
                    raise LedgerError('STATE_REVISION_CONFLICT', '保存后已有新版本，请刷新后核对。')
                result = {**json.loads(receipt['response']), 'duplicate': True, 'eventsRecorded': 0}
                if commit:
                    db.commit()
                return result
            if revision != expected:
                raise LedgerError('STATE_REVISION_CONFLICT', '其他窗口已更新，请刷新后核对。')
            old = json.loads(raw)
            ok, reason = validator(incoming, old)
            if not ok:
                raise LedgerError('INVALID_PROJECT_STATE', reason, 400)
            facts = self.facts(db)
            self.check_sync(old, facts)
            stamp = self.now()
            last_clock = db.execute("SELECT value FROM planning_meta WHERE key='last_clock'").fetchone()[0]
            if stamp < last_clock:
                raise LedgerError('BUSINESS_CLOCK_REGRESSED', '服务端时钟早于已记录事件，请核对系统时间。', 503)
            new = copy.deepcopy(incoming)
            old_projects = {p['id']: p for p in old['projects']}
            new_projects = {p['id']: p for p in new['projects']}
            events, affected = [], set()
            next_revision = revision + 1
            for pid, project in new_projects.items():
                previous = old_projects.get(pid)
                if previous is None:
                    if pid in facts:
                        raise LedgerError('PROJECT_ID_RETIRED', '已删除项目ID不能重新使用。')
                    empty_hash = digest({'bodies': {}, 'structures': {}})
                    db.execute('''INSERT INTO planning_project_facts
                        (project_id,origin,created_at,observed_at,baseline_status,last_status,content_hash)
                        VALUES (?,'tracked',?,?,'active','active',?)''', (pid, stamp, stamp, empty_hash))
                    facts[pid] = rows(db, 'SELECT * FROM planning_project_facts WHERE project_id=?', (pid,))[0]
                    events.append(self.event(db, pid, 'created', stamp, 'active', next_revision, key))
                    affected.add(pid)
                fact = facts[pid]
                new_hash = digest(content_of(new, pid))
                previous_status = previous['status'] if previous else 'active'
                if new_hash != fact['content_hash']:
                    events.append(self.event(db, pid, 'content_saved', stamp, previous_status, next_revision, key, new_hash))
                    fact.update(content_hash=new_hash, last_content_saved_at=stamp, last_progress_at=stamp)
                    affected.add(pid)
                if project['status'] != previous_status:
                    kind = 'archived' if project['status'] == 'archived' else 'restored'
                    events.append(self.event(db, pid, kind, stamp, project['status'], next_revision, key))
                    if kind == 'archived':
                        fact['latest_archived_at'] = stamp
                        if fact['origin'] == 'tracked' and not fact['first_archived_at']:
                            fact['first_archived_at'] = stamp
                    else:
                        fact['last_progress_at'] = stamp
                    affected.add(pid)
                fact['last_status'] = project['status']
                db.execute('''UPDATE planning_project_facts SET first_archived_at=?,latest_archived_at=?,
                    last_content_saved_at=?,last_progress_at=?,last_status=?,content_hash=? WHERE project_id=?''',
                    (fact['first_archived_at'], fact['latest_archived_at'], fact['last_content_saved_at'],
                     fact['last_progress_at'], fact['last_status'], fact['content_hash'], pid))
                self.protect_times(project, previous, fact, stamp, pid in affected)
            for pid in old_projects.keys() - new_projects.keys():
                events.append(self.event(db, pid, 'deleted', stamp, 'deleted', next_revision, key))
                db.execute("UPDATE planning_project_facts SET deleted_at=?,last_status='deleted' WHERE project_id=?", (stamp, pid))
                facts[pid].update(deleted_at=stamp, last_status='deleted')
                affected.add(pid)
            db.execute('UPDATE app_state SET revision=?,value=? WHERE id=1', (next_revision, encoded(new)))
            db.execute("UPDATE planning_meta SET value=? WHERE key='last_clock'", (stamp,))
            result = {'revision': next_revision, 'duplicate': False, 'businessTime': stamp,
                      'eventsRecorded': len(events), 'eventIds': events,
                      'projectTimes': {pid: self.project_times(facts[pid]) for pid in sorted(affected)}}
            db.execute('INSERT INTO planning_write_receipts VALUES (?,?,?,?,?,?)',
                       (key, body_hash, expected, next_revision, stamp, encoded(result)))
            if commit:
                db.commit()
            return result
        except Exception:
            db.rollback()
            raise
