"""Shared exhibition catalog. XLSX ingestion uses only the Python standard library."""
import io
import json
import posixpath
import re
import secrets
import sqlite3
import zipfile
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET

PREFIX = '/platform/v2/exhibitions'
GROUPS = ('强相关', '推荐', '不相关')
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
FIELDS = ('name', 'industry', 'venue', 'city', 'reason', 'level', 'content',
          'area', 'visitors', 'exhibitorCount', 'exhibitors', 'website', 'source', 'sourceRow')


class ExhibitionError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def clean(value):
    return '' if value is None or str(value).strip() == '/' else str(value).strip()


def safe_url(value):
    value = clean(value)
    if not value:
        return ''
    if '://' not in value:
        if ':' in value and not re.match(r'^[^/:]+:\d+(?:/|$)', value):
            raise ExhibitionError('官网须为有效的 http 或 https 地址。')
        value = 'https://' + value
    try:
        parsed = urlsplit(value)
        parsed.port
    except ValueError:
        raise ExhibitionError('官网须为有效的 http 或 https 地址。')
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username
            or parsed.password or any(c.isspace() or ord(c) < 32 for c in value)
            or any(c in value for c in '<>"\\')):
        raise ExhibitionError('官网须为有效的 http 或 https 地址。')
    return value


def validate(raw):
    if not isinstance(raw, dict):
        raise ExhibitionError('展会内容须为对象。')
    result = {}
    for key in FIELDS:
        value = raw.get(key, '')
        if not isinstance(value, str) or len(value) > (16000 if key == 'content' else 2000):
            raise ExhibitionError('字段内容无效或过长：' + key)
        result[key] = clean(value)
    if not result['name'] or len(result['name']) > 300:
        raise ExhibitionError('请填写 1–300 字的展会名称。')
    if not result['venue']:
        raise ExhibitionError('请填写展馆。')
    result['group'] = raw.get('group', '推荐')
    if result['group'] not in GROUPS:
        raise ExhibitionError('请选择强相关、推荐或不相关。')
    result['rating'] = raw.get('rating')
    if result['rating'] is not None and (type(result['rating']) is not int or not 1 <= result['rating'] <= 5):
        raise ExhibitionError('推荐度须为 1–5 星或未填写。')
    result['schedule'] = raw.get('schedule', 'scheduled')
    if result['schedule'] not in ('scheduled', 'postponed', 'cancelled', 'tbd'):
        raise ExhibitionError('展期状态无效。')
    start, end = raw.get('startDate', ''), raw.get('endDate', '')
    if not isinstance(start, str) or not isinstance(end, str):
        raise ExhibitionError('日期格式无效。')
    if start or end:
        try:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', start) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', end):
                raise ValueError()
            if date.fromisoformat(end) < date.fromisoformat(start):
                raise ValueError()
        except ValueError:
            raise ExhibitionError('请填写完整且有效的起止日期，结束日期不得早于开始日期。')
    elif result['schedule'] not in ('tbd', 'postponed', 'cancelled'):
        raise ExhibitionError('请填写展期，或标记为日期待定。')
    result['startDate'], result['endDate'] = start, end
    if result['schedule'] == 'tbd' and (start or end):
        raise ExhibitionError('日期待定时请清空展期。')
    tags = raw.get('topicIds', [])
    if not isinstance(tags, list) or len(tags) > 30 or any(not isinstance(t, str) for t in tags):
        raise ExhibitionError('专题标签无效。')
    result['topicIds'] = list(dict.fromkeys(tags))
    result['website'] = safe_url(result['website'])
    return result


def warnings_for(item):
    years = re.findall(r'(?<!\d)(20\d{2})(?!\d)', item['name'])
    if item['startDate'] and years and item['startDate'][:4] not in years:
        return ['展会名称中的年份与展期不一致，请核对。']
    return []


def signature(item):
    return json.dumps([item[key].strip().casefold() for key in
                       ('name', 'startDate', 'endDate', 'venue')], ensure_ascii=False)


