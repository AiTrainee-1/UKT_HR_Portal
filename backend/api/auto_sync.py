"""
Auto Sync -configurable background biometric sync
=====================================================
Replaces the old hardcoded 07:30/20:30 APScheduler bootstrap in apps.py with
HR-editable AutoSyncRule rows. One CronTrigger job per enabled rule, keyed by
"auto_sync_rule_<id>" so CRUD operations can add/replace/remove jobs live —
no process restart needed.

apps.py starts the scheduler once at boot and loads every enabled rule via
load_all_rules_into_scheduler(); auto_sync_views.py calls
apply_rule_to_scheduler()/remove_rule_from_scheduler() on every create/update/
delete so a rule change takes effect immediately.
"""

import logging

from django.utils import timezone

logger = logging.getLogger(__name__)

_scheduler = None


def is_available() -> bool:
    try:
        import apscheduler  # noqa: F401
    except ImportError:
        return False
    return True


def get_scheduler():
    global _scheduler
    if _scheduler is None:
        from apscheduler.schedulers.background import BackgroundScheduler
        _scheduler = BackgroundScheduler(timezone="Asia/Kolkata")
    return _scheduler


def _job_id(rule_id: int) -> str:
    return f"auto_sync_rule_{rule_id}"


def _run_rule(rule_id: int) -> None:
    """Executed by APScheduler in a worker thread. Re-fetches the rule fresh
    from the DB rather than closing over a stale object, so edits/disables
    made after the job was scheduled are always honored, and a deleted rule
    is silently a no-op."""
    from .attendance_views import run_biometric_sync
    from .models import AutoSyncRule

    rule = AutoSyncRule.objects.filter(pk=rule_id, is_enabled=True).first()
    if not rule:
        return

    logger.info("Auto Sync rule %s (%s) started", rule.id, rule.name or rule.time)
    device_id = rule.device_selection if rule.device_selection else None
    result = run_biometric_sync(mode=rule.mode, device_id=device_id)

    rule.last_run_at = timezone.now()
    if result.get("ok"):
        rule.last_run_status = "success"
        rule.last_run_summary = f"{result.get('created', 0)} new record(s)"
        logger.info("Auto Sync rule %s complete -%d new records", rule.id, result.get("created", 0))
    else:
        rule.last_run_status = "failed"
        rule.last_run_summary = str(result.get("error") or "Unknown error")
        logger.error("Auto Sync rule %s failed: %s", rule.id, result.get("error"))
    rule.save(update_fields=["last_run_at", "last_run_status", "last_run_summary"])


def apply_rule_to_scheduler(rule) -> None:
    """Add/replace this rule's job, or remove it if disabled. Call after
    every create/update so the change takes effect immediately."""
    if not is_available():
        return
    if not rule.is_enabled:
        remove_rule_from_scheduler(rule.id)
        return

    from apscheduler.triggers.cron import CronTrigger

    trigger = CronTrigger(
        hour=rule.time.hour, minute=rule.time.minute,
        day_of_week=rule.days_of_week or "*", timezone="Asia/Kolkata",
    )
    get_scheduler().add_job(
        _run_rule, trigger, args=[rule.id], id=_job_id(rule.id),
        replace_existing=True, misfire_grace_time=3600,
    )


def remove_rule_from_scheduler(rule_id: int) -> None:
    if not is_available():
        return
    try:
        get_scheduler().remove_job(_job_id(rule_id))
    except Exception:
        pass  # wasn't scheduled -fine (e.g. rule was already disabled)


def load_all_rules_into_scheduler() -> None:
    """Called once at process boot -schedules every currently-enabled rule."""
    from .models import AutoSyncRule
    for rule in AutoSyncRule.objects.filter(is_enabled=True):
        apply_rule_to_scheduler(rule)


def start_scheduler_if_needed() -> None:
    scheduler = get_scheduler()
    if not scheduler.running:
        try:
            scheduler.start()
            logger.info("Auto Sync scheduler started")
        except Exception as e:
            logger.error("Failed to start Auto Sync scheduler: %s", e)
