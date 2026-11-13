#!/usr/bin/env python3
"""Local Planning BG server with durable first-round WorkBuddy handoff."""
import argparse
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from round1_service import Round1Error, Round1Service
from planning_ledger import LedgerError, ProjectLedger
from planning_dashboard import dashboard_contract, query_dashboard
from research_sync import import_working

ROOT = Path(__file__).resolve().parent
DB = ROOT / 'platform.sqlite3'
INDEX = ROOT / 'index.html'
DIM01_CORE = ROOT / 'dimension-assets' / 'dim01-core.html'
DIM02_CORE = ROOT / 'dimension-assets' / 'dim02-core.html'
DIM02_WORKMODE = ROOT / 'dimension-assets' / 'dim02-workmode.js'
DIM03_CORE = ROOT / 'dimension-assets' / 'dim03-core.html'
DIM03_SCRIPT = ROOT / 'dimension-assets' / 'dim03-core.js'
DIM03_SEED = ROOT / 'dimension-assets' / 'dim03-seed.json'
DIM04_CORE = ROOT / 'dimension-assets' / 'dim04-core.html'
DIM04_SCRIPT = ROOT / 'dimension-assets' / 'dim04-core.js'
DIM04_SEED = ROOT / 'dimension-assets' / 'dim04-seed.json'
DIM_MULTI_CORE = ROOT / 'dimension-assets' / 'dim-multi-core.html'
DIM06_CORE = ROOT / 'dimension-assets' / 'dim06-core.html'
DIM_MULTI_SCRIPT = ROOT / 'dimension-assets' / 'dim-multi-core.js'
DIM_MULTI_PLATFORM = ROOT / 'dimension-assets' / 'dim-multi-platform.js'
DIM_BID_CORE = ROOT / 'dimension-assets' / 'dim-bid-core.html'
DIM_BID_SCRIPT = ROOT / 'dimension-assets' / 'dim-bid-core.js'
DIM_FINAL_CORE = ROOT / 'dimension-assets' / 'dim-final-core.html'
DIM_FINAL_SCRIPT = ROOT / 'dimension-assets' / 'dim-final-core.js'
DIM_MULTI_SEEDS = {f'DIM-{number:02d}': ROOT / 'dimension-assets' / f'dim{number:02d}-seed.json' for number in range(5, 13)}
LOCK = threading.RLock()
CSRF_TOKEN = secrets.token_urlsafe(32)
ROUND1 = Round1Service(DB, ROOT, LOCK)
LEDGER = ProjectLedger(business_timezone=os.getenv('PLATFORM_BUSINESS_TIMEZONE', 'Asia/Shanghai'),
                       week_start=int(os.getenv('PLATFORM_BUSINESS_WEEK_START', '0')))


def initial_state():
    return {'projects': [], 'bodies': {}, 'cycles': {}, 'history': {}, 'showcases': {}, 'runs': [], 'settings': {'saveFailure': False}}


def connect():
    db = sqlite3.connect(DB, timeout=8)
    try:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)')
        db.execute('INSERT OR IGNORE INTO app_state VALUES (1, 0, ?)', (json.dumps(initial_state(), ensure_ascii=False),))
        revision, raw = db.execute('SELECT revision,value FROM app_state WHERE id=1').fetchone()
        LEDGER.migrate(db, json.loads(raw), revision)
        db.commit()
        return db
    except Exception:
        db.rollback()
        db.close()
        raise


def get_state():
    with LOCK, connect() as db:
        row = db.execute('SELECT revision, value FROM app_state WHERE id=1').fetchone()
        return row[0], json.loads(row[1])


def valid_dim01_snapshot(value, *, release=False):
    if not isinstance(value, dict):
        return False
    if isinstance(value.get('matrix'), dict):
        return not release and isinstance(value.get('catalog'), list) and isinstance(value.get('ecos'), list)
    if value.get('version') != 1:
        return False
    rows, cols, fields, cards, groups = (value.get(k) for k in ('rows', 'cols', 'fields', 'cards', 'groups'))

    def named(items, minimum, maximum):
        if not isinstance(items, list) or not minimum <= len(items) <= maximum:
            return False
        if any(not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id']
               or not isinstance(item.get('name'), str) or (release and not item['name'].strip()) for item in items):
            return False
        return len({item['id'] for item in items}) == len(items)

    if not (named(rows, 3, 3) and named(cols, 3, 5) and named(fields, 1, 4) and named(groups, 0, 500)):
        return False
    if not isinstance(cards, dict):
        return False
    slots = {row['id'] + '|' + col['id'] for row in rows for col in cols}
    field_ids = {field['id'] for field in fields}
    states = {'covered', 'uncovered', 'project'}
    if release and len({field['name'].strip() for field in fields}) != len(fields):
        return False
    for slot, card in cards.items():
        if slot not in slots:
            return False
        if card is None:
            continue
        if not isinstance(card, dict) or not isinstance(card.get('title'), str):
            return False
        values, status = card.get('values'), card.get('status')
        if not isinstance(values, dict) or set(values) != field_ids or any(not isinstance(v, str) for v in values.values()):
            return False
        if not isinstance(status, str) or status not in (states if release else states | {''}):
            return False
        if release and (not card['title'].strip() or any(not v.strip() for v in values.values())):
            return False
    for group in groups:
        if not named(group.get('products'), 0, 1000):
            return False
        if any(type(product.get('project')) is not bool for product in group['products']):
            return False
    return not release or any(cards.values()) or any(group['products'] for group in groups)


