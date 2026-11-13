"""
The HR portal's permission tree: every page, tab, sub-tab and feature a role can be given Hidden / View / Edit on, in the
order and the places the owner sees them (sidebar section -> page -> tab -> sub-tab). Pure data and pure helpers, no
Django: permission_registry.py builds the API map and the resolver from it, and the HR portal reads the same tree from
frontend/src/lib/permission-tree.json (export_json() below writes it; tests_permission_tree.py fails when they differ).

A node
------
    key            the permission key stored in Role.permissions / HRUser.permission_overrides. Dotted keys are children
                   ("payroll.issues" is a part of "payroll"): an unset key follows its dotted parent, as always.
    label, type    what the editor shows: type is section | page | tab | subtab | view | feature.
    help           one plain line for the owner.
    api            API path prefixes (relative to /api/) this key guards on the server (longest prefix wins).
    apiPatterns    regular expressions for API paths with an id in the middle (employees/12/offer-letter/pdf).
    routes         HR portal address prefixes this key guards (the page / tab / sub-tab address).
    routePatterns  regular expressions for addresses with an id in them (/hr/employees/12/edit).
    inherits       when this key (and its dotted parents up to the next one with a setting) is unset, follow THIS key
                   instead of the dotted parent. Used where a part was governed by another module before it had a key of
                   its own (Settings -> ID Card followed ID Cards), so every existing role keeps exactly its access.
    own            shown under a page it belongs to on screen although its key is not a dotted child of it (Staff Payroll
                   -> Salary tab is the old "salary" key): it has a setting of its own.
    locked         cannot be given to a role (who may use it is fixed); the text says who. Never stored.
    viewCheck      the API view itself checks this key (a settings field group, a Requests kind, a report group), in
                   addition to or instead of a URL prefix.

A key with neither api / apiPatterns / viewCheck of its own is "screen only": it shares its page's API, so Hidden hides
it in the portal but the server still answers the page's calls (permission-inventory.md lists every one and why).
"""

from __future__ import annotations

import json
import re
from pathlib import Path


def N(key: str, label: str, kind: str, help: str, *children: dict, **extra) -> dict:  # noqa: A002 (help is the field name)
    node = {"key": key, "label": label, "type": kind, "help": help}
    for name in ("api", "apiPatterns", "routes", "routePatterns"):
        if extra.get(name):
            node[name] = list(extra.pop(name))
    for name in ("inherits", "own", "locked", "viewCheck"):
        if extra.get(name):
            node[name] = extra.pop(name)
    if extra:
        raise TypeError(f"{key}: unknown fields {sorted(extra)}")
    if children:
        node["children"] = list(children)
    return node


SUPER_ADMIN_ONLY = "Super Admin only"

# ───────────────────────────── Main pages ─────────────────────────────

DASHBOARD = N(
    "dashboard",
    "Dashboard",
    "page",
    "The HR home page.",
    N(
        "dashboard.key_figures",
        "Key figures",
        "feature",
        "The cards at the top: employees, present today, pending leave and permissions, monthly payroll, open advances.",
    ),
    N(
        "dashboard.attendance",
        "Today's attendance and daily trend",
        "feature",
        "Present / absent rings and this month's daily chart (also needs Attendance).",
    ),
    N(
        "dashboard.salary_cost",
        "Salary cost, last 12 months",
        "feature",
        "The monthly salary cost chart.",
        api=["dashboard/salary-trends"],
    ),
    N("dashboard.headcount", "Headcount and workforce", "feature", "Employees per department and the workforce mix."),
    N(
        "dashboard.pending_actions",
        "Pending actions",
        "feature",
        "What is waiting for HR: leave, permissions, missing punches, CL, advances, On-Duty.",
    ),
    N("dashboard.holidays", "Upcoming holidays", "feature", "The next company holidays."),
    N("dashboard.geo", "Geo Attendance today", "feature", "Today's On-Duty and live-tracking figures."),
    N(
        "dashboard.recruitment",
        "Recruitment and documents",
        "feature",
        "Open positions, applicants, resumes and document completion.",
    ),
    N("dashboard.activity", "Activity summary", "feature", "Sign-ins and changes made in the portal today."),
    N(
        "dashboard.auto_sync",
        "Auto Sync button",
        "feature",
        "Pulls today's punches from the biometric devices (also needs Attendance -> Sync).",
    ),
)

EMPLOYEES = N(
    "employees",
    "Employees",
    "section",
    "The employee list and everything about employees.",
    N("employees.staff", "All Employees - Staff", "tab", "The staff list."),
    N("employees.production", "All Employees - Production", "tab", "The production list."),
    N(
        "employees.co_emp",
        "All Employees - Co Emp",
        "tab",
        "Who is a Co Emp (PF / ESI) and the coverage counts.",
        N("employees.co_emp.tds", "TDS", "subtab", "Employees whose salary has tax deducted at source.", api=["tds"]),
        api=["pf-esi/coverage"],
    ),
    N(
        "employees.status",
        "Activate / deactivate an employee",
        "feature",
        "The Active / Inactive switch on a row.",
        apiPatterns=[r"employees/\d+/status"],
    ),
    N(
        "employees.profile",
        "Employee profile",
        "page",
        "One employee's full details page.",
        N("employees.profile.salary", "Salary and salary history", "feature", "Salary, its split and past salaries."),
        N("employees.profile.bank", "Bank and statutory details", "feature", "Bank account, PF, ESI, PAN and Aadhaar."),
        N("employees.profile.documents", "Uploaded documents", "feature", "The documents uploaded for the employee."),
        N("employees.profile.id_card", "ID card", "feature", "The employee's ID card and its download."),
        routePatterns=[r"/hr/employees/\d+"],
    ),
    N(
        "employees.letters",
        "Offer and experience letters",
        "feature",
        "View, download, email and WhatsApp offer / experience letters (profile, New Joinees, Documents).",
        apiPatterns=[r"employees/\d+/(offer|experience)-letter(/.*)?"],
    ),
    N("employees.add", "Add employee", "page", "The new-employee form.", routes=["/hr/employees/new"]),
    N(
        "employees.edit",
        "Edit employee",
        "page",
        "The edit form of an employee.",
        routePatterns=[r"/hr/employees/\d+/edit"],
    ),
    N(
        "employees.bulk_upload",
        "Bulk upload",
        "page",
        "Add or update many employees from an Excel file.",
        N(
            "employees.bulk_upload.add",
            "Add new employees",
            "tab",
            "Upload new employees.",
            api=["employees/bulk-upload"],
        ),
        N("employees.bulk_upload.active", "Active employees", "tab", "Download and re-upload the active employees."),
        N(
            "employees.bulk_upload.inactive",
            "Inactive employees",
            "tab",
            "Download and re-upload the inactive employees.",
        ),
        routes=["/hr/employees/bulk-upload"],
        api=["employees/bulk-update"],
    ),
    N(
        "employees.production_employees",
        "Production Employees",
        "page",
        "Which production employees are paid Weekly, BiWeekly or Monthly.",
        routes=["/hr/employees/productionEmployee"],
        api=["employees/production"],
    ),
    N(
        "employees.departments",
        "Departments",
        "page",
        "Departments and who is in each.",
        N("employees.departments.list", "Departments", "tab", "The department list."),
        N(
            "employees.departments.find",
            "Find & assign employees",
            "tab",
            "Find an employee or the unassigned ones and set their department.",
            N("employees.departments.find.search", "Find employee", "subtab", "Search an employee."),
            N("employees.departments.find.unassigned", "Unassigned", "subtab", "Employees with no department."),
        ),
    ),
    N(
        "employees.designations",
        "Designations",
        "page",
        "Designations and who holds each.",
        N("employees.designations.structure", "Structure", "tab", "The designation tree and list."),
        N(
            "employees.designations.find",
            "Find & assign employees",
            "tab",
            "Find an employee or the unassigned ones and set their designation.",
            N("employees.designations.find.search", "Find employee", "subtab", "Search an employee."),
            N("employees.designations.find.unassigned", "Unassigned", "subtab", "Employees with no designation."),
        ),
    ),
    N("employees.branches", "Manage Branch", "page", "The company's branches / units."),
)

