"""Read-only personal statistics from an explicitly imported, frozen projection."""
from contextlib import closing
import hashlib
import json
import re
import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo

class LedgerError(Exception):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code, self.status = code, status

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()

def rows(db, sql, args=()):
    cursor = db.execute(sql, args)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]

class SnapshotLedger:
    def __init__(self, db, as_of=None):
        meta = dict(db.execute('SELECT key,value FROM planning_meta'))
        self.stamp = as_of or meta['snapshot_as_of']
        self.zone = ZoneInfo(meta['business_timezone'])
        self.timezone, self.week_start = meta['business_timezone'], int(meta['week_start'])
        # Include trusted creations and older coverage without inventing legacy dates.
        stamps = [self.stamp, meta['coverage_start']]
        stamps += [r[0] for r in db.execute('SELECT created_at FROM planning_project_facts WHERE created_at IS NOT NULL')]
        stamps += [r[0] for r in db.execute('SELECT occurred_at FROM planning_events')]
        self.earliest_date = min(datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(self.zone).date() for s in stamps)
    def now(self):
        return self.stamp
    @staticmethod
    def facts(db):
        return {row['project_id']: row for row in rows(db, 'SELECT * FROM planning_project_facts')}

def snapshot_dashboard(data, account_id, query):
    from dashboard import query_dashboard
    if not re.fullmatch('[a-f0-9]{32}', account_id):
        raise LedgerError('INVALID_ACCOUNT', '登录身份无效。', 403)
    path = data / 'planning-statistics' / (account_id + '.sqlite3')
    if not path.is_file():
        raise LedgerError('SNAPSHOT_UNAVAILABLE', '尚无该账号可用的历史统计快照，暂不显示示例数。', 503)
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        ledger = SnapshotLedger(db)
        result = query_dashboard(db, ledger, query)
        result['mode'] = 'history-snapshot'
        result['snapshotAsOf'] = ledger.stamp
        return result
