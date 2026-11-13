"""Credential-free identity implementation for isolated development fixtures only."""
"""Local platform accounts, module grants, and revocable browser sessions."""

import hashlib
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager


MODULES = ("bg", "ai", "experience")
FIXED_LOGIN = "bg"
FIXED_NAME = "BG"
FIXED_PASSWORD = "123"
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
        path.chmod(0o600)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=8)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
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

    def ensure_fixed_operator(self, experience=None):
        """Keep one local operator available after every fresh database."""
        salt = secrets.token_hex(16)
        digest = self.password_hash(FIXED_PASSWORD, salt)
        with self.db() as db:
            row = db.execute("SELECT id FROM account WHERE login=?", (FIXED_LOGIN,)).fetchone()
            if row:
                account = row["id"]
                db.execute("UPDATE account SET name=?, salt=?, password=?, active=1 WHERE id=?",
                           (FIXED_NAME, salt, digest, account))
                if experience:
                    db.execute("UPDATE account SET experience=? WHERE id=?", (experience, account))
            else:
                account = secrets.token_hex(16)
                db.execute("INSERT INTO account VALUES (?, ?, ?, ?, ?, 1, ?)",
                           (account, FIXED_LOGIN, FIXED_NAME, salt, digest, experience))
            db.execute("DELETE FROM grant_module WHERE account=?", (account,))
            db.executemany("INSERT INTO grant_module VALUES (?, ?)", [(account, module) for module in MODULES])
        return account

    def add(self, login, name, password, modules, experience=None):
        login = login.strip().lower()
        name = name.strip()
        if not re.fullmatch(r"[a-z0-9._-]{3,64}", login) or not 1 <= len(name) <= 80:
            raise ValueError("账号须为 3–64 个字母、数字、点、连字符或下划线。姓名不能为空。")
        if not 12 <= len(password) <= 128:
            raise ValueError("密码须为 12–128 个字符。")
        if "experience" in modules and not experience:
            raise ValueError("体验工作台需要绑定一个原版账号。")
        salt = secrets.token_hex(16)
        account = secrets.token_hex(16)
        with self.db() as db:
            db.execute("INSERT INTO account VALUES (?, ?, ?, ?, ?, 1, ?)",
                       (account, login, name, salt, self.password_hash(password, salt), experience))
            db.executemany("INSERT INTO grant_module VALUES (?, ?)", [(account, m) for m in modules])
        return account

    def login(self, login, password, remember):
        now = int(time.time())
        login = login.strip().lower()[:64]
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM login_limit WHERE until <= ?", (now,))
            for bucket, maximum in (("account:" + login, 8), ("local", 40)):
                limit = db.execute("SELECT hits FROM login_limit WHERE bucket = ?", (bucket,)).fetchone()
                if limit and limit["hits"] >= maximum:
                    return None, 429
            for bucket in ("account:" + login, "local"):
                db.execute("""INSERT INTO login_limit VALUES (?, 1, ?)
                              ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1""", (bucket, now + 300))
            row = db.execute("SELECT * FROM account WHERE login = ?", (login,)).fetchone()
        candidate = self.password_hash(password[:128], row["salt"] if row else "00" * 16)
        if not row or len(password) > 128 or not secrets.compare_digest(row["password"], candidate) or not row["active"]:
            return None, 401
        with self.db() as db:
            db.execute("DELETE FROM login_limit WHERE bucket = ?", ("account:" + login,))
        token = self.issue_session(row["id"], remember)
        return (token, 200) if token else (None, 401)

    def issue_session(self, account, remember=False):
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self.db() as db:
            db.execute("DELETE FROM session WHERE expires <= ?", (now,))
            created = db.execute("INSERT INTO session SELECT ?, id, ? FROM account WHERE id=? AND active=1",
                                 (self.digest(token), now + (REMEMBER_AGE if remember else SESSION_AGE), account))
        return token if created.rowcount else None

    def current(self, token):
        if not token or len(token) > 64:
            return None
        with self.db() as db:
            account = db.execute("""SELECT a.id, a.name, a.experience FROM session s
                JOIN account a ON a.id=s.account
                WHERE s.digest=? AND s.expires>? AND a.active=1""", (self.digest(token), time.time())).fetchone()
            if not account:
                return None
            grants = {r[0] for r in db.execute("SELECT module FROM grant_module WHERE account=?", (account["id"],))}
        return {**account, "modules": [m for m in MODULES if m in grants]}

    def logout(self, token):
        with self.db() as db:
            db.execute("DELETE FROM session WHERE digest = ?", (self.digest(token),))

    def set_active(self, login, active):
        with self.db() as db:
            row = db.execute("SELECT id FROM account WHERE login=?", (login.strip().lower(),)).fetchone()
            if not row:
                return False
            db.execute("UPDATE account SET active=? WHERE id=?", (int(active), row["id"]))
            if not active:
                db.execute("DELETE FROM session WHERE account=?", (row["id"],))
            return True

    def set_modules(self, login, modules):
        with self.db() as db:
            row = db.execute("SELECT id, experience FROM account WHERE login=?", (login.strip().lower(),)).fetchone()
            if not row:
                raise ValueError("未找到平台账号。")
            if "experience" in modules and not row["experience"]:
                raise ValueError("此账号未绑定体验工作台原账号。")
            db.execute("DELETE FROM grant_module WHERE account=?", (row["id"],))
            db.executemany("INSERT INTO grant_module VALUES (?, ?)", [(row["id"], module) for module in modules])