def valid_dim02_v1_snapshot(value):
    """The new interactive page accepts incomplete work drafts as well as releases."""
    def field(text, limit=2000):
        return isinstance(text, str) and len(text) <= limit

    def image(value):
        return field(value, 650_000) and (
            not value or re.fullmatch(r'data:image/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+', value) is not None
        )

    if not isinstance(value, dict) or not field(value.get('largeName')) or not image(value.get('largeImage')):
        return False
    enabled = value.get('enabled')
    if enabled is not None and (not isinstance(enabled, dict) or set(enabled) != {'large', 'scenes'}
                                or any(type(enabled[key]) is not bool for key in ('large', 'scenes'))):
        return False
    systems, scenes = value.get('systems'), value.get('scenes')
    if not isinstance(systems, list) or len(systems) > 100 or not isinstance(scenes, list) or len(scenes) > 100:
        return False
    ids = set()
    def unique_id(row):
        item_id = row.get('id')
        if not field(item_id, 120) or not item_id or item_id in ids:
            return False
        ids.add(item_id)
        return True

    for system in systems:
        if not isinstance(system, dict) or not unique_id(system) or not field(system.get('name')):
            return False
        devices = system.get('devices')
        if not isinstance(devices, list) or len(devices) > 200:
            return False
        for device in devices:
            if (not isinstance(device, dict) or not unique_id(device) or not field(device.get('name'))
                    or device.get('status') not in ('planned', 'existing', 'missing')
                    or not image(device.get('image'))):
                return False
    for scene in scenes:
        if (not isinstance(scene, dict) or not unique_id(scene) or not field(scene.get('name'))
                or not image(scene.get('topology'))):
            return False
        for key in ('features', 'needs', 'pains', 'goals'):
            entries = scene.get(key)
            if not isinstance(entries, list) or len(entries) > 200:
                return False
            for entry in entries:
                if not isinstance(entry, dict) or not unique_id(entry):
                    return False
                if key == 'goals':
                    if not field(entry.get('text'), 10000):
                        return False
                elif not field(entry.get('name')) or not field(entry.get('description'), 10000):
                    return False
    return True


def valid_dim02_v1_release(value):
    if not valid_dim02_v1_snapshot(value):
        return False
    large = value.get('enabled', {}).get('large', True)
    scenes = value.get('enabled', {}).get('scenes', True)
    if not large and not scenes:
        return False
    if 'enabled' in value and (large and not value['largeImage'] or scenes and not value['scenes']):
        return False
    if large:
        if not value['largeName'].strip() or not value['systems']:
            return False
        for system in value['systems']:
            if not system['name'].strip() or not system['devices'] or any(not device['name'].strip() for device in system['devices']):
                return False
    names = set()
    for scene in value['scenes'] if scenes else []:
        name = scene['name'].strip().casefold()
        if not name or name in names or not scene['topology']:
            return False
        names.add(name)
        for key in ('features', 'needs', 'pains', 'goals'):
            if not scene[key]:
                return False
            if key == 'goals':
                if any(not entry['text'].strip() for entry in scene[key]):
                    return False
            elif any(not entry['name'].strip() or not entry['description'].strip() for entry in scene[key]):
                return False
    return True


def valid_dim02_snapshot(value):
    if not isinstance(value, dict):
        return False
    if 'largeName' in value:
        return valid_dim02_v1_snapshot(value)
    def nonempty(text):
        return isinstance(text, str) and bool(text.strip()) and len(text) <= 2000
    if not nonempty(value.get('macroTitle')) or not nonempty(value.get('macroIntro')):
        return False
    systems = value.get('systems')
    if not isinstance(systems, list) or len(systems) != 6:
        return False
    for group, count in zip(systems, (4, 4, 3, 2, 3, 1)):
        if not isinstance(group, dict) or not nonempty(group.get('title')) or not nonempty(group.get('note')) or not isinstance(group.get('emoji'), str):
            return False
        devices = group.get('devices')
        if not isinstance(devices, list) or len(devices) != count:
            return False
        if any(not isinstance(item, dict) or not nonempty(item.get('name')) or item.get('status') not in ('待核实', '企划产品', '已有产品', '未有产品') for item in devices):
            return False
    hotspots = value.get('hotspots')
    if not isinstance(hotspots, dict) or set(hotspots) != {'receiver', 'chair', 'delegate', 'interpreter', 'camera', 'recorder', 'processor', 'speaker', 'screen', 'host'}:
        return False
    for item in hotspots.values():
        if not isinstance(item, list) or len(item) != 3 or type(item[0]) is not int or not 0 <= item[0] < 6 or not nonempty(item[1]) or not nonempty(item[2]):
            return False
    scenes = value.get('scenes')
    ids = ('nuclear-island', 'conventional-island', 'physical-protection', 'administrative-area', 'emergency-command')
    counts = ((2, 2, 2, 4), (2, 2, 2, 3), (2, 2, 1, 2), (2, 2, 1, 2), (2, 2, 2, 4))
    if not isinstance(scenes, list) or len(scenes) != 5:
        return False
    for scene, scene_id, sizes in zip(scenes, ids, counts):
        if not isinstance(scene, dict) or scene.get('id') != scene_id or not nonempty(scene.get('name')) or not nonempty(scene.get('intro')):
            return False
        for field, count in zip(('characteristics', 'needs', 'pains'), sizes[:3]):
            rows = scene.get(field)
            if not isinstance(rows, list) or len(rows) != count or any(not isinstance(row, dict) or not nonempty(row.get('keyword')) or not nonempty(row.get('detail')) for row in rows):
                return False
        goals = scene.get('goals')
        if not isinstance(goals, list) or len(goals) != sizes[3] or any(not isinstance(goal, dict) or not nonempty(goal.get('name')) or not nonempty(goal.get('description')) or goal.get('icon') not in ('priority', 'zone', 'monitor', 'shield') for goal in goals):
            return False
    return True