ATTENDANCE = N(
    "attendance",
    "Attendance",
    "section",
    "Daily attendance, punches and attendance reports.",
    N(
        "attendance.staff",
        "Staff Attendance",
        "page",
        "Today's staff attendance and the month panel.",
        routes=["/hr/attendance/staff"],
    ),
    N(
        "attendance.production",
        "Production Attendance",
        "page",
        "Today's production attendance and the month panel.",
        routes=["/hr/attendance/production"],
    ),
    N(
        "attendance.employee_search",
        "Employee attendance search",
        "feature",
        "One employee's month with every punch, on the attendance pages.",
        api=["attendance/employee-monthly", "attendance/employee-punches"],
    ),
    N(
        "attendance.add_manual",
        "Add attendance by hand",
        "feature",
        "The Add Attendance form.",
        api=["attendance/manual"],
    ),
    N(
        "attendance.skipped_punches",
        "Skipped punches",
        "feature",
        "Punches the system could not use, and resolving them.",
        api=["attendance/skipped-punches"],
    ),
    N(
        "attendance.sync",
        "Sync from devices and Auto Sync rules",
        "feature",
        "Pull punches from the biometric devices now, and the automatic sync rules.",
        api=["attendance/sync-biometric", "attendance/sync-biometric-progress", "auto-sync-rules"],
    ),
    N(
        "attendance.search",
        "Attendance Search",
        "page",
        "Search punches by employee and period.",
        routes=["/hr/attendance/search"],
        api=["attendance/search"],
    ),
    N(
        "attendance.report_log",
        "Report Log",
        "page",
        "Monthly attendance sheet and the daily leave / late reports.",
        N(
            "attendance.report_log.monthly",
            "Monthly Report",
            "tab",
            "The month's attendance sheet and the late-penalty card.",
            api=["attendance/report-log/sheet", "attendance/late-summary"],
        ),
        N(
            "attendance.report_log.leave",
            "Daily Leave Report",
            "tab",
            "Who was absent or on leave on a day, and whether they informed.",
            api=["attendance/day-informed"],
        ),
        N("attendance.report_log.late", "Daily Late Report", "tab", "Who came late on a day."),
        routes=["/hr/attendance/report-log"],
        api=["attendance/report-log"],
    ),
    N(
        "attendance.punch_view",
        "Punch View",
        "page",
        "Every punch, with filters.",
        N(
            "attendance.punch_view.history",
            "Punch View history",
            "page",
            "Who changed which punch and when.",
            routes=["/hr/attendance/punch-view/history"],
            api=["attendance/punches/history"],
        ),
        N(
            "attendance.punch_view.export",
            "Export to Excel",
            "feature",
            "Download the punches as an Excel file.",
            api=["attendance/punches/export"],
        ),
        N(
            "attendance.punch_view.upload",
            "Upload an edited file",
            "feature",
            "Add, change or delete punches from an Excel file.",
            api=["attendance/punches/import"],
        ),
        N(
            "attendance.punch_view.day_status",
            "Set a day's status",
            "feature",
            "Mark a day Present / Absent / Leave by hand, or back to automatic.",
            api=["attendance/punches/day-status"],
        ),
        routes=["/hr/attendance/punch-view"],
        api=["attendance/punches"],
    ),
    N(
        "attendance.manual_import",
        "Manual punch import",
        "page",
        "Download / upload punching data (kept for sites without device access; no menu entry).",
        routes=["/hr/attendance/manual-import"],
        api=["attendance/manual-import"],
    ),
    N(
        "attendance.edit",
        "Edit a day's attendance",
        "page",
        "Propose a change to one day's attendance (the Department Head and HR then approve it).",
        routes=["/hr/attendance/edit"],
        api=["attendance/edit-context", "attendance/override"],
    ),
    N("missing_punch", "Missing Punch", "page", "Employees' missed-punch requests.", own=True),
)

GEO = N(
    "geo_attendance",
    "Geo Attendance",
    "section",
    "Work away from the premises: On-Duty, live tracking and journeys.",
    N(
        "geo_attendance.approvals",
        "On-Duty Approvals",
        "tab",
        "On-Duty requests.",
        routes=["/hr/geo-attendance/approvals"],
        api=["on-duty-sessions"],
    ),
    N(
        "geo_attendance.verifications",
        "Punch Verifications",
        "tab",
        "Punches made On-Duty, with photos and place.",
        routes=["/hr/geo-attendance/verifications"],
        api=["on-duty-punch-verifications"],
        apiPatterns=[r"on-duty-sessions/\d+/punches"],
    ),
    N(
        "geo_attendance.live_map",
        "Live Map",
        "tab",
        "Where tracked employees are now.",
        routes=["/hr/geo-attendance/live-map"],
        api=["live-location/team", "tracking/live"],
    ),
    N(
        "geo_attendance.journeys",
        "Journey History",
        "tab",
        "Past journeys and their maps.",
        N(
            "geo_attendance.journeys.simulate",
            "Simulate a journey",
            "subtab",
            "Replay a journey on the map.",
            routePatterns=[r"/hr/geo-attendance/journeys/\d+/simulate"],
        ),
        N(
            "geo_attendance.journeys.export",
            "Export a journey",
            "feature",
            "Download a journey as Excel or PDF.",
            apiPatterns=[r"tracking/journeys/\d+/export"],
        ),
        routes=["/hr/geo-attendance/journeys"],
        api=["tracking/journeys"],
    ),
    N(
        "geo_attendance.on_duty_map",
        "On-Duty Map",
        "tab",
        "A day's On-Duty places on one map.",
        N("geo_attendance.on_duty_map.all", "All On-Duty", "subtab", "Everyone On-Duty that day."),
        N("geo_attendance.on_duty_map.single", "Single employee", "subtab", "One employee's day."),
        routes=["/hr/geo-attendance/on-duty-map"],
        api=["on-duty-map", "tracking/journeys/day-map"],
    ),
    N(
        "geo_attendance.settings",
        "Tracking Settings",
        "tab",
        "Who is tracked, and the tracking rules (the rules also need Settings -> Attendance).",
        routes=["/hr/geo-attendance/settings"],
    ),
    # A punch's route on a day: the Punch Verifications and On-Duty Map tabs both read it, so it stays the page's.
    apiPatterns=[r"live-location/team/\d+/route"],
)

