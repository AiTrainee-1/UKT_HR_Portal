"""The Super Admin's login comes from the backend .env (owner 2026-11-10: "the .env file is the single source of truth for
Super Admin credentials").

`ADMIN_USERNAME` / `ADMIN_PASSWORD` (config/settings.py, from .env locally or the Railway Variables in production) are
compared with the Super Admin row of `hr_users` every time the backend starts (ApiConfig._bootstrap_admin_account), and the
database is brought in line when they differ - never the other way round:

  * no Super Admin yet       -> the HR user with that username becomes it, or a new one is created (as before);
  * a Super Admin exists     -> its username is set to ADMIN_USERNAME and its password to ADMIN_PASSWORD when they
                                differ (the password is compared with bcrypt, so it is never stored or logged in clear),
                                and the account is switched back on if it was off; when everything matches nothing is
                                written at all.

Only the Super Admin is ever touched; every other HR user keeps its own login. Blank values in .env change nothing (the
database stays as it is). If ADMIN_USERNAME already belongs to ANOTHER HR user, the Super Admin keeps its current username
(two accounts cannot share one) and the problem is logged; its password is still synchronised.

The login itself (auth_views.hr_login) is unchanged: it checks the typed username and password against `hr_users`, so the
synchronised credentials work as soon as the backend has started.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import bcrypt
from django.db import transaction

logger = logging.getLogger(__name__)

CREATED = "created"
PROMOTED = "promoted"
UPDATED = "updated"
UNCHANGED = "unchanged"


@dataclass
class SyncResult:
    outcome: str  # created | promoted | updated | unchanged
    changed: list[str] = field(default_factory=list)  # "username", "password", "active"
    username_conflict: bool = False


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def password_matches(password: str, password_hash: str) -> bool:
    """Is `password` the one behind this stored bcrypt hash? A hash that is not a bcrypt hash at all never matches."""
    try:
        return bcrypt.checkpw(password.encode(), (password_hash or "").encode())
    except ValueError:
        return False


def _audit(admin_id: int, description: str, old: dict | None, new: dict | None) -> None:
    """One row in the activity log (never the password itself). Best effort: a log failure never stops the sync."""
    try:
        from .models import AuditLog

        AuditLog.objects.create(
            user_type="system",
            user_name="system (.env)",
            action="update",
            module="user_management",
            record_id=admin_id,
            record_description=description,
            old_values=old,
            new_values=new,
        )
    except Exception:
        logger.warning("Could not write the activity log for the Super Admin sync", exc_info=True)


def sync_super_admin(username: str, password: str) -> SyncResult | None:
    """Make the Super Admin's login equal to `username` / `password` (the .env values). None when either is blank."""
    from .models import HRUser

    username = (username or "").strip()
    if not username or not password:
        return None

    with transaction.atomic():
        admins = list(HRUser.objects.select_for_update().filter(is_super_admin=True).order_by("id"))

        if not admins:
            # The first start: the user with that username becomes the Super Admin, or a new one is made.
            existing = HRUser.objects.select_for_update().filter(username__iexact=username).first()
            if existing is not None:
                existing.username = username
                existing.password_hash = _hash(password)
                existing.is_super_admin = True
                existing.is_active = True
                existing.save(update_fields=["username", "password_hash", "is_super_admin", "is_active"])
                _audit(
                    existing.id, f"Made {username} the Super Admin from the backend .env", None, {"username": username}
                )
                logger.info("Super Admin set from ADMIN_USERNAME in .env: %s", username)
                return SyncResult(PROMOTED, ["username", "password", "active"])
            admin = HRUser.objects.create(
                username=username,
                full_name="Administrator",
                password_hash=_hash(password),
                is_super_admin=True,
            )
            _audit(admin.id, f"Created the Super Admin {username} from the backend .env", None, {"username": username})
            logger.info("Super Admin created from ADMIN_USERNAME in .env: %s", username)
            return SyncResult(CREATED, ["username", "password", "active"])

        # The Super Admin to keep in line: the one already carrying that username, else the first one made.
        admin = next((a for a in admins if a.username.lower() == username.lower()), admins[0])
        if len(admins) > 1:
            logger.warning(
                "%d Super Admin accounts exist; only %s is kept in line with the .env", len(admins), admin.username
            )

        result = SyncResult(UNCHANGED)
        fields: list[str] = []
        old_username = admin.username
        if admin.username != username:
            taken = HRUser.objects.filter(username__iexact=username).exclude(pk=admin.pk).exists()
            if taken:
                result.username_conflict = True
                logger.error(
                    "ADMIN_USERNAME %r in .env already belongs to another HR user: the Super Admin keeps the username %r. "
                    "Rename or remove that other user, then restart the backend.",
                    username,
                    admin.username,
                )
            else:
                admin.username = username
                fields.append("username")
                result.changed.append("username")
        if not password_matches(password, admin.password_hash):
            admin.password_hash = _hash(password)
            fields.append("password_hash")
            result.changed.append("password")
        if not admin.is_active:
            admin.is_active = True
            fields.append("is_active")
            result.changed.append("active")

        if not fields:
            return result
        admin.save(update_fields=fields)
        result.outcome = UPDATED
        what = ", ".join(result.changed)
        _audit(
            admin.id,
            f"Super Admin login updated from the backend .env ({what})",
            {"username": old_username} if "username" in result.changed else None,
            {"username": admin.username} if "username" in result.changed else None,
        )
        logger.info("Super Admin login synchronised from .env (%s)", what)
        return result


def env_controls_super_admin() -> bool:
    """True when ADMIN_USERNAME and ADMIN_PASSWORD are both set: the Super Admin's login is then the .env's to decide,
    and a username / password typed for that account anywhere else would be reset at the next start."""
    from django.conf import settings

    return bool(
        (getattr(settings, "ADMIN_USERNAME", "") or "").strip() and (getattr(settings, "ADMIN_PASSWORD", "") or "")
    )