def valid_dim03_snapshot(value):
    if isinstance(value, dict) and value.get('format') == 'v5':
        rows = value.get('rows')
        fields = ('name', 'grade', 'expiry', 'owned', 'difficulty', 'barrier')
        return (set(value) == {'format', 'rows'} and isinstance(rows, list) and len(rows) <= 2000
                and len({r.get('id') for r in rows if isinstance(r, dict)}) == len(rows)
                and all(isinstance(r, dict) and set(r) == {'id', *fields}
                        and isinstance(r['id'], str) and 0 < len(r['id']) <= 120
                        and all(isinstance(r[field], str) and len(r[field]) <= 2000 for field in fields)
                        for r in rows))
    if not isinstance(value, dict) or set(value) != {'groups'}:
        return False
    groups = value['groups']
    if not isinstance(groups, list) or len(groups) != 3:
        return False
    fields = {'资质名称', '资质等级', '有效期', '公司是否拥有', '获取难度', '行业门槛'}
    grades = {'强制性', '市级', '省级', '国家级', '行业', '待核实'}
    for group, group_id, group_name, count in zip(groups, ('product', 'standard', 'enterprise'), ('产品认证', '技术标准', '企业资质'), (8, 6, 6)):
        if not isinstance(group, dict) or set(group) != {'id', 'name', 'items'} or group['id'] != group_id or group['name'] != group_name:
            return False
        if not isinstance(group['items'], list) or len(group['items']) != count:
            return False
        for item in group['items']:
            if not isinstance(item, dict) or set(item) != fields or any(not isinstance(v, str) or not v.strip() or len(v) > 2000 for v in item.values()):
                return False
            if item['资质等级'] not in grades or item['公司是否拥有'] not in {'是', '否', '待核实'}:
                return False
            if item['获取难度'] not in {'低', '中', '高', '待核实'} or item['行业门槛'] not in {'低', '中', '高', '待核实'}:
                return False
            expiry = item['有效期']
            if expiry not in {'长期', '待核实'} and not (len(expiry) == 5 and expiry[:4].isdigit() and expiry.endswith('年')):
                return False
    return True


def valid_dim04_snapshot(value):
    if isinstance(value, dict) and value.get('format') == 'v1.1':
        rows, analysis, evidence = value.get('rows'), value.get('analysis'), value.get('evidence')
        fields = ('name', 'source', 'maturity', 'leading', 'barrier', 'value', 'company', 'industry')
        if set(value) != {'format', 'rows', 'analysis', 'evidence'} or not isinstance(rows, list) or len(rows) > 300:
            return False
        if not isinstance(analysis, dict) or not isinstance(evidence, dict) or len(analysis) > 300 or len(evidence) > 3000:
            return False
        if len({row.get('id') for row in rows if isinstance(row, dict)}) != len(rows):
            return False
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id'] or len(row['id']) > 120:
                return False
            if any(not isinstance(row.get(field), str) or len(row[field]) > 10000 for field in fields):
                return False
            if type(row.get('aiInitial')) is not bool or type(row.get('companyTouched')) is not bool:
                return False
        for tech in analysis.values():
            if not isinstance(tech, dict) or not isinstance(tech.get('id'), str) or not isinstance(tech.get('points'), list) or len(tech['points']) > 200:
                return False
            for key in ('category', 'subtitle', 'source', 'overall', 'scope'):
                if not isinstance(tech.get(key), str) or len(tech[key]) > 10000:
                    return False
            for point in tech['points']:
                if not isinstance(point, dict) or not isinstance(point.get('id'), str) or not isinstance(point.get('evidence'), list) or len(point['evidence']) > 200:
                    return False
                if any(not isinstance(item, str) for item in point['evidence']):
                    return False
                if any(not isinstance(point.get(key), str) or len(point[key]) > 10000 for key in ('title', 'summary', 'performance', 'benchmark', 'difference', 'reason', 'value', 'supplement')):
                    return False
        for source in evidence.values():
            if not isinstance(source, dict) or any(not isinstance(source.get(key), str) or len(source[key]) > 10000
                                                    for key in ('id', 'publisher', 'title', 'url', 'where', 'excerpt', 'support', 'note')):
                return False
        return True
    if not isinstance(value, dict) or set(value) != {'topics'} or not isinstance(value['topics'], list) or len(value['topics']) != 3:
        return False
    def nonempty(text):
        return isinstance(text, str) and bool(text.strip()) and len(text) <= 2000
    headings = ('一、技术来源与原理', '二、技术成熟度分析', '三、行业领先程度分析', '四、技术壁垒分析', '五、产品竞争力贡献')
    labels = {'来源类型', '发布方／对象', '版本／条款', '原文出处', '核验状态'}
    topic_fields = {'id', 'kicker', 'title', 'subtitle', 'sections', 'benchmark', 'difference', 'evidence', 'recommendations'}
    for topic, topic_id, rec_count in zip(value['topics'], ('aes67', 'ptp', 'redundancy'), (3, 2, 3)):
        if not isinstance(topic, dict) or set(topic) != topic_fields or topic['id'] != topic_id:
            return False
        if any(not nonempty(topic[field]) for field in ('kicker', 'title', 'subtitle', 'difference')):
            return False
        sections = topic['sections']
        if not isinstance(sections, list) or len(sections) != 5:
            return False
        for section, heading, count in zip(sections, headings, (2, 1, 1, 1, 1)):
            if not isinstance(section, dict) or set(section) != {'heading', 'paragraphs'} or section['heading'] != heading:
                return False
            if not isinstance(section['paragraphs'], list) or len(section['paragraphs']) != count or any(not nonempty(text) for text in section['paragraphs']):
                return False
        rows = topic['benchmark']
        if not isinstance(rows, list) or len(rows) != 3:
            return False
        for row, index in zip(rows, range(1, 4)):
            if not isinstance(row, dict) or set(row) != {'metric', 'company', 'industry', 'difference', 'evidenceId'}:
                return False
            if row['evidenceId'] != f'{topic_id}-e-{index:02d}' or any(not nonempty(row[field]) for field in ('metric', 'company', 'industry', 'difference')):
                return False
        evidence = topic['evidence']
        if not isinstance(evidence, list) or len(evidence) != 3:
            return False
        for item, index in zip(evidence, range(1, 4)):
            if not isinstance(item, dict) or set(item) != {'id', 'title', 'fields'} or item['id'] != f'{topic_id}-e-{index:02d}' or not nonempty(item['title']):
                return False
            if not isinstance(item['fields'], dict) or set(item['fields']) != labels or any(not nonempty(v) for v in item['fields'].values()):
                return False
        recommendations = topic['recommendations']
        if not isinstance(recommendations, list) or len(recommendations) != rec_count:
            return False
        if any(not isinstance(item, dict) or set(item) != {'title', 'body', 'confirm'} or any(not nonempty(v) for v in item.values()) for item in recommendations):
            return False
    return True