GATE = N(
    "outpass_visitors",
    "Outpass / Visitors",
    "section",
    "Gate passes, visitors and tea breaks.",
    N(
        "outpass_visitors.outpass",
        "Outpass",
        "page",
        "Employees going out during work hours.",
        N(
            "outpass_visitors.outpass.overview",
            "Overview",
            "tab",
            "Today's passes, the gate QR and its submissions.",
            N(
                "outpass_visitors.outpass.overview.passes",
                "Passes",
                "subtab",
                "The passes list.",
                routes=["/hr/outpass-visitors/outpass/overview/passes"],
            ),
            N(
                "outpass_visitors.outpass.overview.qr_submissions",
                "Gate QR submissions",
                "subtab",
                "What was submitted at the gate QR.",
                routes=["/hr/outpass-visitors/outpass/overview/qr-submissions"],
            ),
            routes=["/hr/outpass-visitors/outpass/overview"],
            api=["outpass/qr", "outpass/records"],
        ),
        N(
            "outpass_visitors.outpass.requests",
            "Requests",
            "tab",
            "Outpass requests waiting for HR.",
            routes=["/hr/outpass-visitors/outpass/requests"],
        ),
        N(
            "outpass_visitors.outpass.in_out",
            "In/Out",
            "tab",
            "Who went out and came back.",
            routes=["/hr/outpass-visitors/outpass/in-out"],
        ),
        N(
            "outpass_visitors.outpass.gate_devices",
            "Gate scanner devices",
            "feature",
            "The gate scanner logins.",
            api=["gate-devices"],
        ),
        routes=["/hr/outpass-visitors/outpass"],
        api=["outpass/summary"],
    ),
    N(
        "outpass_visitors.visitors",
        "Visitors",
        "page",
        "Visitors at reception.",
        N(
            "outpass_visitors.visitors.reception_devices",
            "Reception desk devices",
            "feature",
            "The reception desk logins.",
            api=["reception-devices"],
        ),
        routes=["/hr/outpass-visitors/visitors"],
        api=["visitor/qr", "visitor/summary", "visitor/records"],
    ),
    N(
        "outpass_visitors.tea_break",
        "Tea Break",
        "page",
        "Tea break records and the tea break rule.",
        N(
            "outpass_visitors.tea_break.records",
            "Records",
            "tab",
            "Who took a tea break and for how long.",
            routes=["/hr/outpass-visitors/tea-break/records"],
            api=["tea-break/records"],
        ),
        N(
            "outpass_visitors.tea_break.rule",
            "Rule",
            "tab",
            "How long a tea break may be.",
            routes=["/hr/outpass-visitors/tea-break/rule"],
            api=["tea-break/rule"],
        ),
        routes=["/hr/outpass-visitors/tea-break"],
        api=["tea-break/summary"],
    ),
)

# ───────────────────────────── HR Operations ─────────────────────────────

SHIFTS = N(
    "shifts",
    "Manage Shift",
    "page",
    "Shifts and who works which shift.",
    N("shifts.shifts", "Shifts", "tab", "Create, change and switch off shifts."),
    N(
        "shifts.assignments",
        "Assigned",
        "tab",
        "Who is on which shift; change or end it.",
        api=["shift-assignments/end"],
    ),
    N("shifts.unassigned", "Unassigned", "tab", "Active employees with no shift."),
    N(
        "shifts.assign",
        "Assign employees to a shift",
        "feature",
        "The Assign / Move dialog.",
        api=["shift-assignments/plan", "shift-assignments/apply", "shift-assignments/bulk"],
    ),
    N(
        "shifts.sync_production",
        "Assign production staff with no shift",
        "feature",
        "Puts every production employee without a shift on the default one.",
        api=["shift-assignments/sync-production"],
    ),
)

LEAVE = N(
    "leave",
    "Leave & Holiday",
    "page",
    "Leave, half days, permissions, holidays and leave balances.",
    N("leave.requests", "Leave Requests", "tab", "Employees' leave requests."),
    N("leave.half_day", "Half-Day Leave", "tab", "Half-day leave requests."),
    N(
        "leave.permissions",
        "Permissions",
        "tab",
        "Late-In / Early-Out / One-Hour permissions (their data is the Requests page's).",
    ),
    N("leave.calendar", "Calendar", "tab", "Leave, CL and holidays on a calendar."),
    N("leave.holidays", "Holidays", "tab", "The company holiday list (everyone can still read it).", api=["holidays"]),
    N(
        "leave.balances",
        "Balances",
        "tab",
        "Leave balances, allocations and leave types.",
        api=["leave-balances", "leave-types"],
    ),
)

CASUAL_LEAVE = N(
    "casual_leave",
    "Casual Leave",
    "page",
    "Casual Leave (CL): who took it, who may, requests and carry forward.",
    N("casual_leave.taken", "Taken this month", "tab", "CL taken this month."),
    N("casual_leave.eligible", "Eligible", "tab", "Who may take CL, and applying CL for them."),
    N("casual_leave.not_eligible", "Not eligible", "tab", "Who may not take CL, and why."),
    N("casual_leave.requests", "Requests", "tab", "CL requests waiting for a decision."),
    N(
        "casual_leave.carry_forward",
        "Carry Forward",
        "tab",
        "The yearly CL balances and changes to them.",
        N(
            "casual_leave.carry_forward.balances",
            "Balances",
            "subtab",
            "Balances left, and assigning CL against absent days.",
            api=["casual-leaves/assign", "casual-leaves/absent-dates"],
        ),
        N(
            "casual_leave.carry_forward.log",
            "Change log",
            "subtab",
            "Every change to a CL balance.",
            api=["casual-leaves/adjustments"],
        ),
    ),
)

_REQUEST_KINDS = (
    ("leave", "Leave", "Leave requests in the list."),
    ("permission", "Permission", "Permission requests in the list."),
    ("casual_leave", "Casual Leave", "Casual Leave requests in the list."),
    ("missing_punch", "Missing Punch", "Missed-punch requests in the list."),
    ("on_duty", "On-Duty", "On-Duty requests in the list."),
    ("on_duty_punch", "On-Duty punches", "On-Duty punches in the list."),
    ("outpass", "Outpass", "Outpass requests in the list."),
    (
        "request",
        "Other requests",
        "Requests sent with the employee request form (salary enquiry, shift correction ...).",
    ),
    ("attendance_correction", "Attendance correction", "Attendance edit requests in the list."),
    ("holiday_work", "Holiday / Sunday work", "Holiday / Sunday work claims in the list."),
    ("resignation", "Resignation", "Resignations in the list."),
    ("advance", "Advance", "Advance requests in the list."),
)

REQUESTS = N(
    "requests",
    "Requests",
    "page",
    "Every request waiting for HR in one place; also permissions, outpasses and employee requests.",
    N(
        "requests.list",
        "Requests",
        "tab",
        "The list of every kind of request. Each kind also needs its own page (Leave, Casual Leave ...).",
        *(N(f"requests.list.{k}", label, "subtab", help, viewCheck=True) for k, label, help in _REQUEST_KINDS),
        api=["hr-requests"],
    ),
    N("requests.hods", "HoD's", "tab", "What is waiting with each Department Head.", api=["hr/hod-pending"]),
    N(
        "requests.notify",
        "Notify",
        "tab",
        "Reminders sent to Department Heads, and their schedule.",
        N(
            "requests.notify.send",
            "Send reminders now",
            "feature",
            "Send the reminders at once.",
            api=["hr/hod-reminders/send"],
        ),
        N(
            "requests.notify.history",
            "Run history",
            "feature",
            "The reminders sent before.",
            api=["hr/hod-reminders/runs"],
        ),
        api=["hr/hod-reminders"],
        viewCheck=True,
    ),
)

PROMOTION = N(
    "promotion",
    "Promotion",
    "page",
    "Promotions.",
    N("promotion.promote", "Promote", "tab", "Promote an employee."),
    N("promotion.history", "History", "tab", "Past promotions."),
    N("promotion.due", "Due for review", "tab", "Who is due a promotion review."),
)

INCREMENT = N(
    "increment",
    "Increment",
    "page",
    "Salary increments.",
    N("increment.apply", "Apply increment", "tab", "Give an employee an increment.", api=["increments/summary"]),
    N("increment.history", "History", "tab", "Past increments."),
    N("increment.due", "Due for increment", "tab", "Who is due an increment."),
    N("increment.insights", "Insights", "tab", "Increment charts."),
)

BONUS = N(
    "bonus",
    "Bonus",
    "page",
    "The yearly bonus register.",
    N(
        "bonus.generate",
        "Generate the register",
        "feature",
        "Work out and save a year's bonus.",
        api=["bonus/generate"],
    ),
    N("bonus.export", "Export", "feature", "Download the register as Excel.", api=["bonus/export"]),
)

