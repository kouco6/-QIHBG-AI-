"""密码哈希、会话令牌与安全工具（T03）。

设计要点（DESIGN §5/§7）：
- 密码哈希使用 ``bcrypt(sha256(password))``：先做 SHA-256 摘要再做 bcrypt，
  规避 bcrypt 72 字节截断；哈希串自带算法前缀 ``bcrypt_sha256$``，便于后续升级。
- 会话令牌只在客户端 Cookie 中以明文存在；服务端仅保存 SHA-256 摘要，不可反推。
- 登录失败不区分「账号不存在」与「密码错误」，避免暴露账号存在性。
- 密钥一律来自环境变量，本模块不读取也不持久化任何明文凭证。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import uuid

import bcrypt

# --- 密码 ---

PASSWORD_ALGO = "bcrypt_sha256"
_BCRYPT_ROUNDS = 12
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128


def _prehash(plain: str) -> bytes:
    """SHA-256 摘要后 Base64，得到与 bcrypt 兼容的定长输入。"""
    digest = hashlib.sha256(plain.encode("utf-8")).digest()
    return base64.b64encode(digest)


def hash_password(plain: str) -> str:
    """生成 ``bcrypt_sha256$<bcrypt-hash>`` 形式的哈希串。"""
    raw = bcrypt.hashpw(_prehash(plain), bcrypt.gensalt(rounds=_BCRYPT_ROUNDS))
    return f"{PASSWORD_ALGO}${raw.decode('ascii')}"


def verify_password(plain: str, stored: str | None) -> bool:
    """校验密码；任何异常或格式不符均返回 False（不抛错、不泄漏差异）。"""
    if not stored or not plain:
        return False
    algo, _, raw = stored.partition("$")
    if algo != PASSWORD_ALGO or not raw:
        return False
    try:
        return bcrypt.checkpw(_prehash(plain), raw.encode("ascii"))
    except (ValueError, TypeError):
        return False


def validate_password_strength(plain: str) -> list[str]:
    """返回不满足项的中文说明；空列表表示通过。"""
    problems: list[str] = []
    if len(plain) < MIN_PASSWORD_LENGTH:
        problems.append(f"密码至少 {MIN_PASSWORD_LENGTH} 位")
    if len(plain) > MAX_PASSWORD_LENGTH:
        problems.append(f"密码最长 {MAX_PASSWORD_LENGTH} 位")
    if plain.strip() != plain:
        problems.append("密码首尾不能包含空格")
    if plain.isdigit() or plain.isalpha():
        problems.append("密码需同时包含字母与数字")
    return problems


# --- 会话令牌 ---

SESSION_TOKEN_BYTES = 32


def new_session_token() -> str:
    """生成不可预测的会话令牌（明文仅回传客户端一次）。"""
    return secrets.token_urlsafe(SESSION_TOKEN_BYTES)


def token_digest(token: str) -> str:
    """会话令牌摘要，入库字段只保存该值。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


# --- 标识符 ---


def new_id() -> str:
    """业务主键（UUID4 字符串），避免依赖数据库自增以便未来迁移。"""
    return str(uuid.uuid4())
