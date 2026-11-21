"""HR Analytics (/hr/analytics, owner brief 2026-11-21): who needs HR's attention, and why.

Staff and Production each have their own checks (categories). Every check is a plain count over the chosen period, read
from the records the HRMS already keeps (attendance days, leave / permission / missing-punch / On-Duty / correction
requests and their approval trails), so HR can always open the employee and see the very records behind a number.

  period.py      the filters every endpoint reads (type, from / to, department, employee, search, threshold overrides)
  categories.py  the checks of each tab, their per-month thresholds and the attention levels
  collect.py     the records behind every check, per employee (one pass per check, a fixed number of queries)
  views.py       GET /api/hr-analytics/summary, /category/<key>, /employee/<id>
"""