ID_CARDS = N(
    "id_cards",
    "ID Cards",
    "page",
    "Employee ID cards.",
    N(
        "id_cards.send",
        "Email / WhatsApp ID cards",
        "feature",
        "Send an ID card to the employee.",
        api=["idcard/email", "idcard/whatsapp"],
    ),
)

# ───────────────────────────── Payroll ─────────────────────────────

STAFF_PAYROLL = N(
    "payroll",
    "Staff Payroll",
    "page",
    "The staff payroll (this is also its Payroll tab).",
    N("payroll.records", "Payroll - Records", "view", "The month's payroll rows."),
    N(
        "payroll.issues",
        "Payroll - Issues",
        "view",
        "Problems found in the month's attendance and pay.",
        api=["payroll/issues"],
    ),
    N(
        "payroll.skipped",
        "Payroll - Skipped",
        "view",
        "Employees not in the payroll: not generated, on hold, new joiners.",
        api=["payroll/month-skipped"],
    ),
    N("payroll.rules", "Payroll - Rules", "view", "The rules the month was worked out with.", api=["payroll/rules"]),
    N(
        "payroll.generate",
        "Generate payroll",
        "feature",
        "Work out the month's payroll.",
        api=["payroll/generate", "payroll/generate-progress"],
    ),
    N(
        "payroll.exports",
        "Salary statement and bank file",
        "feature",
        "The Excel / PDF salary statement and the bank file (the statement also needs Reports).",
    ),
    N("payroll.adjust", "Adjust bonus / deductions", "feature", "Change one employee's bonus, deductions or notes."),
    N(
        "payroll.details",
        "Payroll details",
        "page",
        "One employee's payroll page: days, issues, pay and deductions.",
        routes=["/hr/payroll/details"],
        apiPatterns=[r"payroll/\d+/details"],
    ),
    N("salary", "Salary", "tab", "The Salary tab: the month's salary statement.", own=True),
    N(
        "salary_slip",
        "Payslip",
        "tab",
        "The Payslip tab: view, download and send payslips (production payslips too).",
        N(
            "salary_slip.send",
            "Email / WhatsApp payslips",
            "feature",
            "Send payslips one by one or all at once.",
            api=[
                "salary-slips/bulk-email",
                "salary-slips/bulk-progress",
                "salary-slips/bulk-whatsapp",
                "salary-slips/bulk-whatsapp-progress",
            ],
            apiPatterns=[r"salary-slips/\d+/(email|whatsapp)"],
        ),
        own=True,
    ),
)

PRODUCTION_PAYROLL = N(
    "production_payroll",
    "Production Payroll",
    "section",
    "The production payroll, one page per pay cycle.",
    N("production_payroll.weekly", "Weekly", "page", "The weekly cycle.", routes=["/hr/production-payroll/weekly"]),
    N(
        "production_payroll.biweekly",
        "BiWeekly",
        "page",
        "The fortnightly cycle.",
        routes=["/hr/production-payroll/biweekly"],
    ),
    N("production_payroll.monthly", "Monthly", "page", "The monthly cycle.", routes=["/hr/production-payroll/monthly"]),
    N(
        "production_payroll.payroll",
        "Payroll tab (every cycle)",
        "tab",
        "The period's payroll.",
        N("production_payroll.payroll.records", "Records", "view", "The period's payroll rows."),
        N("production_payroll.payroll.issues", "Issues", "view", "Problems found in the period."),
        N("production_payroll.payroll.skipped", "Skipped", "view", "Who is not in the period's payroll."),
        N("production_payroll.payroll.rules", "Rules", "view", "The rules the period was worked out with."),
    ),
    N(
        "production_payroll.employees",
        "Employees tab (every cycle)",
        "tab",
        "Each employee's state in the period, and generating one by one.",
    ),
    N(
        "production_payroll.salary",
        "Salary tab (every cycle)",
        "tab",
        "The period's salary statement.",
        api=["payroll/production/salary-statement"],
    ),
    N(
        "production_payroll.payslip",
        "Payslip tab (every cycle)",
        "tab",
        "The period's payslips (their data also needs Staff Payroll -> Payslip).",
    ),
    N(
        "production_payroll.generate",
        "Generate payroll",
        "feature",
        "Work out the period's payroll.",
        api=["payroll/production/generate", "payroll/production/skip-check"],
    ),
    N(
        "production_payroll.details",
        "Payroll details",
        "page",
        "One employee's production payroll page.",
        routes=["/hr/production-payroll/details"],
        apiPatterns=[r"payroll/production/\d+/details"],
    ),
)


def _comp(path: str) -> str:
    return f"/hr/compensation/{path}"


