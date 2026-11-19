"""Immutable, platform-wide frontend packages. Project schemas stay in BG's validators."""
import ast
import hashlib
import io
import json
import posixpath
import re
import shutil
import sqlite3
import stat
import tempfile
import threading
import zipfile
from datetime import datetime, timezone
from contextlib import contextmanager
from html.parser import HTMLParser
from urllib.parse import urlsplit
from pathlib import Path, PurePosixPath

PREFIX = '/platform/planning-templates'
LIMIT = 32 * 1024 * 1024
EXPANDED_LIMIT = 64 * 1024 * 1024
NAMES = ['产品线齐全', '行业应用场景', '证书资质全', '技术先进', '功能强', '性能稳', 'AI 智慧力', '成本优势', '控标能力强', '应标能力强', '外观高档大气', '体验感好']




def archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            # Stable bytes on Windows and macOS; the retained packages use Unix ZIP metadata.
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    return output.getvalue()


def validators(source):
    # Load only the existing pure validation functions, never execute the BG server or a package.
    tree = ast.parse((source / 'validators.py').read_text(encoding='utf-8'))
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name.startswith('valid_dim')]
    namespace = {'re': re, 'json': json, 'DIM_MULTI_SEEDS': {f'DIM-{i:02d}': source / 'seeds' / f'dim{i:02d}-seed.json' for i in range(5,13)}}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source / 'validators.py'), 'exec'), namespace)
    return namespace


class TemplateError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class ResourceReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {'script','img','source','video','audio','iframe'} and attrs.get('src'):
            self.paths.append(attrs['src'])
        if tag == 'link' and attrs.get('href'):
            self.paths.append(attrs['href'])


def validate_resources(files):
    for name, data in files.items():
        suffix = PurePosixPath(name).suffix
        paths = []
        if suffix == '.html':
            parser = ResourceReferences()
            parser.feed(data.decode('utf-8'))
            paths = parser.paths
        elif suffix == '.css':
            paths = re.findall(r'url\(\s*[\"\']?([^\"\')]+)', data.decode('utf-8'))
        for link in paths:
            if link.startswith(('data:','blob:','#')) or '${' in link:
                continue
            url = urlsplit(link)
            if url.scheme or url.netloc:
                raise TemplateError('模板页面资源须随包提供，不能依赖外部资源：' + name)
            path = url.path
            if path.startswith(('/dimension-assets/','/bg/dimension-assets/')):
                target = 'assets/' + path.split('dimension-assets/',1)[1]
            elif path.startswith('/'):
                raise TemplateError('模板资源须使用相对路径或/dimension-assets/：' + name)
            else:
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name),path))
            if target not in files:
                raise TemplateError('模板缺少引用资源：' + target)


