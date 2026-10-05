"""Fill a THROWAWAY database with a realistic garment manufacturer, so the MD portal's dashboards, analytics and AI assistant
can be demonstrated and tested end to end.

    # from backend/: create the scratch database (drops and recreates it, then migrates) and load the demo company
    DB_NAME=uktex_demo_e2e python e2e_setup.py
    DB_NAME=uktex_demo_e2e python manage.py seed_md_demo

    python manage.py seed_md_demo --purge      # remove everything it created (and nothing else)
    python manage.py seed_md_demo --reload     # purge, then load again (for example with another --seed)

SAFETY: the command refuses unless the active database's name ends in ``_e2e``, the rule ``e2e_setup.py`` applies before it
drops a database. It never runs against the development database. Running it twice without ``--purge`` does nothing the second
time. See ``md_demo/`` for what is generated and the stories planted in it.
"""

from __future__ import annotations

import json
from datetime import date, datetime, time
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from api.clock import ist_now, ist_today
from api.models import HRUser
from api.management.commands.md_demo import (
    activity,
    attendance,
    gate,
    leave,
    org,
    payroll,
    people,
    purge,
    recruitment,
    tea,
)
from api.management.commands.md_demo.common import (
    DEMO_PASSWORD,
    MD_USERNAME,
    MANIFEST_VERSION,
    Plan,
    Streams,
    World,
    manifest_path,
    require_throwaway_database,
    schedulers_silenced,
    write_manifest,
)

DEFAULT_MANIFEST_DIR = Path(__file__).resolve().parent / "md_demo"