class Exhibitions:
    def __init__(self, data_dir):
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / 'exhibitions.sqlite3'
        with self.db() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS exhibition (
                    id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
                    signature TEXT NOT NULL UNIQUE, data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS exhibition_topic (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    revision INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS exhibition_maintainer (account TEXT PRIMARY KEY);
            """)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def can_manage(self, account):
        if account['role'] == 'admin':
            return True
        with self.db() as db:
            return bool(db.execute('SELECT 1 FROM exhibition_maintainer WHERE account=?',
                                   (account['id'],)).fetchone())

    def listing(self, account):
        with self.db() as db:
            items = [{**json.loads(r['data']), 'id': r['id'], 'revision': r['revision']}
                     for r in db.execute('SELECT * FROM exhibition ORDER BY id')]
            topics = [dict(r) for r in db.execute('SELECT * FROM exhibition_topic ORDER BY name')]
        return {'items': items, 'topics': topics, 'canManage': self.can_manage(account),
                'isAdmin': account['role'] == 'admin'}

    @staticmethod
    def check_topics(db, item):
        actual = {r[0] for r in db.execute('SELECT id FROM exhibition_topic')}
        if not set(item['topicIds']) <= actual:
            raise ExhibitionError('专题已变更，请刷新后重新选择。', 409)

    @staticmethod
    def stamp(item, account, archived=False):
        return {**item, 'archived': archived,
                'updatedAt': datetime.now(timezone.utc).isoformat(),
                'updatedBy': account['name'], 'warnings': warnings_for(item)}

    def save(self, raw, account, record_id=None, revision=None):
        item = validate(raw)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            self.check_topics(db, item)
            archived = False
            if record_id:
                prior = db.execute('SELECT * FROM exhibition WHERE id=?', (record_id,)).fetchone()
                if not prior:
                    raise ExhibitionError('展会不存在。', 404)
                if type(revision) is not int or prior['revision'] != revision:
                    raise ExhibitionError('其他人员已更新该展会，请关闭编辑并刷新后重试。', 409)
                archived = json.loads(prior['data']).get('archived', False)
            item = self.stamp(item, account, archived)
            try:
                if record_id:
                    db.execute('UPDATE exhibition SET data=?,signature=?,revision=revision+1 WHERE id=?',
                               (json.dumps(item, ensure_ascii=False), signature(item), record_id))
                else:
                    record_id = secrets.token_hex(16)
                    db.execute('INSERT INTO exhibition VALUES (?,1,?,?)',
                               (record_id, signature(item), json.dumps(item, ensure_ascii=False)))
            except sqlite3.IntegrityError:
                raise ExhibitionError('相同名称、展期和展馆的展会已经存在（包含已归档记录）。', 409)
        return {'id': record_id}

    def archive(self, record_id, revision, archived, account):
        if type(archived) is not bool:
            raise ExhibitionError('归档状态无效。')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            prior = db.execute('SELECT * FROM exhibition WHERE id=?', (record_id,)).fetchone()
            if not prior:
                raise ExhibitionError('展会不存在。', 404)
            if type(revision) is not int or revision != prior['revision']:
                raise ExhibitionError('展会已被更新，请刷新后重试。', 409)
            item = self.stamp(json.loads(prior['data']), account, archived)
            db.execute('UPDATE exhibition SET revision=revision+1,data=? WHERE id=?',
                       (json.dumps(item, ensure_ascii=False), record_id))
        return {'id': record_id}

    def topic(self, raw, account):
        action, topic_id = raw.get('action'), raw.get('id')
        name = clean(raw.get('name'))
        if action not in ('create', 'rename', 'delete'):
            raise ExhibitionError('专题操作无效。')
        if action != 'delete' and (not name or len(name) > 40):
            raise ExhibitionError('专题名称须为 1–40 字。')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if action != 'create':
                old = db.execute('SELECT * FROM exhibition_topic WHERE id=?', (topic_id,)).fetchone()
                if not old:
                    raise ExhibitionError('专题已不存在，请刷新。', 409)
                if type(raw.get('revision')) is not int or old['revision'] != raw['revision']:
                    raise ExhibitionError('专题已被更新，请刷新后重试。', 409)
            try:
                if action == 'create':
                    existing = db.execute('SELECT id FROM exhibition_topic WHERE name=?', (name,)).fetchone()
                    topic_id = existing[0] if existing else secrets.token_hex(16)
                    if not existing:
                        db.execute('INSERT INTO exhibition_topic VALUES (?,?,1)', (topic_id, name))
                elif action == 'rename':
                    db.execute('UPDATE exhibition_topic SET name=?,revision=revision+1 WHERE id=?', (name, topic_id))
                else:
                    for row in db.execute('SELECT * FROM exhibition').fetchall():
                        item = json.loads(row['data'])
                        if topic_id in item['topicIds']:
                            item['topicIds'].remove(topic_id)
                            item = self.stamp(item, account, item['archived'])
                            db.execute('UPDATE exhibition SET revision=revision+1,data=? WHERE id=?',
                                       (json.dumps(item, ensure_ascii=False), row['id']))
                    db.execute('DELETE FROM exhibition_topic WHERE id=?', (topic_id,))
            except sqlite3.IntegrityError:
                raise ExhibitionError('已有同名专题。', 409)
        return {'id': topic_id}

    def maintainers(self):
        with self.db() as db:
            return [r[0] for r in db.execute('SELECT account FROM exhibition_maintainer')]

    def set_maintainers(self, ids):
        if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
            raise ExhibitionError('维护人员无效。')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM exhibition_maintainer')
            db.executemany('INSERT INTO exhibition_maintainer VALUES (?)', [(i,) for i in set(ids)])
        return {'status': 'ok'}

    def import_xlsx(self, payload, filename, account):
        records = read_xlsx(payload)
        result = {'added': 0, 'skipped': 0, 'failed': 0, 'errors': [], 'warnings': []}
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            for source, row_number, raw, topics, error in records:
                locator = source + ' 第 ' + str(row_number) + ' 行'
                try:
                    if error:
                        raise ExhibitionError(error)
                    raw['source'] = filename[:300]
                    raw['sourceRow'] = locator
                    item = validate(raw)
                    if db.execute('SELECT 1 FROM exhibition WHERE signature=?', (signature(item),)).fetchone():
                        result['skipped'] += 1
                        continue
                    for name in topics:
                        topic = db.execute('SELECT id FROM exhibition_topic WHERE name=?', (name,)).fetchone()
                        topic_id = topic[0] if topic else secrets.token_hex(16)
                        if not topic:
                            db.execute('INSERT INTO exhibition_topic VALUES (?,?,1)', (topic_id, name))
                        item['topicIds'].append(topic_id)
                    item = self.stamp(item, account)
                    db.execute('INSERT INTO exhibition VALUES (?,1,?,?)',
                               (secrets.token_hex(16), signature(item), json.dumps(item, ensure_ascii=False)))
                    result['added'] += 1
                    for warning in item['warnings']:
                        result['warnings'].append({'row': locator, 'message': warning})
                except ExhibitionError as exc:
                    result['failed'] += 1
                    result['errors'].append({'row': locator, 'message': str(exc)})
        return result


def xml_part(archive, name):
    data = archive.read(name)
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ExhibitionError('工作簿 XML 格式无效。')
    return ET.fromstring(data)


def relationships(archive, name):
    if name not in archive.namelist():
        return {}
    return {r.attrib['Id']: r.attrib for r in xml_part(archive, name)}


def date_range(value):
    numbers = [int(n) for n in re.findall(r'\d+', value)]
    if len(numbers) == 5:
        year, month, day, end_month, end_day = numbers
        return date(year, month, day).isoformat(), date(year + (end_month < month), end_month, end_day).isoformat()
    if len(numbers) == 6:
        return date(*numbers[:3]).isoformat(), date(*numbers[3:]).isoformat()
    if len(numbers) == 3:
        return (date(*numbers).isoformat(),) * 2
    raise ValueError('展会时间格式无法识别，请使用起止日期或“2026年11月01日—11月03日”。')


def read_xlsx(payload):
    """Read every compatible sheet, including merged categories and hyperlink targets."""
    if not payload or len(payload) > 10 * 1024 * 1024:
        raise ExhibitionError('请上传 10MB 以内的 .xlsx 文件。', 413)
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            infos = archive.infolist()
            if len(infos) > 3000 or sum(i.file_size for i in infos) > 64 * 1024 * 1024:
                raise ExhibitionError('工作簿解压内容过大。', 413)
            if len({i.filename for i in infos}) != len(infos):
                raise ExhibitionError('工作簿包含重复资源。')
            strings = []
            if 'xl/sharedStrings.xml' in archive.namelist():
                strings = [''.join(t.text or '' for t in n.findall('.//m:t', NS))
                           for n in xml_part(archive, 'xl/sharedStrings.xml')]
            workbook = xml_part(archive, 'xl/workbook.xml')
            epoch1904 = workbook.find('m:workbookPr', NS)
            epoch1904 = epoch1904 is not None and epoch1904.get('date1904') in ('1', 'true')
            rels = relationships(archive, 'xl/_rels/workbook.xml.rels')
            output = []
            for sheet in workbook.findall('m:sheets/m:sheet', NS):
                rel = rels[sheet.attrib[REL]]
                if rel.get('TargetMode') == 'External':
                    raise ExhibitionError('工作簿不支持外部工作表。')
                target = rel['Target']
                path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
                if not path.startswith('xl/'):
                    raise ExhibitionError('工作表路径无效。')
                root = xml_part(archive, path)
                link_rels = relationships(archive, posixpath.dirname(path) + '/_rels/' + posixpath.basename(path) + '.rels')
                links = {n.attrib['ref']: link_rels.get(n.attrib.get(REL), {}).get('Target', '')
                         for n in root.findall('m:hyperlinks/m:hyperlink', NS)}
                matrix = {}
                for row in root.findall('m:sheetData/m:row', NS):
                    row_number = int(row.attrib['r'])
                    cells = {}
                    for cell in row.findall('m:c', NS):
                        address = cell.attrib['r']
                        column = re.match(r'[A-Z]+', address).group()
                        value = cell.find('m:v', NS)
                        value = value.text if value is not None else ''
                        if cell.get('t') == 's':
                            value = strings[int(value)]
                        elif cell.get('t') == 'inlineStr':
                            value = ''.join(t.text or '' for t in cell.findall('.//m:t', NS))
                        cells[column] = (clean(value), links.get(address, ''), cell.find('m:f', NS) is not None)
                    matrix[row_number] = cells
                headers = None
                header_row = None
                for rn in sorted(matrix)[:12]:
                    h = {v[0]: k for k, v in matrix[rn].items()}
                    if {'展会名称', '展会展馆'} <= h.keys() and ('展会时间' in h or {'开始日期', '结束日期'} <= h.keys()):
                        headers, header_row = h, rn
                        break
                if not headers:
                    continue
                # Only propagate explicit merged category cells, never arbitrary empty rows.
                for merged in root.findall('m:mergeCells/m:mergeCell', NS):
                    match = re.fullmatch(r'([A-Z]+)(\d+):([A-Z]+)(\d+)', merged.get('ref', ''))
                    if match and match[1] == match[3] == headers.get('分类'):
                        value = matrix.get(int(match[2]), {}).get(match[1])
                        if value:
                            for rn in range(int(match[2]) + 1, min(int(match[4]) + 1, 20002)):
                                if rn in matrix:
                                    if not matrix[rn].get(match[1], ('', '', False))[0]:
                                        matrix[rn][match[1]] = value
                for rn, cells in sorted(matrix.items()):
                    if rn <= header_row:
                        continue
                    def field(label):
                        return cells.get(headers.get(label), ('', '', False))[0]
                    if not any(field(k) for k in ('展会名称', '展会展馆', '展会时间', '开始日期')):
                        continue
                    error = None
                    raw = {}
                    topics = []
                    try:
                        if any(c[2] for c in cells.values()):
                            raise ValueError('请将公式转换为值后导入。')
                        category = field('分类')
                        if category not in ('强相关展会', '强相关', '推荐展会', '推荐', '不相关展会', '不相关', 'AI机器人展会'):
                            raise ValueError('分类须为强相关、推荐、不相关或原表中的 AI机器人展会。')
                        raw = {'name': field('展会名称'), 'industry': field('展会分类'), 'venue': field('展会展馆'),
                               'group': '强相关' if category.startswith('强相关') else '不相关' if category.startswith('不相关') else '推荐',
                               'city': field('城市'), 'reason': field('推荐理由'), 'level': field('级别'),
                               'content': field('主要内容'), 'exhibitors': field('参展商'),
                               'rating': field('推荐度').count('★') or None, 'schedule': 'scheduled'}
                        if field('展会时间') in ('待定', '日期待定'):
                            raw.update(startDate='', endDate='', schedule='tbd')
                        elif '开始日期' in headers:
                            def excel_date(text):
                                if re.fullmatch(r'\d+(?:\.\d+)?', text):
                                    return ((datetime(1904, 1, 1) if epoch1904 else datetime(1899, 12, 30)) + timedelta(days=float(text))).date().isoformat()
                                return date.fromisoformat(text[:10]).isoformat()
                            raw['startDate'], raw['endDate'] = excel_date(field('开始日期')), excel_date(field('结束日期'))
                        else:
                            raw['startDate'], raw['endDate'] = date_range(field('展会时间'))
                        for key, label in [('area', '展览面积'), ('visitors', '参展观众'), ('exhibitorCount', '参展商')]:
                            matched = re.search(label + r'\s*[：:]\s*([^；;\n]+)', field('展会规模'))
                            raw[key] = clean(matched[1]) if matched else ''
                        website_cell = cells.get(headers.get('网站'), ('', '', False))
                        raw['website'] = website_cell[1] or website_cell[0]
                        if category == 'AI机器人展会':
                            topics.append('AI机器人')
                        topics += [t.strip() for t in re.split(r'[,，、;；]', field('专题标签')) if t.strip()]
                        topics = list(dict.fromkeys(topics))
                        if len(topics) > 30 or any(len(t) > 40 for t in topics):
                            raise ValueError('专题标签过多或名称超过 40 字。')
                    except (ValueError, TypeError, OverflowError) as exc:
                        error = str(exc)
                    output.append((sheet.attrib['name'], rn, raw, topics, error))
                    if len(output) > 5000:
                        raise ExhibitionError('单次最多导入 5000 条展会。', 413)
            if not output:
                raise ExhibitionError('未找到展会记录。请保留原表表头：分类、展会名称、展会时间、展会展馆等。')
            return output
    except ExhibitionError:
        raise
    except (zipfile.BadZipFile, ET.ParseError, KeyError, IndexError, ValueError, OverflowError, RuntimeError):
        raise ExhibitionError('无法读取工作簿，请上传有效的 .xlsx 文件。')
