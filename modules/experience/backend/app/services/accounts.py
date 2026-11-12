"""账号与会话服务（T03）。

业务边界（DESIGN §6.1 / ACCT 验收）：
- **单一体验人员角色**：所有账号业务权限完全一致，账号仅用于操作溯源。
- **首账号**：数据库中创建的第一个账号；只有它可写系统设置。
- **首账号设置边界**：``/setup`` 仅在数据库中没有任何账号时可用，之后不可再次创建。
- 登录失败不区分账号不存在与密码错误；停用账号不可登录且既有会话立即失效。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, UnauthorizedError, ValidationError
from app.core.security import (
    new_id,
    new_session_token,
    token_digest,
    hash_password,
    validate_password_strength,
    verify_password,
)
from app.core.timeutil import to_naive_utc, utcnow
from app.models.account import ROLE_EXPERIENCE_MEMBER, Account, AuthSession

# 会话空闲续期阈值：超过该间隔访问则刷新 last_seen_at
_TOUCH_INTERVAL = _dt.timedelta(minutes=5)


# --- 首账号 ---


def count_accounts(db: Session) -> int:
    return int(db.execute(select(func.count()).select_from(Account)).scalar() or 0)


def needs_setup(db: Session) -> bool:
    """数据库是否处于「尚无账号、可创建首账号」状态。"""
    return count_accounts(db) == 0


def get_account_by_login(db: Session, account: str) -> Account | None:
    stmt = select(Account).where(func.lower(Account.account) == account.strip().lower())
    return db.execute(stmt).scalars().first()


def create_primary_account(db: Session, *, name: str, account: str, password: str) -> Account:
    """创建首账号；已有任何账号时拒绝（T03 验收：后续 /setup 不可再次创建）。"""
    if not needs_setup(db):
        raise ConflictError(
            "首账号已存在，初始化入口已关闭；如需新增账号请联系首账号在系统设置中操作。",
            code="setup_closed",
        )
    return _create_account(db, name=name, account=account, password=password, is_primary=True)


def create_account(
    db: Session, *, name: str, account: str, password: str, is_primary: bool = False
) -> Account:
    """新增普通体验人员账号（业务权限与首账号完全一致）。"""
    return _create_account(db, name=name, account=account, password=password, is_primary=is_primary)


def _create_account(db: Session, *, name: str, account: str, password: str, is_primary: bool) -> Account:
    account = account.strip()
    name = name.strip()

    problems: list[dict[str, str]] = []
    if not name:
        problems.append({"field": "name", "message": "请输入姓名", "type": "value_error"})
    if len(account) < 3:
        problems.append({"field": "account", "message": "账号至少 3 个字符", "type": "value_error"})
    if not account.replace(".", "").replace("_", "").replace("-", "").isalnum():
        problems.append(
            {"field": "account", "message": "账号仅支持字母、数字、点、下划线与连字符", "type": "value_error"}
        )
    problems.extend(
        {"field": "password", "message": msg, "type": "value_error"}
        for msg in validate_password_strength(password)
    )
    if problems:
        raise ValidationError("账号创建校验失败", field_errors=problems)

    if get_account_by_login(db, account) is not None:
        raise ConflictError("该账号已存在", code="account_exists", field_errors=[
            {"field": "account", "message": "该账号已存在", "type": "value_error"}
        ])

    now = utcnow()
    entity = Account(
        id=new_id(),
        account=account,
        name=name,
        role=ROLE_EXPERIENCE_MEMBER,
        password_hash=hash_password(password),
        is_primary=is_primary,
        is_active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(entity)
    db.commit()
    db.refresh(entity)
    return entity


# --- 会话 ---


def create_session(
    db: Session,
    account: Account,
    *,
    user_agent: str = "",
    ip_address: str = "",
    ttl_seconds: int | None = None,
) -> str:
    """为账号创建会话，返回**明文令牌**（仅此一次回传客户端）。"""
    token = new_session_token()
    now = utcnow()
    ttl = ttl_seconds or settings.session_max_age_seconds
    db.add(
        AuthSession(
            id=new_id(),
            account_id=account.id,
            token_hash=token_digest(token),
            created_at=now,
            last_seen_at=now,
            expires_at=now + _dt.timedelta(seconds=ttl),
            user_agent=user_agent[:255],
            ip_address=ip_address[:64],
        )
    )
    db.commit()
    return token


def authenticate(
    db: Session,
    *,
    account: str,
    password: str,
    user_agent: str = "",
    ip_address: str = "",
) -> tuple[Account, str]:
    """账号密码登录；失败统一抛 401 且不区分原因（不暴露账号存在性）。"""
    entity = get_account_by_login(db, account)
    if entity is None or not verify_password(password, entity.password_hash):
        raise UnauthorizedError("账号或密码不正确")
    if not entity.is_active:
        raise UnauthorizedError("账号已停用，请联系首账号处理", code="account_disabled")

    now = utcnow()
    entity.last_login_at = now
    entity.updated_at = now
    db.commit()

    token = create_session(db, entity, user_agent=user_agent, ip_address=ip_address)
    return entity, token


def resolve_session(db: Session, token: str | None) -> Account | None:
    """根据令牌解析账号；过期、被撤销或账号停用一律视为无效会话。"""
    if not token:
        return None
    stmt = select(AuthSession).where(AuthSession.token_hash == token_digest(token))
    session = db.execute(stmt).scalars().first()
    if session is None:
        return None
    if session.revoked_at is not None:
        return None

    now = utcnow()
    if to_naive_utc(session.expires_at) <= now:
        return None

    account = db.get(Account, session.account_id)
    if account is None or not account.is_active:
        return None

    if now - to_naive_utc(session.last_seen_at) > _TOUCH_INTERVAL:
        session.last_seen_at = now
        db.commit()
    return account


def revoke_session(db: Session, token: str | None) -> bool:
    """撤销当前会话（退出登录）。返回是否确实撤销了一条记录。"""
    if not token:
        return False
    stmt = select(AuthSession).where(AuthSession.token_hash == token_digest(token))
    session = db.execute(stmt).scalars().first()
    if session is None or session.revoked_at is not None:
        return False
    session.revoked_at = utcnow()
    db.commit()
    return True


def revoke_all_sessions(db: Session, account_id: str, *, keep_token: str | None = None) -> int:
    """撤销某账号的全部有效会话；可保留当前令牌（改密后调用）。"""
    keep_hash = token_digest(keep_token) if keep_token else None
    stmt = select(AuthSession).where(
        AuthSession.account_id == account_id, AuthSession.revoked_at.is_(None)
    )
    count = 0
    now = utcnow()
    for session in db.execute(stmt).scalars():
        if keep_hash and session.token_hash == keep_hash:
            continue
        session.revoked_at = now
        count += 1
    db.commit()
    return count


def list_sessions(db: Session, account_id: str, *, active_only: bool = True) -> list[AuthSession]:
    stmt = select(AuthSession).where(AuthSession.account_id == account_id)
    if active_only:
        stmt = stmt.where(
            AuthSession.revoked_at.is_(None), AuthSession.expires_at > utcnow()
        )
    stmt = stmt.order_by(AuthSession.created_at.desc())
    return list(db.execute(stmt).scalars())


def set_password(db: Session, account: Account, new_password: str) -> None:
    problems = validate_password_strength(new_password)
    if problems:
        raise ValidationError(
            "新密码不符合要求",
            field_errors=[
                {"field": "new_password", "message": msg, "type": "value_error"} for msg in problems
            ],
        )
    account.password_hash = hash_password(new_password)
    account.updated_at = utcnow()
    db.commit()


def set_active(db: Session, account: Account, *, is_active: bool) -> Account:
    """启停账号；停用时立即撤销其全部会话（T03：账号启停）。"""
    account.is_active = is_active
    account.updated_at = utcnow()
    if not is_active:
        revoke_all_sessions(db, account.id)
    else:
        db.commit()
    db.refresh(account)
    return account