class Command(BaseCommand):
    help = (
        "Load a realistic demo company (units, ~240 people, 120 days of attendance, tea breaks, visitors, outpasses, six payroll "
        "months, recruitment, an activity trail) into a throwaway database whose name ends in _e2e. --purge removes it."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--seed", type=int, default=42, help="Random seed: the same seed gives the same company (default 42)."
        )
        parser.add_argument(
            "--days", type=int, default=120, help="Length in days of the activity window (default 120)."
        )
        parser.add_argument(
            "--employees", type=int, default=240, help="Employee records to create, leavers included (default 240)."
        )
        parser.add_argument("--today", help="Pretend today is this date (YYYY-MM-DD); default is the factory's date.")
        parser.add_argument(
            "--now",
            help="The factory clock for today (HH:MM): only punches before it exist yet. Default: now, but not before 11:00 so "
            "a demo loaded at dawn still has a populated today.",
        )
        parser.add_argument(
            "--payroll-months", type=int, default=6, help="Closed payroll months to generate (default 6)."
        )
        parser.add_argument(
            "--password",
            default=DEMO_PASSWORD,
            help="Password of every demo account (default: DEMO_PASSWORD in md_demo/common.py).",
        )
        parser.add_argument("--purge", action="store_true", help="Remove everything this command created and stop.")
        parser.add_argument("--reload", action="store_true", help="Purge, then load the demo company again.")
        parser.add_argument(
            "--manifest-dir", help="Where the record of created rows is kept (default: next to the command)."
        )

    # ─── option handling ──────────────────────────────────────────────────────────────────────────────────────

    def _plan(self, options) -> Plan:
        today = ist_today()
        if options["today"]:
            try:
                today = date.fromisoformat(options["today"])
            except ValueError as exc:
                raise CommandError("--today must be a date like 2026-10-05.") from exc
            if today > ist_today():
                raise CommandError("--today cannot be in the future.")
        if options["now"]:
            try:
                hour, minute = (int(x) for x in options["now"].split(":"))
                now = time(hour, minute)
            except (ValueError, TypeError) as exc:
                raise CommandError("--now must be a time like 15:30.") from exc
        elif today < ist_today():
            now = time(23, 59)  # a past day is complete
        else:
            now = max(ist_now().time().replace(second=0, microsecond=0), time(11, 0))
        if not 12 <= options["employees"] <= 3000:
            raise CommandError("--employees must be between 12 and 3000.")
        if not 7 <= options["days"] <= 400:
            raise CommandError("--days must be between 7 and 400.")
        if not 1 <= options["payroll_months"] <= 12:
            raise CommandError("--payroll-months must be between 1 and 12.")
        return Plan(
            seed=options["seed"],
            employees=options["employees"],
            days=options["days"],
            today=today,
            now=now,
            password=options["password"],
            payroll_months=options["payroll_months"],
            manifest_dir=Path(options["manifest_dir"]) if options["manifest_dir"] else DEFAULT_MANIFEST_DIR,
        )

    # ─── the command ──────────────────────────────────────────────────────────────────────────────────────────

    def handle(self, *args, **options):
        database = require_throwaway_database()
        plan = self._plan(options)
        say = self.stdout.write
        with schedulers_silenced():
            if options["purge"] or options["reload"]:
                say(self.style.MIGRATE_HEADING(f"Removing the demo data from {database}"))
                with transaction.atomic():
                    deleted = purge.purge(plan.manifest_dir, database, say)
                    left = {k: v for k, v in purge.leftover_counts().items() if v}
                    if left:
                        raise CommandError(f"The purge left demo rows behind: {left}")
                say(f"  removed {sum(deleted.values()):,} rows in {len(deleted)} tables")
                if options["purge"] and not options["reload"]:
                    return
            if purge.has_demo_data():
                say(
                    self.style.WARNING(
                        f"{database} already holds the demo data: nothing to do. Use --purge to remove it, or --reload to load it again."
                    )
                )
                return
            self._guard_accounts()
            say(self.style.MIGRATE_HEADING(f"Loading the demo company into {database}"))
            say(
                f"  seed {plan.seed}, {plan.employees} employees, {plan.days} days to {plan.today} (factory clock {plan.now:%H:%M})"
            )
            world = World(plan=plan, streams=Streams(plan.seed), out=lambda m: say(m))
            with transaction.atomic():
                self._load(world)
            self._finish(world, database)

    def _guard_accounts(self) -> None:
        clash = list(
            HRUser.objects.filter(username__in=[MD_USERNAME, *org.HR_USERS]).values_list("username", flat=True)
        )
        if clash:
            raise CommandError(
                f"Accounts {', '.join(clash)} already exist and are not part of a demo load; refusing to touch them."
            )
        other_md = HRUser.objects.filter(is_md=True).first()
        if other_md is not None:
            raise CommandError(
                f"'{other_md.username}' is already the Managing Director (only one account can be); remove that flag before loading the demo."
            )

    def _load(self, world: World) -> None:
        org.build_org(world)
        people.plan_people(world)
        leave.plan_leave(world)
        people.create_people(world)
        attendance.simulate(world)
        attendance.create_attendance(world)
        leave.create_leave(world)
        tea.create_tea_breaks(world)
        gate.create_gate(world)
        payroll.create_payroll(world)
        recruitment.create_recruitment(world)
        activity.create_activity(world)

    def _finish(self, world: World, database: str) -> None:
        plan = world.plan
        md = world.md_user
        payload = {
            "version": MANIFEST_VERSION,
            "database": database,
            "createdAt": datetime.now().isoformat(timespec="seconds"),
            "options": plan.describe(),
            "fingerprint": {"mdUserId": md.pk, "mdCreatedAt": md.created_at.isoformat()},
            "rows": world.tracker.to_json(),
            "singletons": world.created_singletons,
            "branchSeq": world.adjustments.get("branchSeq", {}),
            "stories": world.stories,
            "summary": world.summary,
        }
        path = manifest_path(plan.manifest_dir, database)
        write_manifest(path, payload)
        say = self.stdout.write
        counts = world.tracker.counts()
        say(self.style.SUCCESS(f"\nLoaded {sum(counts.values()):,} rows in {world.elapsed():.0f} s"))
        for label, n in sorted(counts.items(), key=lambda kv: -kv[1])[:12]:
            say(f"  {label:34s}{n:>9,}")
        say("\nPlanted stories")
        say(json.dumps(world.stories, indent=1, default=str))
        say(
            f"\nSign in at the HR login page as {MD_USERNAME} (the Managing Director; password: --password, default DEMO_PASSWORD in "
            f"api/management/commands/md_demo/common.py). The other accounts are {', '.join(org.HR_USERS)}."
            f"\nRecord of created rows (for --purge): {path}"
        )