COMPENSATION = N(
    "compensation",
    "Compensation",
    "section",
    "Overtime, compensation leave and their history.",
    N("compensation.ctc", "CTC Breakdown", "page", "Each employee's cost to company.", routes=[_comp("ctc-breakdown")]),
    N(
        "compensation.ot",
        "OT Detection",
        "page",
        "Overtime found in the punches.",
        N(
            "compensation.ot.type1",
            "Type 1 - Late-in allowance",
            "subtab",
            "Next-day late-in allowance earned by staying late.",
            N(
                "compensation.ot.type1.allowance",
                "Late-in allowance",
                "subtab",
                "Who earned it.",
                routes=[_comp("ot-detection/type-1/allowance")],
            ),
            N(
                "compensation.ot.type1.how",
                "How it is worked out",
                "subtab",
                "The rule, explained.",
                routes=[_comp("ot-detection/type-1/how")],
            ),
            routes=[_comp("ot-detection/type-1")],
        ),
        N(
            "compensation.ot.type2",
            "Type 2 - Shift compensation",
            "subtab",
            "Extra shifts worked, for HR to compensate.",
            N(
                "compensation.ot.type2.waiting",
                "Waiting for HR",
                "subtab",
                "Not decided yet.",
                routes=[_comp("ot-detection/type-2/waiting")],
            ),
            N(
                "compensation.ot.type2.assigned",
                "Assigned and rejected",
                "subtab",
                "Already decided.",
                routes=[_comp("ot-detection/type-2/assigned")],
            ),
            N(
                "compensation.ot.type2.how",
                "How the suggested shifts are worked out",
                "subtab",
                "The rule, explained.",
                routes=[_comp("ot-detection/type-2/how")],
            ),
            routes=[_comp("ot-detection/type-2")],
            api=["compensation/ot/assign"],
        ),
        N(
            "compensation.ot.earlier",
            "Earlier records",
            "subtab",
            "Overtime records from before the two types.",
            routes=[_comp("ot-detection/earlier")],
            api=["compensation/ot/announce"],
        ),
        routes=[_comp("ot-detection")],
        api=["compensation/ot"],
    ),
    N(
        "compensation.leave",
        "Compensation Leave",
        "page",
        "Announced windows, Sunday / holiday work and birthdays.",
        N(
            "compensation.leave.announcements",
            "A. Announce late-in / early-out",
            "subtab",
            "Company-wide late-in / early-out windows.",
            N(
                "compensation.leave.announcements.announce",
                "Announce",
                "subtab",
                "Announce a window.",
                routes=[_comp("compensation-leave/announcements/announce")],
            ),
            N(
                "compensation.leave.announcements.list",
                "Announcements",
                "subtab",
                "Windows announced.",
                routes=[_comp("compensation-leave/announcements/list")],
            ),
            routes=[_comp("compensation-leave/announcements")],
            api=["compensation/windows"],
        ),
        N(
            "compensation.leave.holiday_work",
            "B. Sunday & holiday work",
            "subtab",
            "Work on Sundays and holidays, and the leave it earns.",
            N(
                "compensation.leave.holiday_work.raise",
                "Raise a claim",
                "subtab",
                "Claim a day worked.",
                routes=[_comp("compensation-leave/holiday-work/raise")],
            ),
            N(
                "compensation.leave.holiday_work.claims",
                "Claims",
                "subtab",
                "Claims raised.",
                routes=[_comp("compensation-leave/holiday-work/claims")],
            ),
            N(
                "compensation.leave.holiday_work.balance",
                "Compensation balance",
                "subtab",
                "Leave earned and redeeming it.",
                routes=[_comp("compensation-leave/holiday-work/balance")],
                api=["compensation/balance"],
            ),
            N(
                "compensation.leave.holiday_work.credits",
                "Earlier Alternative-Day credits",
                "subtab",
                "Credits from the old system.",
                routes=[_comp("compensation-leave/holiday-work/credits")],
                api=["compensation/credits"],
            ),
            routes=[_comp("compensation-leave/holiday-work")],
            api=["compensation/holiday-work"],
        ),
        N(
            "compensation.leave.birthdays",
            "C. Birthdays",
            "subtab",
            "Birthday leave.",
            N(
                "compensation.leave.birthdays.list",
                "Who has a birthday",
                "subtab",
                "Birthdays in a period.",
                routes=[_comp("compensation-leave/birthdays/list")],
            ),
            N(
                "compensation.leave.birthdays.how",
                "How it works",
                "subtab",
                "The rule, explained.",
                routes=[_comp("compensation-leave/birthdays/how")],
            ),
            routes=[_comp("compensation-leave/birthdays")],
            api=["compensation/birthdays"],
        ),
        routes=[_comp("compensation-leave")],
    ),
    N(
        "compensation.history",
        "History",
        "page",
        "Every compensation record by kind.",
        N(
            "compensation.history.ot_allowance",
            "OT allowance",
            "subtab",
            "Late-in allowances given.",
            routes=[_comp("history/ot-allowance")],
        ),
        N(
            "compensation.history.ot_relaxation",
            "OT relaxation",
            "subtab",
            "Shift relaxations given.",
            routes=[_comp("history/ot-relaxation")],
        ),
        N("compensation.history.ot_pay", "OT pay", "subtab", "Overtime paid.", routes=[_comp("history/ot-pay")]),
        N(
            "compensation.history.company_windows",
            "Company windows",
            "subtab",
            "Announced windows used.",
            N(
                "compensation.history.company_windows.late_in",
                "Late-in window",
                "subtab",
                "Late-in windows used.",
                routes=[_comp("history/company-windows/late-in")],
            ),
            N(
                "compensation.history.company_windows.early_out",
                "Early-out window",
                "subtab",
                "Early-out windows used.",
                routes=[_comp("history/company-windows/early-out")],
            ),
            routes=[_comp("history/company-windows")],
        ),
        N(
            "compensation.history.holiday_work",
            "Holiday / Sunday work",
            "subtab",
            "Days worked and balance redeemed.",
            N(
                "compensation.history.holiday_work.work",
                "Sunday / holiday work",
                "subtab",
                "Days worked.",
                routes=[_comp("history/holiday-work/work")],
            ),
            N(
                "compensation.history.holiday_work.redeemed",
                "Balance redeemed",
                "subtab",
                "Leave taken from the balance.",
                routes=[_comp("history/holiday-work/redeemed")],
            ),
            routes=[_comp("history/holiday-work")],
        ),
        N(
            "compensation.history.birthday_leave",
            "Birthday leave",
            "subtab",
            "Birthday leave given.",
            routes=[_comp("history/birthday-leave")],
        ),
        routes=[_comp("history")],
    ),
    N("compensation.reports", "Reports", "page", "Compensation summaries and their export.", routes=[_comp("reports")]),
)

SETTLEMENT = N("settlement", "Settlement", "page", "Salary advances and term loans, and their repayment.")

_REPORT_GROUPS = (
    ("payroll", "Payroll & Salary", "Slips, registers, wages, statutory statements and deductions."),
    ("attendance", "Attendance", "Time cards, daily and monthly attendance, late, overtime and shifts."),
    ("leave", "Leave & Requests", "Leave, permission, on-duty, missing punch and other requests."),
    ("gate", "Gate & Visitors", "Outpass, visitor and tea-break registers."),
    ("employees", "Employees", "Master data, headcount, joiners, exits and compliance."),
    ("hr", "HR Reports", "Ready-made HR registers (time card, punching, strength, salary statement ...)."),
    ("finance", "Loans & Bonus", "Advances, loans, bonus, increments and promotions."),
)

REPORTS = N(
    "reports",
    "Reports",
    "page",
    "The Report Center. Each report also needs view on the pages its data comes from.",
    *(N(f"reports.{k}", label, "tab", help, viewCheck=True) for k, label, help in _REPORT_GROUPS),
    N("reports.admin", "Administration", "tab", "Audit trail and user access reports.", locked=SUPER_ADMIN_ONLY),
    N(
        "reports.md",
        "Executive (MD)",
        "tab",
        "The Managing Director's one-page summaries.",
        locked="Managing Director only",
    ),
)

# ───────────────────────────── Recruitment ─────────────────────────────

_RS = "recruitment/resume-screening"

RECRUITMENT = N(
    "recruitment",
    "Recruitment",
    "section",
    "Hiring, joiners, exits and employee documents.",
    N(
        "recruitment.dashboard",
        "Recruitment Dashboard",
        "page",
        "Hiring figures at a glance.",
        routes=["/hr/recruitment/dashboard"],
        api=["recruitment/dashboard"],
    ),
    N("recruitment.new_joinees", "New Joinees", "page", "Who joined in the last 30 days, and their offer letters."),
    N("recruitment.resignations", "Resignations", "page", "Resignations and their letters."),
    N("recruitment.required_roles", "Required Roles", "page", "How many people each department needs."),
    N(
        "recruitment.interviews",
        "Interviews",
        "page",
        "Job postings and applicants (their data is the Recruitment section's).",
    ),
    N(
        "recruitment.resume_screening",
        "Resume Screening",
        "page",
        "Screen resumes against the company's rules.",
        N(
            "recruitment.resume_screening.upload",
            "Upload resume",
            "tab",
            "Screen one resume.",
            api=[f"{_RS}/upload-single"],
        ),
        N(
            "recruitment.resume_screening.bulk",
            "Bulk resume upload",
            "tab",
            "Screen many resumes at once.",
            api=[f"{_RS}/upload-bulk", f"{_RS}/upload-bulk-progress"],
        ),
        N(
            "recruitment.resume_screening.rules",
            "Company rules & expectations",
            "tab",
            "The rules resumes are screened against.",
        ),
        N(
            "recruitment.resume_screening.pipeline",
            "Candidate pipeline",
            "tab",
            "Candidates by stage.",
            N("recruitment.resume_screening.pipeline.shortlisted", "Shortlisted", "subtab", "Shortlisted candidates."),
            N(
                "recruitment.resume_screening.pipeline.selected",
                "Selected",
                "subtab",
                "Selected candidates and interview invites.",
            ),
            N("recruitment.resume_screening.pipeline.rejected", "Rejected", "subtab", "Rejected candidates."),
            N(
                "recruitment.resume_screening.pipeline.not_shortlisted",
                "Not shortlisted",
                "subtab",
                "Candidates the screening left out.",
            ),
        ),
    ),
    N(
        "recruitment.documents",
        "Documents",
        "page",
        "Every employee's documents (in the sidebar under HR Operations).",
        N("recruitment.documents.staff", "Staff", "tab", "Document completion of the staff."),
        N("recruitment.documents.production", "Production", "tab", "Document completion of the production employees."),
        N(
            "recruitment.documents.employee",
            "One employee's documents",
            "view",
            "Opened from a row of the list.",
            N(
                "recruitment.documents.employee.letters",
                "Letters",
                "subtab",
                "Offer, experience and resignation letters (also needs Employees -> Offer and experience letters).",
            ),
            N(
                "recruitment.documents.employee.extra",
                "Extra documents",
                "subtab",
                "Upload, view, send and delete other documents.",
                api=["employee-documents"],
                apiPatterns=[r"recruitment/employee-documents/\d+/upload"],
            ),
            apiPatterns=[r"recruitment/employee-documents/\d+"],
        ),
    ),
)