def valid_dim_multi_snapshot(dimension_id, value):
    """Keep the sample's field architecture and record identities intact."""
    if dimension_id == 'DIM-06' and isinstance(value, dict) and value.get('format') == 'v5':
        fields = ('category', 'product', 'function', 'functional', 'design', 'test', 'competitor', 'experience')
        rows, widths, merges = value.get('rows'), value.get('widths'), value.get('merges')
        if set(value) - {'format', 'rows', 'widths', 'merges', 'rowHeights'} or not isinstance(rows, list) or len(rows) > 2000:
            return False
        if not isinstance(widths, list) or len(widths) != 8 or any(type(n) not in (int, float) or not 5 <= n <= 40 for n in widths) or not 98 <= sum(widths) <= 102:
            return False
        if (len({r.get('id') for r in rows if isinstance(r, dict)}) != len(rows) or
                any(not isinstance(r, dict) or set(r) != {'id', *fields} or not isinstance(r['id'], str)
                    or not 0 < len(r['id']) <= 120 or any(not isinstance(r[f], str) or len(r[f]) > 10000 for f in fields)
                    for r in rows)):
            return False
        if not isinstance(merges, list) or len(merges) > 1000 or any(
                not isinstance(m, dict) or set(m) != {'r', 'c', 'rs', 'cs'} or
                any(type(m[k]) is not int for k in ('r', 'c', 'rs', 'cs')) or
                m['r'] < 0 or m['c'] < 0 or m['rs'] < 1 or m['cs'] < 1 or
                m['r'] + m['rs'] > len(rows) or m['c'] + m['cs'] > 8
                for m in merges):
            return False
        heights = value.get('rowHeights', {})
        return isinstance(heights, dict) and all(isinstance(k, str) and type(v) in (int, float)
                                                 and 28 <= v <= 600 for k, v in heights.items())
    try:
        seed = json.loads(DIM_MULTI_SEEDS[dimension_id].read_text(encoding='utf-8'))
    except (KeyError, OSError, ValueError):
        return False
    if not isinstance(value, dict) or set(value) != set(seed):
        return False

    product_fields = {'ability_state', 'delivery_state', 'display_label', 'source_state', 'detail', 'raw_research_statement'}
    highlight_fields = {'title', 'category', 'product_scope', 'behavior', 'value', 'boundary'}
    comparison_fields = {'feature', 'legacy', 'pro', 'comparison'}
    performance_fields = {'title', 'point', 'category', 'functional', 'design', 'test', 'competitor', 'experience'}

    def editable(path):
        if dimension_id == 'DIM-05':
            if path in (('scope', 'external_competitor'), ('stats', 'caveat')):
                return True
            if len(path) == 5 and path[0] == 'inventory' and isinstance(path[1], int) and path[2] == 'features' and isinstance(path[3], int):
                return path[4] == 'feature_name'
            if len(path) == 7 and path[0] == 'inventory' and isinstance(path[1], int) and path[2] == 'features' and isinstance(path[3], int) and path[4] == 'products':
                return path[5] in {'legacy', 'pro', 'a24'} and path[6] in product_fields
            if len(path) == 3 and path[0] == 'highlight_features' and isinstance(path[1], int):
                return path[2] in highlight_fields
            if len(path) == 3 and path[0] == 'comparisons' and isinstance(path[1], int):
                return path[2] in comparison_fields
            return False
        if dimension_id == 'DIM-08':
            return path == ('product',) or path == ('ownCost',) or (len(path) == 3 and path[0] == 'competitors' and isinstance(path[1], int) and path[2] in {'name', 'model', 'price', 'source', 'url'}) or (len(path) == 3 and path[0] == 'bom' and isinstance(path[1], int) and path[2] in {'name', 'count', 'unit'})
        if dimension_id == 'DIM-09':
            return (len(path) == 6 and path[0] == 'topics' and isinstance(path[1], int) and path[2] == 'clauses' and path[3] in {'甲', '乙', '丙'} and isinstance(path[4], int) and path[5] in (1, 2)) or (len(path) == 3 and path[0] == 'points' and isinstance(path[1], int) and path[2] in {'title', 'require', 'contrast', 'why', 'type'})
        if dimension_id == 'DIM-10':
            return (len(path) == 3 and path[0] == 'original' and isinstance(path[1], int) and path[2] in {'req', 's'}) or (len(path) == 3 and path[0] == 'topics' and isinstance(path[1], int) and path[2] == 'name')
        if dimension_id == 'DIM-11':
            return len(path) == 3 and path[0] == 'products' and isinstance(path[1], int) and path[2] in {'name', 'model', 'kind', 'imageUrl'} or len(path) == 5 and path[0] == 'products' and isinstance(path[1], int) and path[2] == 'fields' and isinstance(path[3], int) and path[4] == 'value'
        if dimension_id == 'DIM-12':
            return path == ('product',) or len(path) == 2 and path[0] == 'values' and isinstance(path[1], int)
        if len(path) != 3 or path[0] != 'rows' or not isinstance(path[1], int):
            return False
        if dimension_id == 'DIM-06':
            return path[2] in performance_fields
        return path[2] in seed['fields']

    def same_shape(actual, original, path=()):
        if isinstance(original, dict):
            return isinstance(actual, dict) and set(actual) == set(original) and all(
                same_shape(actual[name], item, path + (name,)) for name, item in original.items())
        if isinstance(original, list):
            return isinstance(actual, list) and len(actual) == len(original) and all(
                same_shape(a, b, path + (index,)) for index, (a, b) in enumerate(zip(actual, original)))
        if isinstance(original, str):
            max_length = 800_000 if dimension_id == 'DIM-11' and path[-1:] == ('imageUrl',) else 5000
            blank_work_text = dimension_id == 'DIM-12' and path == ('values', 15)
            if not isinstance(actual, str) or (not blank_work_text and not actual.strip()) or len(actual) > max_length:
                return False
            if editable(path):
                if dimension_id == 'DIM-11' and path[-1] == 'imageUrl' and not (
                    actual == 'sample' or actual.startswith(('https://', 'http://')) and len(actual) <= 2000 or
                    re.fullmatch(r'data:image/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+', actual)):
                    return False
                if dimension_id == 'DIM-12' and path[:1] == ('values',) and path[1] != 15 and actual not in {'yes', 'no', 'pending', 'na'}:
                    return False
                if path[-1] == 'url' and not actual.startswith(('https://', 'http://')):
                    return False
                if dimension_id == 'DIM-09' and path[-1] == 'type' and actual not in {'性能', '功能', '架构', '接口'}:
                    return False
                if dimension_id == 'DIM-09' and path[-1] == 2 and actual not in {'完全满足', '特做满足：低成本/短周期', '特做满足：高成本/长周期', '无法', '待核实'}:
                    return False
                if dimension_id == 'DIM-10' and path[-1] == 's' and actual not in {'full', 'low', 'high', 'none'}:
                    return False
            return editable(path) or actual == original
        if isinstance(original, (int, float)) and editable(path):
            return type(actual) in (int, float) and 0 <= actual <= 1_000_000_000 and (path[-1] != 'count' or type(actual) is int)
        return type(actual) is type(original) and actual == original

    if dimension_id in ('DIM-06', 'DIM-07') and value.get('fields') != seed['fields']:
        return False
    if dimension_id == 'DIM-06' and any(
        actual.get('id') != original['id'] for actual, original in zip(value.get('rows', []), seed['rows'])):
        return False
    return same_shape(value, seed)


