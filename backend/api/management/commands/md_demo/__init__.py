"""The MD demo-data seeder: one realistic garment manufacturer, built so the executive dashboards have stories to find.

`python manage.py seed_md_demo` (see ../seed_md_demo.py) fills a THROWAWAY database (its name must end in ``_e2e``, the
same rule ``backend/e2e_setup.py`` applies before it drops a database) with a mid-size Tirupur manufacturer: three
production units and a head office, ~240 people, 120 days of attendance, tea breaks, visitors and outpasses, six closed
payroll months, recruitment and an HR activity trail. It is deterministic (``--seed``), idempotent (a second run does
nothing until ``--purge``), and removes only what it created.

One module per domain, in the order they run:

    common       options, the safety rule, random streams, bulk insert, the manifest that makes ``--purge`` exact
    names        Indian names, places and companies (all fictional)
    org          units, departments, designations, shifts, holidays, settings, gates, roles and the HR / MD accounts
    people       the workforce, its history (joiners, leavers, increments, promotions) and its leave / permissions
    attendance   the day-by-day simulation (punches and the AttendanceDayRecord verdicts) and overtime
    tea          tea-break scans
    gate         visitors and employee outpasses
    payroll      closed payroll months, salary slips, advances, the bonus month
    recruitment  jobs, applicants, screening candidates, resignations, headcount targets
    activity     the audit trail, sign-in sessions and failed attempts
    purge        everything ``--purge`` removes

The attendance verdicts are NOT invented: they come from the attendance engine's own pure helpers
(``attendance_final`` / ``arrival_rules`` / ``shift_engine``), so a day the seeder stores is the day the application would
compute again from the same punches (a test recomputes a sample through the real engine to prove it).
"""