# ───────────────────────────── Administration ─────────────────────────────

ACCOUNT_MANAGEMENT = N(
    "account_management",
    "Account Management",
    "page",
    "HR logins, roles and what they may do.",
    N("account_management.accounts", "Accounts", "tab", "Every HR login.", locked=SUPER_ADMIN_ONLY),
    N("account_management.roles", "Roles & Permissions", "tab", "Roles and this tree.", locked=SUPER_ADMIN_ONLY),
    N(
        "account_management.md_profile",
        "MD Profile",
        "tab",
        "The Managing Director's account and AI assistant.",
        locked=SUPER_ADMIN_ONLY,
    ),
    N("account_management.hr_manager", "HR Manager", "tab", "HR Manager logins.", locked=SUPER_ADMIN_ONLY),
    N("account_management.hr_assistant", "HR Assistant", "tab", "HR Assistant logins.", locked=SUPER_ADMIN_ONLY),
    N(
        "account_management.master",
        "Master",
        "page",
        "Hide accounts and switch features per account.",
        locked="The master administrator only",
    ),
    locked=SUPER_ADMIN_ONLY,
)

USER_MANAGEMENT = N(
    "user_management",
    "User Management",
    "page",
    "Department Heads and how requests are approved.",
    N(
        "user_management.hod",
        "HOD Assignment",
        "tab",
        "Who the Department Heads are and what each may approve.",
        N("user_management.hod.find_user", "Find user", "subtab", "Find an employee to make a Department Head."),
        N("user_management.hod.unassigned", "Unassigned staff", "subtab", "Staff with no Department Head."),
        N(
            "user_management.hod.detail",
            "Department Head details",
            "page",
            "One Department Head's departments, people and approval rights.",
            routePatterns=[r"/hr/user-management/\d+"],
        ),
        api=["department-managers"],
    ),
    N(
        "user_management.approval_workflow",
        "Approval Workflow Control",
        "tab",
        "Who approves each kind of request, in what order, on or off.",
    ),
)

ACTIVITY_LOGS = N("activity_logs", "Activity Logs", "page", "The company-wide audit trail.", locked=SUPER_ADMIN_ONLY)

ASSISTANT_ACTIVITY = N(
    "assistant_activity",
    "Assistant Activity",
    "page",
    "What HR Assistants (and, for the Super Admin, HR Managers) did.",
    N(
        "assistant_activity.hr_assistants",
        "HR Assistants",
        "tab",
        "HR Assistants' changes.",
        locked="Super Admin and HR Managers",
    ),
    N("assistant_activity.hr_managers", "HR Managers", "tab", "HR Managers' changes.", locked=SUPER_ADMIN_ONLY),
    locked="Super Admin and HR Managers (by account type, not by role)",
)

CHAT = N("chat", "Chat", "page", "The company chat channel.")
NOTIFICATIONS = N("notifications", "Notifications", "page", "Messages from employees.")

LOGIN_DEVICES = N(
    "login_devices",
    "Login Devices",
    "page",
    "Where HR and employees are signed in.",
    N("login_devices.revoke", "Sign a device out", "feature", "End a sign-in remotely.", locked=SUPER_ADMIN_ONLY),
)

MOBILE_APP_LOGIN = N(
    "mobile_app_login",
    "Mobile App Login",
    "page",
    "The employee mobile app: logins, messages and versions.",
    N(
        "mobile_app_login.logins",
        "Login Status",
        "tab",
        "Who can sign in to the app.",
        N(
            "mobile_app_login.logins.export",
            "Export to Excel",
            "feature",
            "Download the list.",
            api=["mobile-app-logins/export"],
        ),
        N(
            "mobile_app_login.logins.password",
            "Set / reset a password",
            "feature",
            "Set, reset or clear an employee's app password.",
            apiPatterns=[r"mobile-app-logins/\d+/reset-password"],
        ),
        api=["mobile-app-logins"],
    ),
    N(
        "mobile_app_login.messages",
        "Mobile Messages",
        "tab",
        "Messages pushed to employees' phones.",
        N(
            "mobile_app_login.messages.overview",
            "Overview",
            "subtab",
            "Messages sent and read.",
            api=["mobile-app/messages/overview"],
        ),
        N("mobile_app_login.messages.controls", "Controls", "subtab", "Which messages are pushed."),
        N(
            "mobile_app_login.messages.log",
            "Messages",
            "subtab",
            "Every message sent.",
            api=["mobile-app/messages/log"],
        ),
        N("mobile_app_login.messages.devices", "Phones", "subtab", "Phones that receive messages."),
        N(
            "mobile_app_login.messages.send",
            "Send a message",
            "subtab",
            "Send a message to employees' phones.",
            api=["mobile-app/messages/send"],
        ),
        api=["mobile-app/messages"],
    ),
    N("mobile_app_login.version", "New Version", "tab", "Offer a new app version.", api=["mobile-app/versions"]),
)

WHATSAPP_CONTROL = N(
    "whatsapp_control",
    "WhatsApp Control",
    "page",
    "Every WhatsApp message the HRMS sends.",
    N(
        "whatsapp_control.overview",
        "Overview",
        "tab",
        "Messages sent, failed and waiting; the send queue.",
        api=["whatsapp-control/queue"],
    ),
    N("whatsapp_control.messages", "Messages", "tab", "Every message.", api=["whatsapp-control/messages"]),
    N(
        "whatsapp_control.employees",
        "Employees",
        "tab",
        "Per employee, and opting out.",
        api=["whatsapp-control/employees"],
    ),
    N("whatsapp_control.controls", "Feature Controls", "tab", "Which messages are sent, limits and timing."),
    N(
        "whatsapp_control.templates",
        "Message Text",
        "tab",
        "The text of each message.",
        api=["whatsapp-control/templates"],
    ),
    N("whatsapp_control.config", "Configuration", "tab", "The WhatsApp account set-up."),
)


def _sms(path: str) -> str:
    return f"/hr/sms-control/{path}"


SMS_CONTROL = N(
    "sms_control",
    "SMS Control",
    "page",
    "One-time sign-in codes by SMS.",
    N("sms_control.overview", "Overview", "tab", "Codes sent and the account balance.", routes=[_sms("overview")]),
    N(
        "sms_control.settings",
        "Settings",
        "tab",
        "How codes are sent.",
        N(
            "sms_control.settings.channel",
            "Channel",
            "subtab",
            "SMS provider and sender.",
            routes=[_sms("settings/channel")],
        ),
        N(
            "sms_control.settings.limits",
            "Limits",
            "subtab",
            "How many codes may be sent.",
            routes=[_sms("settings/limits")],
        ),
        N(
            "sms_control.settings.switches",
            "Switches",
            "subtab",
            "Which sign-ins use SMS.",
            routes=[_sms("settings/switches")],
        ),
        routes=[_sms("settings")],
        api=["sms-control/settings"],
    ),
    N(
        "sms_control.messages",
        "Messages",
        "tab",
        "Every SMS sent.",
        routes=[_sms("messages")],
        api=["sms-control/messages"],
    ),
    N("sms_control.test", "Test", "tab", "Send a test SMS.", routes=[_sms("test")], api=["sms-control/test"]),
    N("sms_control.setup", "Setup", "tab", "How to set the account up.", routes=[_sms("setup")]),
)

