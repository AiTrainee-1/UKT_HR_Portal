"""Create a fresh, migrated, seeded database for the Playwright e2e suite.

    python e2e_setup.py

Reads the same DB_* environment (or .env) as the app. The target database name
must end in "_e2e" -this script DROPS it if it exists, so it refuses anything
else and can never touch a real database.
"""

import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import psycopg2  # noqa: E402
from psycopg2 import sql  # noqa: E402

from config import settings  # noqa: E402


def main() -> None:
    cfg = settings.DATABASES["default"]
    name = cfg["NAME"]
    if not str(name).endswith("_e2e"):
        sys.exit(f"Refusing to recreate '{name}': set DB_NAME to a database ending in _e2e (e.g. uktex_e2e).")

    conn = psycopg2.connect(
        dbname="postgres",
        user=cfg["USER"],
        password=cfg["PASSWORD"],
        host=cfg["HOST"],
        port=cfg["PORT"],
        **cfg.get("OPTIONS", {}),
    )
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
        cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    conn.close()

    from django.core.management import execute_from_command_line

    execute_from_command_line(["manage.py", "migrate", "--noinput", "-v", "0"])
    execute_from_command_line(["manage.py", "seed_e2e"])


if __name__ == "__main__":
    main()
