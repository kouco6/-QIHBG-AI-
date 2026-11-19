"""Platform accounts, label-derived grants and revocable browser sessions.

The fixed operator is a development fixture, created once and forced to change
its initial password. Restarting never restores its password or privileges.
"""
import hashlib
import json
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager

MODULES = ("bg", "capabilities", "ai")
TAGS = {"体验": ("ai", "capabilities"), "企划": ("bg", "ai", "capabilities"),
        "产品": ("ai", "capabilities"), "UI": ("ai", "capabilities")}
FIXED_LOGIN = DEFAULT_LOGIN = "bg"
FIXED_NAME = DEFAULT_NAME = "BG"
FIXED_PASSWORD = "123"  # Development fixture only; blocked from modules until changed.
DEFAULT_SALT = secrets.token_hex(16)
DEFAULT_HASH = None
SESSION_AGE = 8 * 60 * 60
REMEMBER_AGE = 7 * 24 * 60 * 60


class Identity:
    def __init__(self, path):
        self.path = path
        with self.db() as db:
            db.executescript("""
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS account (
                    id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1, experience TEXT UNIQUE
                );
                CREATE TABLE IF NOT EXISTS grant_module (
                    account TEXT NOT NULL REFERENCES account(id), module TEXT NOT NULL,
                    PRIMARY KEY(account, module)
                );
                DROP INDEX IF EXISTS one_local_ai_owner;
                CREATE TABLE IF NOT EXISTS session (
                    digest TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES account(id),
                    expires INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS login_limit (
                    bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, until INTEGER NOT NULL
                );
            """)
            db.execute("BEGIN IMMEDIATE")
            columns = {r[1] for r in db.execute('PRAGMA table_info(account)')}
            migrating = 'role' not in columns
            for column, definition in [('role', "TEXT NOT NULL DEFAULT 'user'"),
                                       ('tags', "TEXT NOT NULL DEFAULT '[]'"),
                                       ('must_change_password', 'INTEGER NOT NULL DEFAULT 1')]:
                if column not in columns:
                    db.execute(f'ALTER TABLE account ADD COLUMN {column} {definition}')
            if migrating:
                first = db.execute('SELECT id FROM account ORDER BY active DESC, rowid LIMIT 1').fetchone()
                for row in db.execute('SELECT * FROM account').fetchall():
                    grants = {r[0] for r in db.execute('SELECT module FROM grant_module WHERE account=?', (row['id'],))}
                    tags = [t for t, module in [('体验', 'experience'), ('企划', 'bg')] if module in grants]
                    role = 'admin' if first and row['id'] == first['id'] else 'user'
                    db.execute('UPDATE account SET role=?, tags=?, active=? WHERE id=?',
                               (role, json.dumps(tags), int(bool(row['active']) and (role == 'admin' or bool(tags))), row['id']))
                    self._grants(db, row['id'], role, tags)
                db.execute('DELETE FROM session')
            # Reconcile persisted grants when a label's module policy changes.
            for row in db.execute('SELECT * FROM account').fetchall():
                tags = json.loads(row['tags'])
                expected = set(self.modules_for(row['role'], tags))
                stored = {r[0] for r in db.execute('SELECT module FROM grant_module WHERE account=?', (row['id'],))}
                if stored != expected:
                    self._grants(db, row['id'], row['role'], tags)
                    db.execute('DELETE FROM session WHERE account=?', (row['id'],))
        path.chmod(0o600)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def password_hash(password, salt):
        return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**15, r=8, p=1,
                              maxmem=64 * 1024 * 1024).hex()

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    @staticmethod
    def modules_for(role, tags):
        allowed = set(MODULES) if role == 'admin' else {m for tag in tags for m in TAGS[tag]}
        return [m for m in MODULES if m in allowed]

    @classmethod
    def _grants(cls, db, account, role, tags):
        db.execute('DELETE FROM grant_module WHERE account=?', (account,))
        db.executemany('INSERT INTO grant_module VALUES (?, ?)',
                       [(account, m) for m in cls.modules_for(role, tags)])

    @classmethod
    def public(cls, row):
        tags = json.loads(row['tags'])
        return {k: row[k] for k in ('id', 'login', 'name', 'role')} | {
            'active': bool(row['active']), 'tags': tags,
            'must_change_password': bool(row['must_change_password']),
            'modules': cls.modules_for(row['role'], tags)}

    @staticmethod
    def validate_password(password):
        if not isinstance(password, str) or not 8 <= len(password) <= 128:
            raise ValueError('密码须为 8–128 个字符。')

    @staticmethod
    def validate_profile(data):
        name, role, tags = data.get('name'), data.get('role'), data.get('tags')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64:
            raise ValueError('姓名须为 1–64 个字符。')
        if role not in ('admin', 'user'):
            raise ValueError('管理身份只能为管理员或普通用户。')
        if not isinstance(tags, list) or any(not isinstance(t, str) or t not in TAGS for t in tags):
            raise ValueError('岗位标签只能选择体验、企划、产品、UI。')
        tags = [t for t in TAGS if t in tags]
        if role == 'user' and not tags:
            raise ValueError('普通用户至少选择一个岗位标签。')
        active = data.get('active', True)
        if type(active) is not bool:
            raise ValueError('启停状态无效。')
        return name.strip(), role, tags, active

    def bootstrap(self, login, name, salt, password_hash, experience):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT 1 FROM account LIMIT 1').fetchone():
                return
            account = secrets.token_hex(16)
            db.execute('''INSERT INTO account
                (id,login,name,salt,password,active,experience,role,tags,must_change_password)
                VALUES (?,?,?,?,?,1,?,'admin','[]',1)''',
                       (account, login, name, salt, password_hash, experience))
            self._grants(db, account, 'admin', [])

    def ensure_fixed_operator(self, experience=None):
        # Only bootstrap an empty fixture; never resurrect/reset an existing user.
        salt = secrets.token_hex(16)
        self.bootstrap(FIXED_LOGIN, FIXED_NAME, salt,
                       self.password_hash(FIXED_PASSWORD, salt), experience)

    def _current_row(self, db, token):
        if not isinstance(token, str) or not token or len(token) > 64:
            return None
        return db.execute('''SELECT a.* FROM session s JOIN account a ON a.id=s.account
            WHERE s.digest=? AND s.expires>? AND a.active=1''', (self.digest(token), time.time())).fetchone()

    def current(self, token):
        with self.db() as db:
            row = self._current_row(db, token)
            return (self.public(row) | {'experience': row['experience']}) if row else None

    def _admin(self, db, token):
        row = self._current_row(db, token)
        if not row or row['role'] != 'admin' or row['must_change_password']:
            raise PermissionError('仅完成密码修改的管理员可管理人员。')
        return row

    def list_accounts(self, token):
        with self.db() as db:
            self._admin(db, token)
            return [self.public(row) for row in db.execute('SELECT * FROM account ORDER BY rowid')]

    def create_account(self, token, data, provision):
        if set(data) - {'login', 'name', 'role', 'tags', 'active', 'password'}:
            raise ValueError('包含不支持的账号字段。')
        name, role, tags, active = self.validate_profile(data)
        login = data.get('login')
        if not isinstance(login, str) or not re.fullmatch(r'[a-z0-9._-]{3,64}', login.strip().lower()):
            raise ValueError('账号须为 3–64 个字母、数字、点、连字符或下划线。')
        login = login.strip().lower()
        self.validate_password(data.get('password'))
        salt = secrets.token_hex(16)
        hashed = self.password_hash(data['password'], salt)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            self._admin(db, token)
            if db.execute('SELECT 1 FROM account WHERE login=?', (login,)).fetchone():
                raise ValueError('该登录账号已存在。')
            experience = provision(login, name, None)
            account = secrets.token_hex(16)
            db.execute('''INSERT INTO account
                (id,login,name,salt,password,active,experience,role,tags,must_change_password)
                VALUES (?,?,?,?,?,?,?,?,?,1)''',
                       (account, login, name, salt, hashed, int(active), experience, role, json.dumps(tags)))
            self._grants(db, account, role, tags)
            return self.public(db.execute('SELECT * FROM account WHERE id=?', (account,)).fetchone())

    def update_account(self, token, account_id, data, provision):
        if set(data) - {'name', 'role', 'tags', 'active'}:
            raise ValueError('登录账号不可修改；请仅修改姓名、标签、身份或状态。')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            actor = self._admin(db, token)
            row = db.execute('SELECT * FROM account WHERE id=?', (account_id,)).fetchone()
            if not row:
                raise LookupError('未找到账号。')
            profile = self.public(row) | data
            name, role, tags, active = self.validate_profile(profile)
            if actor['id'] == account_id and not active:
                raise ValueError('不能停用自己的账号。')
            if row['role'] == 'admin' and row['active'] and (role != 'admin' or not active):
                if db.execute("SELECT count(*) FROM account WHERE role='admin' AND active=1").fetchone()[0] <= 1:
                    raise ValueError('不能停用或降级最后一名启用中的管理员。')
            experience = row['experience']
            if name != row['name'] or not experience:
                experience = provision(row['login'], name, experience)
            db.execute('UPDATE account SET name=?,role=?,tags=?,active=?,experience=? WHERE id=?',
                       (name, role, json.dumps(tags), int(active), experience, account_id))
            self._grants(db, account_id, role, tags)
            if role != row['role'] or tags != json.loads(row['tags']) or active != bool(row['active']):
                db.execute('DELETE FROM session WHERE account=?', (account_id,))
            return self.public(db.execute('SELECT * FROM account WHERE id=?', (account_id,)).fetchone())

    def reset_password(self, token, account_id, password):
        self.validate_password(password)
        salt = secrets.token_hex(16)
        hashed = self.password_hash(password, salt)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            self._admin(db, token)
            if not db.execute('SELECT 1 FROM account WHERE id=?', (account_id,)).fetchone():
                raise LookupError('未找到账号。')
            db.execute('UPDATE account SET salt=?,password=?,must_change_password=1 WHERE id=?', (salt, hashed, account_id))
            db.execute('DELETE FROM session WHERE account=?', (account_id,))

    def change_password(self, token, old_password, password):
        self.validate_password(password)
        if not isinstance(old_password, str) or len(old_password) > 128:
            raise ValueError('请输入当前密码。')
        salt = secrets.token_hex(16)
        hashed = self.password_hash(password, salt)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = self._current_row(db, token)
            if not row:
                raise PermissionError('登录已失效。')
            if not secrets.compare_digest(row['password'], self.password_hash(old_password, row['salt'])):
                raise ValueError('当前密码不正确。')
            if secrets.compare_digest(row['password'], self.password_hash(password, row['salt'])):
                raise ValueError('新密码不能与当前密码相同。')
            db.execute('UPDATE account SET salt=?,password=?,must_change_password=0 WHERE id=?', (salt, hashed, row['id']))
            db.execute('DELETE FROM session WHERE account=?', (row['id'],))
        # Reauthenticate after changing; no session is kept across a credential change.

    def login(self, login, password, remember):
        now = int(time.time())
        login = login.strip().lower()[:64]
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM login_limit WHERE until <= ?', (now,))
            for bucket, maximum in (('account:' + login, 8), ('local', 40)):
                limit = db.execute('SELECT hits FROM login_limit WHERE bucket=?', (bucket,)).fetchone()
                if limit and limit['hits'] >= maximum:
                    return None, 429
            for bucket in ('account:' + login, 'local'):
                db.execute('''INSERT INTO login_limit VALUES (?,1,?) ON CONFLICT(bucket)
                    DO UPDATE SET hits=hits+1''', (bucket, now + 300))
            row = db.execute('SELECT * FROM account WHERE login=?', (login,)).fetchone()
        candidate = self.password_hash(password[:128], row['salt'] if row else '00' * 16)
        if not row or len(password) > 128 or not secrets.compare_digest(row['password'], candidate) or not row['active']:
            return None, 401
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT * FROM account WHERE id=?', (row['id'],)).fetchone()
            if not current or not current['active'] or current['password'] != row['password']:
                return None, 401
            db.execute('DELETE FROM login_limit WHERE bucket=?', ('account:' + login,))
            token = secrets.token_urlsafe(32)
            db.execute('INSERT INTO session VALUES (?,?,?)',
                       (self.digest(token), row['id'], now + (REMEMBER_AGE if remember else SESSION_AGE)))
        return token, 200

    def issue_session(self, account, remember=False):
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self.db() as db:
            db.execute('DELETE FROM session WHERE expires <= ?', (now,))
            created = db.execute('INSERT INTO session SELECT ?,id,? FROM account WHERE id=? AND active=1',
                                 (self.digest(token), now + (REMEMBER_AGE if remember else SESSION_AGE), account))
        return token if created.rowcount else None

    def logout(self, token):
        with self.db() as db:
            db.execute('DELETE FROM session WHERE digest=?', (self.digest(token),))

    def set_active(self, login, active):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM account WHERE login=?', (login.strip().lower(),)).fetchone()
            if not row:
                return False
            if not active and row['role'] == 'admin' and row['active']:
                if db.execute("SELECT count(*) FROM account WHERE role='admin' AND active=1").fetchone()[0] <= 1:
                    raise ValueError('不能停用最后一名启用中的管理员。')
            db.execute('UPDATE account SET active=? WHERE id=?', (int(active), row['id']))
            if not active:
                db.execute('DELETE FROM session WHERE account=?', (row['id'],))
            return True