GMAIL_CONTROL = N(
    "gmail_control",
    "Gmail Control",
    "page",
    "Every email the HRMS sends.",
    N("gmail_control.overview", "Overview", "tab", "Emails sent and failed."),
    N("gmail_control.messages", "Messages", "tab", "Every email.", api=["gmail-control/messages"]),
    N("gmail_control.employees", "Employees", "tab", "Per employee.", api=["gmail-control/employees"]),
    N("gmail_control.controls", "Feature Controls", "tab", "Which emails are sent."),
    N(
        "gmail_control.templates",
        "Message Text",
        "tab",
        "The text of each email.",
        apiPatterns=[r"gmail-control/templates/[^/]+(/preview)?"],
    ),
    N(
        "gmail_control.config",
        "Configuration",
        "tab",
        "The mail account set-up.",
        N(
            "gmail_control.config.test_email",
            "Send a test email",
            "feature",
            "Check the mail account works.",
            api=["gmail-control/test-email"],
        ),
    ),
)

_BC = "/hr/Biometric-Connectors"
_DC = "attendance/device-control"

BIOMETRIC_CONNECTORS = N(
    "biometric_connectors",
    "Biometric Connectors",
    "section",
    "The biometric devices: their status and direct control (followed Attendance before it had its own setting).",
    N(
        "biometric_connectors.device_status",
        "Biometric Device Status",
        "page",
        "Is each device reachable and sending punches.",
        routes=[f"{_BC}/device-status"],
        api=["attendance/biometric-status"],
    ),
    N(
        "biometric_connectors.device_control",
        "Device Control",
        "page",
        "Read and change the devices directly.",
        N("biometric_connectors.device_control.overview", "Overview", "tab", "Each device at a glance."),
        N(
            "biometric_connectors.device_control.fetch",
            "Data Fetch",
            "tab",
            "Pull punches from a device.",
            routes=[f"{_BC}/DeviceControl/fetch"],
            api=[f"{_DC}/fetch"],
        ),
        N(
            "biometric_connectors.device_control.push",
            "Data Push",
            "tab",
            "Add, change and delete people on the devices.",
            routes=[f"{_BC}/DeviceControl/push"],
            api=[f"{_DC}/people", f"{_DC}/users"],
            apiPatterns=[rf"{_DC}/employees/\d+/photo"],
        ),
        N(
            "biometric_connectors.device_control.link_unlink",
            "Link / Unlink",
            "tab",
            "Which devices an employee may punch on.",
            routes=[f"{_BC}/DeviceControl/link-unlink"],
            api=[f"{_DC}/links"],
            apiPatterns=[rf"{_DC}/employees/\d+/links"],
        ),
        N(
            "biometric_connectors.device_control.connectors",
            "Site connectors",
            "tab",
            "The connector programs at the factories.",
            routes=[f"{_BC}/DeviceControl/connectors"],
            api=[f"{_DC}/connectors"],
        ),
        routes=[f"{_BC}/DeviceControl"],
        api=[_DC],
    ),
    routes=[_BC],
    inherits="attendance",
)

SETTINGS = N(
    "settings",
    "Settings",
    "section",
    "Company-wide settings, one tab each.",
    N("settings.company", "Company", "tab", "Company name, logo, address.", viewCheck=True),
    N("settings.hr_contact", "HR Contact", "tab", "Who employees call for help.", viewCheck=True),
    N("settings.themes", "Themes", "tab", "The portal's colours."),
    N(
        "settings.attendance",
        "Attendance",
        "tab",
        "How attendance is worked out.",
        N("settings.attendance.staff", "Staff", "subtab", "The staff rules.", viewCheck=True),
        N(
            "settings.attendance.production",
            "Production",
            "subtab",
            "The production shift table (read-only here).",
            api=["production-shift-config"],
        ),
        viewCheck=True,
    ),
    N(
        "settings.production_shifts",
        "Production Shifts",
        "tab",
        "The production shift ladder (followed Settings -> Attendance before it had its own setting).",
        N("settings.production_shifts.staff", "Staff", "subtab", "What it means for staff."),
        N(
            "settings.production_shifts.production",
            "Production",
            "subtab",
            "Shift groups, breaks and the Try-a-day calculator.",
        ),
        api=["production-shift-rules", "production-shift-segments"],
        inherits="settings.attendance",
    ),
    N(
        "settings.late_detection",
        "Late Detection",
        "tab",
        "What being late or taking permission costs.",
        N("settings.late_detection.staff", "Staff", "subtab", "Staff late slabs and permission rules.", viewCheck=True),
        N(
            "settings.late_detection.production",
            "Production",
            "subtab",
            "Production late rules per cycle.",
            N("settings.late_detection.production.weekly", "Weekly", "subtab", "Weekly cycle."),
            N("settings.late_detection.production.biweekly", "BiWeekly", "subtab", "BiWeekly cycle."),
            N("settings.late_detection.production.monthly", "Monthly", "subtab", "Monthly cycle."),
            viewCheck=True,
        ),
        viewCheck=True,
    ),
    N("settings.compensation", "Compensation", "tab", "OT and compensation rules."),
    N("settings.devices", "Devices", "tab", "The biometric devices and how they connect."),
    N(
        "settings.payroll",
        "Staff Payroll",
        "tab",
        "Staff payroll rules.",
        N("settings.payroll.rates", "Payroll Rules", "subtab", "Basic / HRA split, pay day.", viewCheck=True),
        N("settings.payroll.bonus", "Bonus", "subtab", "Bonus percentage and ceilings.", viewCheck=True),
        N(
            "settings.payroll.ot_compensation",
            "OT / Compensation",
            "subtab",
            "The OT / Compensation master switch.",
            viewCheck=True,
        ),
        viewCheck=True,
    ),
    N(
        "settings.production_payroll",
        "Production Payroll",
        "tab",
        "Production payroll rules.",
        N("settings.production_payroll.overview", "Overview", "subtab", "The cycles at a glance."),
        N("settings.production_payroll.weekly", "Weekly", "subtab", "When weekly periods start.", viewCheck=True),
        N(
            "settings.production_payroll.biweekly",
            "BiWeekly",
            "subtab",
            "When fortnightly periods start.",
            viewCheck=True,
        ),
        N("settings.production_payroll.monthly", "Monthly", "subtab", "When monthly periods start.", viewCheck=True),
        N(
            "settings.production_payroll.pay_bonus",
            "Pay & Bonus",
            "subtab",
            "Salary per shift and the production bonus.",
            viewCheck=True,
        ),
        viewCheck=True,
    ),
    N(
        "settings.pf_esi",
        "PF & ESI",
        "tab",
        "PF / ESI rates (only the Super Admin changes them; followed Settings -> Staff Payroll before).",
        N("settings.pf_esi.staff", "Staff", "subtab", "Staff PF / ESI."),
        N("settings.pf_esi.production", "Production", "subtab", "Production PF / ESI."),
        inherits="settings.payroll",
    ),
    N("settings.salary_slip", "Salary Slip", "tab", "What the payslip shows.", viewCheck=True),
    N(
        "settings.documents",
        "Company Documents",
        "tab",
        "The letters the HRMS prints.",
        N(
            "settings.documents.offer_letter",
            "Offer Letter",
            "subtab",
            "The offer letter.",
            api=["document-settings/offer_letter"],
        ),
        N(
            "settings.documents.experience_letter",
            "Experience Letter",
            "subtab",
            "The experience letter.",
            api=["document-settings/experience_letter"],
        ),
        N(
            "settings.documents.salary_slip",
            "Salary Slip",
            "subtab",
            "The payslip layout.",
            api=["document-settings/salary_slip"],
        ),
        N(
            "settings.documents.resignation_letter",
            "Resignation Letter",
            "subtab",
            "The resignation letter.",
            api=["document-settings/resignation_letter"],
        ),
    ),
    N(
        "settings.idcard",
        "ID Card",
        "tab",
        "The ID card layout (followed the ID Cards page before it had its own setting).",
        api=["idcard-settings"],
        inherits="id_cards",
    ),
    N("settings.smtp", "SMTP / Email", "tab", "The mail server.", viewCheck=True),
    N("settings.whatsapp", "WhatsApp", "tab", "Points to WhatsApp Control."),
    N(
        "settings.endpoint_sharing",
        "Endpoint Sharing",
        "tab",
        "Data shared with other systems by API key.",
        locked=SUPER_ADMIN_ONLY,
    ),
    N(
        "settings.backup",
        "Backup",
        "tab",
        "Database backups.",
        N("settings.backup.schedule", "Schedule", "feature", "When backups run.", api=["backup/schedule"]),
        N(
            "settings.backup.drive",
            "Google Drive copy",
            "feature",
            "Copy backups to Google Drive.",
            api=["backup/drive"],
        ),
        N(
            "settings.backup.restore",
            "Restore",
            "feature",
            "Check a backup file (only the Super Admin can restore one).",
            api=["backup/restore"],
        ),
        viewCheck=True,
    ),
)