def valid_state(new, old):
    if not isinstance(new, dict) or not isinstance(new.get('projects'), list):
        return False, 'Invalid project list'
    if not all(isinstance(new.get(k), dict) for k in ('bodies', 'cycles', 'history')):
        return False, 'Invalid data collections'
    if not isinstance(new.get('runs'), list):
        return False, 'Invalid run list'
    showcases = new.get('showcases', {})
    if not isinstance(showcases, dict):
        return False, 'Invalid dimension showcases'
    old_projects = {p['id']: p for p in old['projects']}
    ids = set()
    for p in new['projects']:
        if not isinstance(p, dict) or not isinstance(p.get('id'), str) or p['id'] in ids:
            return False, 'Duplicate or invalid project ID'
        ids.add(p['id'])
        if not isinstance(p.get('name'), str) or not p['name'].strip() or len(p['name']) > 120 or p.get('type') not in ('单品', '系统') or p.get('status') not in ('active', 'archived'):
            return False, 'Invalid project fields'
        if p['id'] in old_projects and (p['name'], p['type']) != (old_projects[p['id']]['name'], old_projects[p['id']]['type']):
            return False, 'Project name and type are immutable'
    for owner in old.get('showcases', {}):
        if owner in ids and owner not in showcases:
            return False, 'Existing content history cannot be removed'
    for owner, showcase in showcases.items():
        if owner not in ids or not isinstance(showcase, dict):
            return False, 'Invalid showcase owner'
        for dimension_id in ('DIM-01', 'DIM-02', 'DIM-03', 'DIM-04', 'DIM-05', 'DIM-06', 'DIM-07', 'DIM-08', 'DIM-09', 'DIM-10', 'DIM-11', 'DIM-12'):
            item = showcase.get(dimension_id)
            if item is None:
                if old.get('showcases', {}).get(owner, {}).get(dimension_id) is not None:
                    return False, f'{dimension_id} content history cannot be removed'
                continue
            if not isinstance(item, dict) or not isinstance(item.get('current'), dict) or not isinstance(item.get('versions'), list):
                return False, f'Invalid {dimension_id} content versions'
            if dimension_id == 'DIM-01' and not valid_dim01_snapshot(item['current']):
                return False, 'Invalid DIM-01 content data'
            draft = item.get('draft')
            if draft is not None:
                if dimension_id == 'DIM-01' and not valid_dim01_snapshot(draft):
                    return False, 'Invalid DIM-01 work draft'
                if dimension_id == 'DIM-02' and not valid_dim02_v1_snapshot(draft):
                    return False, 'Invalid DIM-02 work draft'
                if dimension_id == 'DIM-03' and not valid_dim03_snapshot(draft):
                    return False, 'Invalid DIM-03 work draft'
                if dimension_id == 'DIM-04' and not valid_dim04_snapshot(draft):
                    return False, 'Invalid DIM-04 work draft'
                if dimension_id in DIM_MULTI_SEEDS and not valid_dim_multi_snapshot(dimension_id, draft):
                    return False, f'Invalid {dimension_id} work draft'
            if dimension_id == 'DIM-02' and not valid_dim02_snapshot(item['current']):
                return False, 'Invalid DIM-02 content data'
            if dimension_id == 'DIM-03' and not valid_dim03_snapshot(item['current']):
                return False, 'Invalid DIM-03 content data'
            if dimension_id == 'DIM-04' and not valid_dim04_snapshot(item['current']):
                return False, 'Invalid DIM-04 content data'
            if dimension_id in DIM_MULTI_SEEDS and not valid_dim_multi_snapshot(dimension_id, item['current']):
                return False, f'Invalid {dimension_id} content data'
            for version in item['versions']:
                if not isinstance(version, dict) or not isinstance(version.get('id'), str) or not isinstance(version.get('snapshot'), dict):
                    return False, f'Invalid {dimension_id} version'
                if dimension_id == 'DIM-01' and not valid_dim01_snapshot(
                        version['snapshot'], release=version.get('label') == '保存并应用' and 'rows' in version['snapshot']):
                    return False, 'Invalid DIM-01 version data'
                if dimension_id == 'DIM-02' and not valid_dim02_snapshot(version['snapshot']):
                    return False, 'Invalid DIM-02 version data'
                if dimension_id == 'DIM-02' and version.get('label') == '保存并应用' and not valid_dim02_v1_release(version['snapshot']):
                    return False, 'Incomplete DIM-02 release'
                if dimension_id == 'DIM-03' and not valid_dim03_snapshot(version['snapshot']):
                    return False, 'Invalid DIM-03 version data'
                if dimension_id == 'DIM-03' and version.get('label') == '保存并应用' and version['snapshot'].get('format') == 'v5':
                    rows = version['snapshot']['rows']
                    fields = ('name', 'grade', 'expiry', 'owned', 'difficulty', 'barrier')
                    active = [r for r in rows if any(r[f].strip() for f in fields)]
                    if not active or any(not all(r[f].strip() for f in fields) or r['owned'] not in ('是', '否')
                                         or r['difficulty'] not in ('低', '中', '高', '待核实') or r['barrier'] not in ('低', '中', '高', '待核实')
                                         for r in active):
                        return False, 'Incomplete DIM-03 release'
                if dimension_id == 'DIM-04' and not valid_dim04_snapshot(version['snapshot']):
                    return False, 'Invalid DIM-04 version data'
                if dimension_id == 'DIM-04' and version.get('label') == '保存并应用' and version['snapshot'].get('format') == 'v1.1':
                    snapshot = version['snapshot']
                    if not snapshot['rows']:
                        return False, 'Empty DIM-04 release'
                    for row in snapshot['rows']:
                        fields = ('name', 'source', 'maturity', 'leading', 'barrier', 'value', 'industry')
                        if any(not row[field].strip() for field in fields) or (not row['company'].strip() and not (row['aiInitial'] and not row['companyTouched'])):
                            return False, 'Incomplete DIM-04 technology row'
                        analysis = snapshot['analysis'].get(row['id'])
                        if not analysis or not analysis['overall'].strip() or not analysis['scope'].strip():
                            return False, 'Incomplete DIM-04 analysis'
                        for point in analysis['points']:
                            if not point['evidence']:
                                return False, 'DIM-04 evidence missing'
                            for source_id in point['evidence']:
                                source = snapshot['evidence'].get(source_id)
                                if not source or not all(source[field].strip() for field in ('publisher', 'title', 'url', 'support')) or not source['url'].startswith(('http://', 'https://')):
                                    return False, 'Incomplete DIM-04 evidence'
                if dimension_id in DIM_MULTI_SEEDS and not valid_dim_multi_snapshot(dimension_id, version['snapshot']):
                    return False, f'Invalid {dimension_id} version data'
                if version.get('label') == '保存并应用' and dimension_id == 'DIM-06' and version['snapshot'].get('format') == 'v5':
                    snapshot = version['snapshot']
                    keys = ('category', 'product', 'function', 'functional', 'design', 'test', 'competitor', 'experience')
                    effective_count = 0
                    for row_index, row in enumerate(snapshot['rows']):
                        values = []
                        for column, key in enumerate(keys):
                            merge = next((m for m in snapshot['merges'] if m['r'] <= row_index < m['r'] + m['rs']
                                          and m['c'] <= column < m['c'] + m['cs']), None)
                            values.append(snapshot['rows'][merge['r']][key] if merge and merge['c'] == column
                                          else '' if merge else row[key])
                        if any(value.strip() for value in values):
                            effective_count += 1
                            if any(not value.strip() for value in values[:6]):
                                return False, 'Incomplete DIM-06 release'
                    if not effective_count:
                        return False, 'Empty DIM-06 release'
                if version.get('label') == '保存并应用' and dimension_id == 'DIM-12':
                    values = version['snapshot']['values']
                    if any(value not in ('yes', 'no') for index, value in enumerate(values) if index != 15) or not values[15].strip():
                        return False, 'Incomplete DIM-12 release'
            if len({version['id'] for version in item['versions']}) != len(item['versions']):
                return False, f'Duplicate {dimension_id} version ID'
            old_item = old.get('showcases', {}).get(owner, {}).get(dimension_id)
            previous = old_item.get('versions', []) if old_item else []
            old_by_id = {version['id']: version for version in previous}
            retained = [version['id'] for version in item['versions'] if version['id'] in old_by_id]
            if retained != [version['id'] for version in previous if version['id'] in retained]:
                return False, f'{dimension_id} content history cannot be reordered'
            applied_updates = []
            for version in item['versions']:
                prior_version = old_by_id.get(version['id'])
                if prior_version is None:
                    if version.get('kind') not in ('draft', 'working-backup'):
                        applied_updates.append(version)
                    continue
                if version == prior_version:
                    continue
                applied_at = version.get('appliedAt')
                if (prior_version.get('kind') != 'draft' or not isinstance(applied_at, str) or not applied_at
                        or version != {**prior_version, 'kind': 'applied', 'label': '保存并应用', 'appliedAt': applied_at}):
                    return False, f'{dimension_id} content history cannot be rewritten'
                applied_updates.append(version)
            if applied_updates:
                if item['current'] != applied_updates[-1]['snapshot']:
                    return False, f'{dimension_id} current content must match latest applied version'
            elif old_item and item['current'] != old_item['current']:
                return False, f'{dimension_id} current content cannot change without applying'
            elif old_item is None:
                return False, f'{dimension_id} requires an initial content snapshot'
    seen_cycle_ids = set()
    for key, cycles in new['cycles'].items():
        if not isinstance(cycles, list):
            return False, 'Invalid research cycles'
        parts = key.split('|', 1)
        if len(parts) != 2 or parts[0] not in ids or parts[1] not in {f'DIM-{i:02d}' for i in range(1, 13)}:
            return False, 'Invalid research cycle owner'
        prior = {c['id']: c for c in old['cycles'].get(key, [])}
        for cycle in cycles:
            if not isinstance(cycle, dict) or not isinstance(cycle.get('id'), str):
                return False, 'Invalid research cycle'
            if cycle['id'] in seen_cycle_ids or cycle.get('projectId') != parts[0] or cycle.get('dimensionId') != parts[1]:
                return False, 'Duplicate or mismatched research cycle'
            seen_cycle_ids.add(cycle['id'])
            old_cycle = prior.get(cycle['id'])
            if old_cycle:
                if cycle.get('taskVersions', []) != old_cycle.get('taskVersions', []):
                    return False, 'Official task versions are server-managed'
                if old_cycle.get('locked') and not cycle.get('locked'):
                    return False, 'GPT task lock cannot be removed'
            elif cycle.get('taskVersions'):
                return False, 'New cycles cannot contain official task versions'
        if key.split('|', 1)[0] in ids and len(cycles) < len(old['cycles'].get(key, [])):
            return False, 'Research cycle history cannot be removed'
    return True, ''


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def safe_local_request(self, mutation=False):
        port = self.server.server_port
        if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
            self.send_json(403, {'error': 'Invalid local host'})
            return False
        if mutation:
            origin = self.headers.get('Origin')
            if origin and origin not in (f'http://127.0.0.1:{port}', f'http://localhost:{port}'):
                self.send_json(403, {'error': 'Invalid origin'})
                return False
            if self.headers.get('X-BG-Token') != CSRF_TOKEN:
                self.send_json(403, {'error': 'Invalid local session token'})
                return False
        return True

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        if length < 1 or length > 50_000_000:
            raise Round1Error('请求内容过大或为空', 413)
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        if not self.safe_local_request():
            return
        path = urlparse(self.path).path
        if path == '/api/planning-dashboard/contract':
            self.send_json(200, dashboard_contract())
            return
        if path == '/api/planning-dashboard':
            try:
                with LOCK, connect() as db:
                    value = query_dashboard(db, LEDGER, urlparse(self.path).query)
                self.send_json(200, value)
            except LedgerError as exc:
                self.send_json(exc.status, {'code': exc.code, 'error': str(exc)})
            except sqlite3.Error:
                self.send_json(503, {'code': 'DASHBOARD_STORAGE_UNAVAILABLE', 'error': '统计存储暂不可用，请重试。'})
            except (ValueError, TypeError, KeyError):
                self.send_json(503, {'code': 'DASHBOARD_DATA_UNAVAILABLE', 'error': '统计数据无法可靠读取，未返回替代数字。'})
            return
        if path.startswith('/api/planning-dashboard/'):
            self.send_json(404, {'code': 'ENDPOINT_NOT_FOUND', 'error': '看板接口不存在。'})
            return
        if path == '/api/state':
            try:
                rev, state = get_state()
            except LedgerError as exc:
                self.send_json(exc.status, {'code': exc.code, 'error': str(exc)})
                return
            except sqlite3.Error:
                self.send_json(503, {'code': 'PROJECT_STORAGE_UNAVAILABLE', 'error': '项目存储暂不可用。'})
                return
            self.send_json(200, {'revision': rev, 'state': state})
            return
        if path == '/api/session':
            self.send_json(200, {'csrfToken': CSRF_TOKEN})
            return
        if path == '/api/health':
            self.send_json(200, {'storage': 'sqlite', 'workbuddy_api': 'configured' if os.getenv('WORKBUDDY_ACCESS_TOKEN') else 'not_configured', 'round1': 'DIM-01 manual handoff available'})
            return
        if path == '/dimension-assets/template-baseline.json':
            payload = (ROOT / 'dimension-assets' / 'template-baseline.json').read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(payload)
            return
        if path == '/dimension-assets/platform-shell.css':
            payload = (ROOT / 'dimension-assets' / 'platform-shell.css').read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/css; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)
            return
        if path in ('/dimension-assets/theme-a.css', '/dimension-assets/theme-a-chrome.css'):
            payload = (ROOT / 'dimension-assets' / path.rsplit('/', 1)[-1]).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/css; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(payload)
            return
        if path in ('/dimension-assets/dim01-core.html', '/dimension-assets/dim01-v7.html'):
            source = DIM01_CORE if path.endswith('dim01-core.html') else DIM01_CORE.with_name('dim01-v7.html')
            payload = source.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == '/dimension-assets/dim02-core.html':
            payload = DIM02_CORE.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == '/dimension-assets/dim02-workmode.js':
            payload = DIM02_WORKMODE.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)
            return
        if path in ('/dimension-assets/dim03-core.html', '/dimension-assets/dim03-core.js', '/dimension-assets/dim03-seed.json'):
            source, mime = {
                '/dimension-assets/dim03-core.html': (DIM03_CORE, 'text/html; charset=utf-8'),
                '/dimension-assets/dim03-core.js': (DIM03_SCRIPT, 'text/javascript; charset=utf-8'),
                '/dimension-assets/dim03-seed.json': (DIM03_SEED, 'application/json; charset=utf-8'),
            }[path]
            payload = source.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)
            return
        if path in ('/dimension-assets/dim04-core.html', '/dimension-assets/dim04-legacy.html', '/dimension-assets/dim04-core.js', '/dimension-assets/dim04-seed.json'):
            source, mime = {
                '/dimension-assets/dim04-core.html': (DIM04_CORE, 'text/html; charset=utf-8'),
                '/dimension-assets/dim04-legacy.html': (DIM04_CORE.with_name('dim04-legacy.html'), 'text/html; charset=utf-8'),
                '/dimension-assets/dim04-core.js': (DIM04_SCRIPT, 'text/javascript; charset=utf-8'),
                '/dimension-assets/dim04-seed.json': (DIM04_SEED, 'application/json; charset=utf-8'),
            }[path]
            payload = source.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)
            return
        if path in ('/dimension-assets/dim-multi-core.html', '/dimension-assets/dim06-core.html', '/dimension-assets/dim-multi-core.js', '/dimension-assets/dim-multi-platform.js',
                    '/dimension-assets/dim-bid-core.html', '/dimension-assets/dim-bid-core.js',
                    '/dimension-assets/dim-final-core.html', '/dimension-assets/dim-final-core.js',
                    '/dimension-assets/dim05-seed.json', '/dimension-assets/dim06-seed.json', '/dimension-assets/dim07-seed.json',
                    '/dimension-assets/dim08-seed.json', '/dimension-assets/dim09-seed.json', '/dimension-assets/dim10-seed.json',
                    '/dimension-assets/dim11-seed.json', '/dimension-assets/dim12-seed.json'):
            sources = {
                '/dimension-assets/dim-multi-core.html': (DIM_MULTI_CORE, 'text/html; charset=utf-8'),
                '/dimension-assets/dim06-core.html': (DIM06_CORE, 'text/html; charset=utf-8'),
                '/dimension-assets/dim-multi-core.js': (DIM_MULTI_SCRIPT, 'text/javascript; charset=utf-8'),
                '/dimension-assets/dim-multi-platform.js': (DIM_MULTI_PLATFORM, 'text/javascript; charset=utf-8'),
                '/dimension-assets/dim-bid-core.html': (DIM_BID_CORE, 'text/html; charset=utf-8'),
                '/dimension-assets/dim-bid-core.js': (DIM_BID_SCRIPT, 'text/javascript; charset=utf-8'),
                '/dimension-assets/dim-final-core.html': (DIM_FINAL_CORE, 'text/html; charset=utf-8'),
                '/dimension-assets/dim-final-core.js': (DIM_FINAL_SCRIPT, 'text/javascript; charset=utf-8'),
                **{f'/dimension-assets/dim{number:02d}-seed.json': (DIM_MULTI_SEEDS[f'DIM-{number:02d}'], 'application/json; charset=utf-8') for number in range(5, 13)},
            }
            source, mime = sources[path]
            payload = source.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)
            return
        if path == '/api/workbuddy/round1/status':
            try:
                params = parse_qs(urlparse(self.path).query)
                self.send_json(200, ROUND1.status(run_id=params.get('runId', [None])[0],
                    cycle_id=params.get('cycleId', [None])[0],
                    project_id=params.get('projectId', [None])[0],
                    dimension_id=params.get('dimensionId', [None])[0]))
            except Round1Error as exc:
                self.send_json(exc.status, {'error': str(exc)})
            return
        if path not in ('/', '/index.html'):
            self.send_error(404)
            return
        try:
            rev, state = get_state()
        except (LedgerError, sqlite3.Error):
            self.send_json(503, {'code': 'PROJECT_STORAGE_UNAVAILABLE', 'error': '项目存储或事件配置暂不可用。'})
            return
        boot = json.dumps({'revision': rev, 'state': state, 'csrfToken': CSRF_TOKEN}, ensure_ascii=False).replace('<', '\\u003c')
        html = INDEX.read_text(encoding='utf-8').replace('/*__BOOT__*/', 'window.__BOOT__=' + boot + ';')
        data = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        if not self.safe_local_request(mutation=True):
            return
        if urlparse(self.path).path.startswith('/api/planning-dashboard'):
            self.send_json(405, {'code': 'METHOD_NOT_ALLOWED', 'error': '看板统计接口只读。'})
            return
        if urlparse(self.path).path != '/api/state':
            self.send_error(404)
            return
        try:
            payload = self.read_json()
            expected, new_state = payload['revision'], payload['state']
            with LOCK, connect() as db:
                result = LEDGER.save(db, expected, new_state, valid_state, self.headers.get('X-Idempotency-Key'))
            self.send_json(200, result)
        except LedgerError as exc:
            self.send_json(exc.status, {'code': exc.code, 'error': str(exc)})
        except sqlite3.Error:
            self.send_json(503, {'code': 'PROJECT_SAVE_UNAVAILABLE', 'error': '项目未可靠保存，未报告成功。请重试或核对存储。'})
        except Round1Error as exc:
            self.send_json(exc.status, {'error': str(exc)})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(400, {'error': str(exc)})

    def do_POST(self):
        if not self.safe_local_request(mutation=True):
            return
        path = urlparse(self.path).path
        if path == '/api/research/internal/import':
            expected = os.getenv('BG_INTEGRATION_KEY', '')
            if not expected or not hmac.compare_digest(self.headers.get('X-Research-Sync', ''), expected):
                self.send_json(403, {'code': 'RESEARCH_SERVICE_FORBIDDEN', 'error': '仅接受平台验证后的研究成果。'})
                return
            try:
                payload = self.read_json()
                with LOCK, connect() as db:
                    result = import_working(db, LEDGER, payload, valid_state)
                self.send_json(200, result)
            except LedgerError as exc:
                self.send_json(exc.status, {'code': exc.code, 'error': str(exc)})
            except sqlite3.Error:
                self.send_json(503, {'code': 'RESEARCH_IMPORT_UNCONFIRMED', 'error': '同步未可靠确认，请核对后重试同一任务版本。'})
            except (ValueError, KeyError, TypeError):
                self.send_json(422, {'code': 'INVALID_RESEARCH_IMPORT', 'error': '研究成果或同步请求格式无效。'})
            return
        if path.startswith('/api/planning-dashboard'):
            self.send_json(405, {'code': 'METHOD_NOT_ALLOWED', 'error': '看板统计接口只读。'})
            return
        if not path.startswith('/api/workbuddy/round1/'):
            self.send_error(404)
            return
        try:
            payload = self.read_json()
            if path.endswith('/prepare'):
                result = ROUND1.prepare(payload['projectId'], payload['dimensionId'], payload['cycleId'], bool(payload.get('replan')))
            elif path.endswith('/check'):
                result = ROUND1.check(payload['runId'])
            elif path.endswith('/evidence'):
                result = ROUND1.evidence(payload['runId'], payload.get('note'))
            elif path.endswith('/promote'):
                result = ROUND1.promote(payload['runId'])
            elif path.endswith('/send'):
                result = ROUND1.send(payload['runId'])
            elif path.endswith('/poll'):
                result = ROUND1.poll(payload['runId'])
            else:
                self.send_error(404)
                return
            self.send_json(200, result)
        except Round1Error as exc:
            self.send_json(exc.status, {'error': str(exc)})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(400, {'error': str(exc)})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='企划设计BG本地平台')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    connect().close()
    ROUND1.db().close()
    ROUND1.recover_interrupted_sends()
    with ThreadingHTTPServer(('127.0.0.1', args.port), Handler) as server:
        print(f'企划设计BG平台: http://127.0.0.1:{args.port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