class Templates:
    def __init__(self, data, source, initial_package=None):
        self.root = data / 'planning-templates'
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.source = source
        self.lock = threading.RLock()
        self.checks = validators(source)
        self.database = self.root / 'registry.sqlite3'
        with self.db() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS version (id TEXT PRIMARY KEY, version TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL, note TEXT NOT NULL, created TEXT NOT NULL, actor TEXT NOT NULL, manifest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS activation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), active TEXT NOT NULL, revision INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS event (created TEXT NOT NULL, actor TEXT NOT NULL, previous TEXT, active TEXT NOT NULL);''')
        self.database.chmod(0o600)
        with self.db() as db:
            initialized = db.execute('SELECT 1 FROM activation').fetchone()
        if not initialized:
            payload = initial_package() if initial_package else archive({p.relative_to(source.parents[1] / 'baseline').as_posix(): p.read_bytes() for p in (source.parents[1] / 'baseline').rglob('*') if p.is_file()})
            result = self.import_package(payload, '系统初始化')
            with self.db() as db:
                db.execute('INSERT OR IGNORE INTO activation VALUES (1, ?, 1)', (result['id'],))

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.database, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def _validate(self, payload):
        if len(payload) > LIMIT:
            raise TemplateError('模板包不能超过32MB。', 413)
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as z:
                entries = z.infolist()
                if not entries or len(entries) > 512 or sum(p.file_size for p in entries) > EXPANDED_LIMIT:
                    raise TemplateError('模板包展开后超过64MB或文件数超过512。')
                files = {}
                for item in entries:
                    # ZipInfo normalizes backslashes on Windows; validate the original archive name.
                    name = item.orig_filename
                    if (not re.fullmatch(r'[A-Za-z0-9_./-]+', name) or name.startswith('/') or
                            any(p in ('', '.', '..') for p in name.rstrip('/').split('/')) or
                            stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1):
                        raise TemplateError('模板包包含无效路径、链接或加密文件。')
                    if item.is_dir():
                        continue
                    if name in files or item.file_size > 8 * 1024 * 1024:
                        raise TemplateError('模板包含重名文件或单个文件超过8MB。')
                    suffix = PurePosixPath(name).suffix.lower()
                    if suffix not in {'.json','.html','.js','.css','.png','.jpg','.jpeg','.webp','.gif','.svg','.woff','.woff2'}:
                        raise TemplateError('模板包只允许前端资源和JSON文件。')
                    files[name] = z.read(item)
            manifest = json.loads(files['manifest.json'])
            if (manifest.get('format') != 'qihbg-planning-template' or manifest.get('formatVersion') != 1 or
                    manifest.get('dataProtocol') != 'bg-showcase-v1'):
                raise TemplateError('模板包格式或数据协议不兼容。')
            for key, maximum in [('version',60),('label',100),('note',2000)]:
                text = manifest.get(key, '')
                if not isinstance(text, str) or len(text) > maximum or (key != 'note' and not text.strip()):
                    raise TemplateError('请填写有效的模板版本号、名称及说明。')
            dims = manifest['dimensions']
            if not isinstance(dims, dict) or set(dims) != {f'DIM-{i:02d}' for i in range(1,13)}:
                raise TemplateError('必须一次提供完整12维模板。')
            for i in range(1,13):
                key = f'DIM-{i:02d}'
                rec = dims[key]
                if not isinstance(rec, dict) or rec.get('name') != NAMES[i-1]:
                    raise TemplateError(key + ' 名称与现有维度不一致。')
                for field in ('entry','sample', *(['legacyEntry'] if 'legacyEntry' in rec else [])):
                    path = rec[field]
                    if not isinstance(path, str) or path not in files or not path.startswith('assets/' if field != 'sample' else 'samples/') or not path.endswith('.json' if field == 'sample' else '.html'):
                        raise TemplateError(key + ' 入口、旧内容兼容入口或示例文件缺失。')
                sections = rec.get('sections', [])
                if not isinstance(sections, list) or len(sections) > 30 or any(not isinstance(row,list) or len(row)!=2 or any(not isinstance(x,str) or not x or len(x)>100 for x in row) for row in sections):
                    raise TemplateError(key + ' 章节定义无效。')
                sample = json.loads(files[rec['sample']])
                valid = self.checks[f'valid_dim{i:02d}_snapshot'](sample) if i <= 4 else self.checks['valid_dim_multi_snapshot'](key, sample)
                if not valid:
                    raise TemplateError(key + ' 示例不符合现行保存协议。')
            # Packages cannot replace the parent bridge or platform chrome.
            if any(not (name == 'manifest.json' or name.startswith(('assets/','samples/'))) for name in files):
                raise TemplateError('资源必须放在assets或samples目录内。')
            validate_resources(files)
            return manifest, files
        except TemplateError:
            raise
        except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, RuntimeError, RecursionError):
            raise TemplateError('无法读取模板包，请核对manifest及12维示例文件。') from None

    def import_package(self, payload, actor):
        manifest, files = self._validate(payload)
        digest = hashlib.sha256()
        for name, data in sorted(files.items()):
            digest.update(name.encode() + b'\0' + hashlib.sha256(data).digest())
        version_id = digest.hexdigest()
        with self.lock, self.db() as db:
            existing = db.execute('SELECT id FROM version WHERE version=?', (manifest['version'],)).fetchone()
            if existing:
                if existing['id'] == version_id:
                    return {'id':version_id, 'duplicate':True}
                raise TemplateError('该版本号已被使用，请修改manifest.version后重新打包。', 409)
            target = self.root / version_id
            staging = Path(tempfile.mkdtemp(prefix='.import-', dir=self.root))
            try:
                for name, content in files.items():
                    path = staging / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
                (staging / 'package.zip').write_bytes(payload)
                if target.exists():
                    shutil.rmtree(target)  # orphan from an interrupted import; never a registered version
                staging.rename(target)
                db.execute('INSERT INTO version VALUES (?,?,?,?,?,?,?)', (version_id, manifest['version'], manifest['label'], manifest.get('note',''), datetime.now(timezone.utc).isoformat(), actor, json.dumps(manifest,ensure_ascii=False)))
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        return {'id': version_id, 'duplicate':False}

    def listing(self):
        with self.db() as db:
            active = dict(db.execute('SELECT active, revision FROM activation WHERE singleton=1').fetchone())
            items = []
            for row in db.execute('SELECT * FROM version ORDER BY created DESC'):
                item = dict(row)
                item['dimensions'] = json.loads(item.pop('manifest'))['dimensions']
                items.append(item)
            return {**active, 'items':items}

    def apply(self, version_id, expected, actor):
        if not isinstance(version_id, str) or not re.fullmatch(r'[a-f0-9]{64}', version_id):
            raise TemplateError('模板版本无效。')
        with self.lock, self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM version WHERE id=?', (version_id,)).fetchone():
                raise TemplateError('模板版本不存在。',404)
            current = db.execute('SELECT * FROM activation WHERE singleton=1').fetchone()
            if type(expected) is not int or expected != current['revision']:
                raise TemplateError('其他管理员已切换模板，请刷新版本列表后重试。',409)
            if current['active'] != version_id:
                db.execute('UPDATE activation SET active=?, revision=revision+1 WHERE singleton=1', (version_id,))
                db.execute('INSERT INTO event VALUES (?,?,?,?)',(datetime.now(timezone.utc).isoformat(),actor,current['active'],version_id))
        return self.listing()

    def asset(self, version_id, name):
        if not re.fullmatch(r'[a-f0-9]{64}',version_id) or not re.fullmatch(r'[A-Za-z0-9_./-]+', name) or any(p in ('','.','..') for p in name.split('/')):
            raise TemplateError('资源地址无效。',404)
        with self.db() as db:
            if not db.execute('SELECT 1 FROM version WHERE id=?',(version_id,)).fetchone():
                raise TemplateError('模板版本不存在。',404)
        path = self.root / version_id / name
        if not path.is_file() or name != 'package.zip' and not name.startswith(('assets/','samples/')):
            raise TemplateError('模板资源不存在。',404)
        return path