GROUPS: list[dict] = [
    {"id": "main", "label": "Main", "children": [DASHBOARD, EMPLOYEES, ATTENDANCE, GEO, GATE]},
    {
        "id": "hr_operations",
        "label": "HR Operations",
        "children": [SHIFTS, LEAVE, CASUAL_LEAVE, REQUESTS, PROMOTION, INCREMENT, BONUS, ID_CARDS],
    },
    {
        "id": "payroll",
        "label": "Payroll",
        "children": [STAFF_PAYROLL, PRODUCTION_PAYROLL, COMPENSATION, SETTLEMENT, REPORTS],
    },
    {"id": "recruitment", "label": "Recruitment", "children": [RECRUITMENT]},
    {
        "id": "administration",
        "label": "Administration",
        "children": [
            ACCOUNT_MANAGEMENT,
            USER_MANAGEMENT,
            ACTIVITY_LOGS,
            ASSISTANT_ACTIVITY,
            CHAT,
            NOTIFICATIONS,
            LOGIN_DEVICES,
            MOBILE_APP_LOGIN,
            WHATSAPP_CONTROL,
            SMS_CONTROL,
            GMAIL_CONTROL,
            BIOMETRIC_CONNECTORS,
            SETTINGS,
        ],
    },
]


# ───────────────────────────── reading the tree ─────────────────────────────


def iter_display(nodes=None, depth: int = 0, parent: dict | None = None):
    """(node, depth, display parent) for every node, in the editor's order (groups not included)."""
    if nodes is None:
        for group in GROUPS:
            yield from iter_display(group["children"], 0, None)
        return
    for node in nodes:
        yield node, depth, parent
        yield from iter_display(node.get("children", []), depth + 1, node)


def is_locked(node: dict, parent_locked: bool = False) -> bool:
    return bool(node.get("locked")) or parent_locked


def grantable_nodes() -> list[dict]:
    """Every node a role can be given a level on (locked ones and everything under them left out), in display order."""
    out: list[dict] = []

    def walk(nodes, locked):
        for node in nodes:
            here = locked or bool(node.get("locked"))
            if not here:
                out.append(node)
            walk(node.get("children", []), here)

    for group in GROUPS:
        walk(group["children"], False)
    return out


def locked_nodes() -> list[dict]:
    grantable = {n["key"] for n in grantable_nodes()}
    return [n for n, _d, _p in iter_display() if n["key"] not in grantable]


def build_key_tree() -> list[dict]:
    """The tree by KEY (a dotted key under its dotted parent; "own" keys at the top), as MODULE_TREE has always been:
    [{"key", "label", "children": [...]}]. Only grantable keys."""
    nodes = grantable_nodes()
    by_key = {n["key"]: {"key": n["key"], "label": n["label"]} for n in nodes}
    roots: list[dict] = []
    for n in nodes:
        item = by_key[n["key"]]
        parent_key = n["key"].rpartition(".")[0]
        if parent_key:
            if parent_key not in by_key:
                raise ValueError(f"{n['key']}: its parent {parent_key} is not in the tree")
            by_key[parent_key].setdefault("children", []).append(item)
        else:
            roots.append(item)
    return roots


def inherits_map() -> dict[str, str]:
    return {n["key"]: n["inherits"] for n in grantable_nodes() if n.get("inherits")}


def view_checked_keys() -> frozenset[str]:
    return frozenset(n["key"] for n in grantable_nodes() if n.get("viewCheck"))


def url_entries() -> dict[str, str]:
    """{api prefix: key} from the tree (permission_registry merges it into URL_MODULE_MAP)."""
    out: dict[str, str] = {}
    for n in grantable_nodes():
        for prefix in n.get("api", ()):
            if prefix in out and out[prefix] != n["key"]:
                raise ValueError(f"API prefix {prefix} is claimed by {out[prefix]} and {n['key']}")
            out[prefix] = n["key"]
    return out


def url_patterns() -> list[tuple[re.Pattern, str]]:
    out = []
    for n in grantable_nodes():
        for pattern in n.get("apiPatterns", ()):
            out.append((re.compile(pattern), n["key"]))
    return out


def own_api_keys() -> frozenset[str]:
    """Keys that guard an API path themselves (a URL prefix or pattern of their own, or a check inside the view)."""
    from .permission_registry import URL_MODULE_MAP, URL_PATTERNS  # (imports this module)

    keys = set(URL_MODULE_MAP.values()) | {key for _pattern, key in URL_PATTERNS} | set(view_checked_keys())
    return frozenset(keys)


def server_enforced_keys() -> frozenset[str]:
    """Keys whose Hidden / View the server enforces: the key guards API paths itself, or one of its parts does (a part
    with no setting follows it, so hiding the key hides them on the server too). Every other key is "screen only"."""
    own = own_api_keys()
    keys = [n["key"] for n in grantable_nodes()]
    return frozenset(k for k in keys if k in own or any(o.startswith(k + ".") for o in own))


# ───────────────────────────── the portal's copy ─────────────────────────────

FRONTEND_JSON = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "permission-tree.json"


def export_tree() -> dict:
    """What the HR portal reads (frontend/src/lib/permission-tree.json): the display tree with everything the screens
    need, and the approval kinds (hr_access.APPROVAL_KINDS)."""
    from .hr_access import APPROVAL_GROUPS, APPROVAL_KINDS, ASSISTANT_LOCKED, INFO_KINDS

    own = own_api_keys()
    enforced = server_enforced_keys()

    def clean(node: dict) -> dict:
        out = {k: v for k, v in node.items() if k not in ("api", "apiPatterns", "children", "viewCheck")}
        if not node.get("locked"):
            # "server": it guards API calls itself; "parts": only its parts do; "screen": Hidden only hides it on screen
            key = node["key"]
            out["enforce"] = "server" if key in own else "parts" if key in enforced else "screen"
        if node.get("children"):
            out["children"] = [clean(c) for c in node["children"]]
        return out

    return {
        "groups": [{"id": g["id"], "label": g["label"], "children": [clean(c) for c in g["children"]]} for g in GROUPS],
        "approvals": [k.to_json() for k in APPROVAL_KINDS],
        "approvalGroups": list(APPROVAL_GROUPS),
        "approvalInfo": [dict(i) for i in INFO_KINDS],
        "assistantLocked": dict(ASSISTANT_LOCKED),
    }


def write_json(path: Path = FRONTEND_JSON) -> None:
    """Writes the portal's copy. Run from backend/: py -3 -c "from api.permission_tree import write_json; write_json()"
    then format it: node node_modules/prettier/bin/prettier.cjs --write src/lib/permission-tree.json (in frontend/)."""
    text = json.dumps(export_tree(), indent=2, ensure_ascii=False) + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
