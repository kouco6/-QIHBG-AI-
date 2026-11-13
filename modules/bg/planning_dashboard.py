"""One personal dashboard response from one SQLite/clock snapshot."""
import calendar
import json
import re
from datetime import date, datetime, time, timedelta, timezone
from urllib.parse import parse_qs, quote

from planning_ledger import LedgerError, digest, rows


def parsed_time(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except (AttributeError, TypeError, ValueError):
        return None


def iso_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('ISO date required')
    return date.fromisoformat(value)


def month_after(value):
    return date(value.year + (value.month == 12), value.month % 12 + 1, 1)


def calendar_range(query, ledger, now):
    params = parse_qs(query, keep_blank_values=True)
    if set(params) & {'userId', 'ownerId', 'accountId', 'account'}:
        raise LedgerError('PERSONAL_SCOPE_ONLY', '看板只查询当前登录账号，不能指定其他用户。', 403)
    if set(params) - {'period', 'anchor', 'start', 'end', 'grain', 'projectId'} or any(len(v) != 1 for v in params.values()):
        raise LedgerError('INVALID_DASHBOARD_QUERY', '查询字段未知、重复或不完整。', 422)
    values = {key: value[0] for key, value in params.items()}
    period = values.get('period', 'month')
    try:
        if period not in {'week', 'month', 'year', 'custom'}:
            raise ValueError('Invalid period')
        today = now.astimezone(ledger.zone).date()
        if period == 'custom':
            if 'anchor' in values: raise ValueError('Custom anchor is ambiguous')
            start, end = iso_date(values.get('start')), iso_date(values.get('end'))
        else:
            if 'start' in values or 'end' in values: raise ValueError('Period and explicit dates conflict')
            anchor = iso_date(values['anchor']) if 'anchor' in values else today
            if period == 'week':
                start = anchor - timedelta(days=(anchor.weekday() - ledger.week_start) % 7)
                end = start + timedelta(days=6)
            elif period == 'month':
                start = anchor.replace(day=1); end = anchor.replace(day=calendar.monthrange(anchor.year, anchor.month)[1])
            else:
                start, end = date(anchor.year, 1, 1), date(anchor.year, 12, 31)
        if start > end: raise ValueError('Reversed dates')
        end_exclusive_date = end + timedelta(days=1)
        start_at = datetime.combine(start, time.min, ledger.zone).astimezone(timezone.utc)
        end_at = datetime.combine(end_exclusive_date, time.min, ledger.zone).astimezone(timezone.utc)
        span = (end - start).days + 1
        expected_grain = 'month' if period == 'year' else 'day' if period != 'custom' or span <= 62 else 'week' if span <= 366 else 'month'
        grain = values.get('grain', 'auto')
        if grain not in {'auto', 'day', 'week', 'month'}: raise ValueError('Invalid grain')
        if period != 'custom' and grain not in {'auto', expected_grain}: raise ValueError('Wrong period grain')
        grain = expected_grain if grain == 'auto' else grain
        # Explicit daily queries should not accidentally allocate millions of bins.
        if grain == 'day' and span > 3660:
            raise ValueError('Use auto/week/month for a large custom range')
        cutoff_date = min(end, today)
        return {'period': period, 'start': start, 'end': end, 'start_at': start_at,
                'end_at': end_at, 'grain': grain, 'cutoff_date': cutoff_date,
                'project_id': values.get('projectId')}
    except (ValueError, OverflowError, TypeError):
        raise LedgerError('INVALID_DASHBOARD_RANGE', '日期或粒度无效；请使用有效的YYYY-MM-DD起止日期及匹配粒度。', 422) from None


def bucket_start(value, spec, ledger):
    if spec['grain'] == 'day': return value
    if spec['grain'] == 'week':
        return max(spec['start'], value - timedelta(days=(value.weekday() - ledger.week_start) % 7))
    return max(spec['start'], value.replace(day=1))


def trend_bins(spec, ledger):
    result = {}; cursor = spec['start']
    end_exclusive = spec['end'] + timedelta(days=1)
    while cursor < end_exclusive:
        if spec['grain'] == 'day': nxt = cursor + timedelta(days=1)
        elif spec['grain'] == 'week': nxt = cursor + timedelta(days=7 - (cursor.weekday() - ledger.week_start) % 7)
        else: nxt = month_after(cursor)
        nxt = min(nxt, end_exclusive)
        result[cursor] = {'startDate': cursor.isoformat(), 'endDate': (nxt - timedelta(days=1)).isoformat(),
                          'completedProjectCount': 0}
        cursor = nxt
    return result


def query_dashboard(db, ledger, query):
    # Serialize the short capture with writers, then release it before calculation.
    # All cards, bins and lists below use these captured records and one clock.
    db.execute('BEGIN IMMEDIATE')
    try:
        stamp = ledger.now(); now = datetime.fromisoformat(stamp)
        meta = dict(db.execute('SELECT key,value FROM planning_meta'))
        if stamp < meta['last_clock']:
            raise LedgerError('BUSINESS_CLOCK_REGRESSED', '服务端时钟早于已记录事件，请核对系统时间。', 503)
        spec = calendar_range(query, ledger, now)
        revision, raw = db.execute('SELECT revision,value FROM app_state WHERE id=1').fetchone()
        state = json.loads(raw); facts = ledger.facts(db); ledger.check_sync(state, facts)
        projects = {p['id']: p for p in state['projects'] if not facts[p['id']]['deleted_at']}
        if spec['project_id'] is not None:
            if spec['project_id'] not in projects:
                raise LedgerError('PROJECT_NOT_FOUND', '当前账号未找到此项目。', 404)
            projects = {spec['project_id']: projects[spec['project_id']]}
        events = rows(db, '''SELECT * FROM planning_events WHERE occurred_at<=? AND occurred_at<?
            ORDER BY occurred_at,seq''', (stamp, spec['end_at'].isoformat(timespec='microseconds')))
        db.commit()
    except Exception:
        db.rollback(); raise
    history = {pid: [] for pid in projects}
    for event in events:
        if event['project_id'] in history: history[event['project_id']].append(event)
    completed, progress, cycles = [], [], []
    bins = trend_bins(spec, ledger)
    labels = {'active': '进行中', 'archived': '已完成'}
    for pid, project in projects.items():
        fact, timeline = facts[pid], history[pid]
        status = timeline[-1]['status_after'] if timeline else None
        created = parsed_time(fact['created_at'])
        first = parsed_time(fact['first_archived_at'])
        if first and (first > now or first >= spec['end_at']): first = None
        def latest(kinds):
            return next((parsed_time(e['occurred_at']) for e in reversed(timeline) if e['kind'] in kinds), None)
        saved, restored_or_saved, archived = latest({'content_saved'}), latest({'content_saved', 'restored'}), latest({'archived'})
        last_result = max((t for t in (saved, archived) if t is not None), default=None)
        def days(until):
            if not created or not until or until.astimezone(ledger.zone).date() < created.astimezone(ledger.zone).date(): return None
            return (until.astimezone(ledger.zone).date() - created.astimezone(ledger.zone).date()).days
        first_days = days(first)
        detail = {'projectId': pid, 'projectName': project['name'], 'projectType': project['type'],
                  'createdAt': fact['created_at'], 'firstArchivedAt': first.isoformat() if first else None,
                  'latestArchivedAt': archived.isoformat() if archived else None,
                  'lastProgressAt': restored_or_saved.isoformat() if restored_or_saved else None,
                  'lastContentSavedAt': saved.isoformat() if saved else None,
                  'firstCompletionDays': first_days,
                  'daysInProgress': ((spec['cutoff_date'] - created.astimezone(ledger.zone).date()).days
                                     if created and status == 'active' and created.astimezone(ledger.zone).date() <= spec['cutoff_date'] else None),
                  'latestCumulativeDays': days(last_result), 'statusAtCutoff': status,
                  'statusLabel': labels.get(status, '历史状态未知'),
                  'firstArchiveUnknown': fact['origin'] == 'legacy_unknown' and first is None,
                  'projectUrl': '/bg/#bg=overview/' + quote(pid, safe='') + '/'}
        if first and spec['start_at'] <= first < spec['end_at']:
            completed.append(detail)
            bins[bucket_start(first.astimezone(ledger.zone).date(), spec, ledger)]['completedProjectCount'] += 1
            if first_days is not None: cycles.append(first_days)
        if status == 'active' and any(e['kind'] in {'content_saved', 'restored'} and
                                     spec['start_at'] <= parsed_time(e['occurred_at']) for e in timeline):
            progress.append(detail)
    completed.sort(key=lambda p: (p['firstArchivedAt'], p['projectId']), reverse=True)
    progress.sort(key=lambda p: (p['lastProgressAt'], p['projectId']), reverse=True)
    coverage_start = parsed_time(meta['coverage_start'])
    legacy = [facts[pid] for pid in projects if facts[pid]['origin'] == 'legacy_unknown']
    range_info = {'period': spec['period'], 'startDate': spec['start'].isoformat(), 'endDate': spec['end'].isoformat(),
                  'startInclusive': spec['start_at'].isoformat(), 'endExclusive': spec['end_at'].isoformat(),
                  'statisticsCutoff': min(now, spec['end_at']).isoformat(), 'cutoffDate': spec['cutoff_date'].isoformat(),
                  'timezone': ledger.timezone, 'weekStartsOn': ledger.week_start, 'grain': spec['grain']}
    return {'contractVersion': 'planning-dashboard-v1', 'snapshotId': digest([revision, stamp, range_info, spec['project_id']]),
            'revision': revision, 'asOf': stamp, 'range': range_info,
            'metrics': {'completedProjectCount': len(completed), 'inProgressProjectCount': len(progress),
                        'averageFirstCompletionDays': sum(cycles) / len(cycles) if cycles else None},
            'samples': {'completionCycleCount': len(cycles), 'completionCycleTotalDays': sum(cycles)},
            'trend': list(bins.values()), 'completedProjects': completed, 'inProgressProjects': progress,
            'coverage': {'eventsFrom': meta['coverage_start'],
                         'containsPreTrackingDates': spec['start_at'] < coverage_start,
                         'legacyProjectCount': len(legacy),
                         'unknownFirstArchiveCount': sum(f['first_archived_at'] is None for f in legacy),
                         'unknownCreationCount': sum(facts[pid]['created_at'] is None for pid in projects),
                         'warning': ('仅统计可核实记录；旧日期或事件缺失未作推算。'
                                     if spec['start_at'] < coverage_start or legacy else None)}}


def dashboard_contract():
    return {'contractVersion': 'planning-dashboard-v1', 'method': 'GET', 'path': '/bg/api/planning-dashboard',
            'authentication': 'existing platform session with bg grant; no caller-supplied user identity',
            'query': {'period': ['week', 'month', 'year', 'custom'], 'anchor': 'optional YYYY-MM-DD for week/month/year',
                      'start': 'required inclusive YYYY-MM-DD for custom', 'end': 'required inclusive YYYY-MM-DD for custom',
                      'grain': ['auto', 'day', 'week', 'month'], 'projectId': 'optional; only own existing project'},
            'default': 'current month in configured business timezone',
            'response': ['snapshotId', 'asOf', 'revision', 'range', 'metrics', 'samples', 'trend',
                         'completedProjects', 'inProgressProjects', 'coverage'],
            'rules': ['only trusted first archive counts as completion', 'no inferred legacy dates',
                      'deleted projects excluded from every period', 'both detail groups may contain the same project',
                      'never add the two counts as total projects', 'no valid cycle sample => null, display —'],
            'implemented': True, 'businessAcceptance': 'pending user acceptance'}
