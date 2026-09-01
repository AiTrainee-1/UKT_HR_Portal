"""Branch-scoped Settings resolution.

Admin and super admins edit the universal PayrollSettings row (pk=1). Every
branch layers a private overlay on top: only the fields it changed are
stored, everything else keeps reading the universal value, so an Admin edit
propagates to every branch that has not overridden that field.

Overrides are keyed on BRANCH, not on the login. One branch can have several
credentials -different people, or just different ways in -and they must all
see and compute with the same numbers.

Resolution differs by purpose, and getting this wrong is a payroll bug:

  settings_for(request)     the Settings PAGE. Resolves from the logged-in
                            user's branch. An admin, or any login with no
                            branch, gets the universal row, so their save is
                            company-wide.

  settings_for_employee(e)  payroll and attendance. Resolves from the
                            EMPLOYEE's branch, so a run started from the
                            Admin page produces exactly what the branch
                            login would have produced. This is what makes
                            regeneration from either place agree.

  PayrollSettings.get()     untouched. Engine and background paths
                            (attendance_final, shift_engine, night_shift,
                            backup_scheduler) hold neither a request nor an
                            employee, and read universal values.

The overlay refuses save(). That is what stops one branch's private change
from silently becoming a company-wide one.
"""

from __future__ import annotations


class _SettingsOverlay:
    """The universal settings with one branch's overrides layered on top.

    Attribute access falls through to the universal row, so every existing
    `ps.pf_rate` / `ps.attendance_mode` call site works unchanged.
    """

    __slots__ = ("_base", "_overrides", "_branch_id")

    def __init__(self, base, overrides: dict, branch_id: int):
        object.__setattr__(self, "_base", base)
        object.__setattr__(self, "_overrides", overrides or {})
        object.__setattr__(self, "_branch_id", branch_id)

    def __getattr__(self, name):
        overrides = object.__getattribute__(self, "_overrides")
        if name in overrides:
            return _coerce(object.__getattribute__(self, "_base"), name, overrides[name])
        return getattr(object.__getattribute__(self, "_base"), name)

    def __setattr__(self, name, value):
        # Writes land in the override map, never on the shared row. This is
        # what lets the settings view keep its existing `ps.field = value`
        # assignments unchanged for admin and branch user alike.
        object.__getattribute__(self, "_overrides")[name] = value

    def save(self, *args, **kwargs):
        raise RuntimeError(
            "An overlay is not a database row -call persist_overlay() to store "
            "this branch's overrides, or edit PayrollSettings directly as admin."
        )

    @property
    def overrides(self) -> dict:
        return object.__getattribute__(self, "_overrides")

    @property
    def branch_id(self) -> int:
        return object.__getattribute__(self, "_branch_id")

    @property
    def base(self):
        return object.__getattribute__(self, "_base")


def _coerce(base, name, value):
    """Bring a JSON-round-tripped value back to the field's Python type.

    JSON has no Decimal, date or time, so a stored `pf_rate` comes back as a
    string or float and would break `basic * pf_rate` in the payroll maths.
    The field on the model is the authority on what the type should be.
    """
    from datetime import date, time
    from decimal import Decimal, InvalidOperation

    try:
        field = base._meta.get_field(name)
    except Exception:
        return value
    if value is None:
        return None

    internal = field.get_internal_type()
    try:
        if internal == "DecimalField" and not isinstance(value, Decimal):
            return Decimal(str(value))
        if internal in ("IntegerField", "SmallIntegerField", "BigIntegerField") and not isinstance(value, int):
            return int(value)
        if internal == "BooleanField":
            return bool(value)
        if internal == "TimeField" and isinstance(value, str):
            return time.fromisoformat(value)
        if internal == "DateField" and isinstance(value, str):
            return date.fromisoformat(value)
    except (ValueError, TypeError, InvalidOperation):
        # A corrupt stored value must not take payroll down -fall back to
        # the universal value, which is always a valid one.
        return getattr(base, name)
    return value


def is_universal_editor(hr_user) -> bool:
    """Whose Settings edits apply company-wide.

    Super admins, and any login with no branch, edit the universal row -
    there is no single branch their save could belong to. Everyone assigned a
    branch in Account Management edits that branch's overlay instead.
    """
    if hr_user is None:
        return True
    return bool(hr_user.is_super_admin or hr_user.branch_id is None)


def get_hr_user(request):
    """The requesting HR user, or None (employee token, or no token)."""
    from .models import HRUser

    user = getattr(request, "jwt_user", None) or {}
    hr_user_id = user.get("hrUserId")
    if not hr_user_id:
        return None
    return HRUser.objects.select_related("branch").filter(
        id=hr_user_id, is_active=True
    ).first()


def _overlay_for_branch(branch_id):
    """One branch's settings, or the universal row when there is no branch.

    ALWAYS an overlay when a branch is given, even with nothing stored yet.
    Returning the bare row as an optimisation looks harmless on the read path
    and is catastrophic on the write path: the settings view assigns onto
    whatever this returns and then saves it, so a branch's first-ever edit
    would go straight into the company row. The overlay makes that
    structurally impossible.
    """
    from .models import BranchSettingsOverride, PayrollSettings

    base = PayrollSettings.get()
    if branch_id is None:
        return base
    row = BranchSettingsOverride.objects.filter(branch_id=branch_id).first()
    return _SettingsOverlay(base, dict(row.overrides) if row else {}, branch_id)


def settings_for(request):
    """Settings as this request's user should see and edit them -the page.

    An admin, or any login without a branch, gets the real PayrollSettings
    row, so their save is universal. A branch login gets that branch's
    overlay, shared with every other login on the same branch.

    NOT for payroll or attendance: those must follow the employee's branch,
    not the operator's. Use settings_for_employee for that.
    """
    hr_user = get_hr_user(request)
    if is_universal_editor(hr_user):
        from .models import PayrollSettings
        return PayrollSettings.get()
    return _overlay_for_branch(hr_user.branch_id)


def settings_for_employee(emp):
    """Settings that govern this employee -used by payroll and attendance.

    Resolved from the employee's own branch, so the figures never depend on
    who is logged in. Generating from the Admin page and generating from the
    branch login produce identical numbers, and one Admin run spanning
    several branches applies each branch's own rates within that single run.

    An employee with no branch falls back to the universal row.
    """
    return _overlay_for_branch(getattr(emp, "branch_id", None))


def persist_overlay(overlay) -> dict:
    """Write an overlay's accumulated changes to that branch's override row.

    Only fields that actually DIFFER from the universal value are kept -so a
    branch that edits a field back to the company value stops overriding it
    and resumes tracking Admin's future changes, rather than freezing
    today's.
    """
    from .models import BranchSettingsOverride

    base = overlay.base
    kept = {}
    for name, value in overlay.overrides.items():
        try:
            universal = getattr(base, name)
        except AttributeError:
            continue
        if _normalise(_coerce(base, name, value)) != _normalise(universal):
            kept[name] = _jsonable(value)

    row, _ = BranchSettingsOverride.objects.get_or_create(branch_id=overlay.branch_id)
    row.overrides = kept
    row.save(update_fields=["overrides", "updated_at"])
    return kept


def _normalise(v):
    """Compare 12 and Decimal('12.00') as equal."""
    from decimal import Decimal

    if isinstance(v, Decimal):
        return v.normalize()
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return Decimal(str(v)).normalize()
    return v


def _jsonable(v):
    """Decimal / date / time are not JSON types -store them as strings."""
    from datetime import date, time
    from decimal import Decimal

    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (date, time)):
        return v.isoformat()
    return v
