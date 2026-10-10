"""The MD portal's pages. One list, used by the sidebar contract (/api/md/me) and by the assistant, which may only
suggest a page that is in it (so "you can see this on the Payroll Analysis page" always points somewhere real).

Keep it in step with frontend/src/components/md/md-nav.ts (the frontend mirror: titles, paths and order).

`domain` names the analytics module (api/md_portal/analytics/<domain>.py) behind a page's insights: its headline figures
and exceptions (`headline()` and `insights()`, see md-portal.md section 3) are what /api/md/brief/<page> serves. Several
pages can share one domain (Outpass and Visitors both read the visitors analytics). Most pages are the HR portal's own page
with the MD's Insights added (md-portal.md section 10); Payroll, Reports, Recruitment and Activity Logs are analytics pages."""

MD_PAGES: list[dict] = [
    {
        "id": "dashboard",
        "title": "Dashboard",
        "path": "/md/dashboard",
        "summary": "The HR dashboard with the company's exceptions on top: headcount, today's attendance, payroll cost, hiring and exits, and what needs attention.",
        "domain": "dashboard",
    },
    {
        "id": "employees",
        "title": "Employees",
        "path": "/md/employees",
        "summary": "The employee list and records (add, edit, import) with workforce composition, tenure, movement (joiners and leavers) and attrition.",
        "domain": "employees",
    },
    {
        "id": "branches",
        "title": "Branches",
        "path": "/md/branches",
        "summary": "The company's branches / units with a side-by-side comparison of headcount, attendance, lateness and overtime per unit.",
        "domain": "units",
    },
    {
        "id": "attendance",
        "title": "Staff Attendance",
        "path": "/md/attendance/staff",
        "summary": "Staff attendance as HR sees it (punches, corrections, sync) with attendance, absenteeism, lateness and overtime by unit, department and day of week.",
        "domain": "attendance",
    },
    {
        "id": "attendance-production",
        "title": "Production Attendance",
        "path": "/md/attendance/production",
        "summary": "Production attendance as HR sees it (shifts, punches, corrections) with the same attendance analytics for production staff.",
        "domain": "attendance",
    },
    {
        "id": "geo-attendance",
        "title": "Geo Attendance",
        "path": "/md/geo-attendance",
        "summary": "On-duty (geo) sessions and their verification, with volumes, coverage and who is working outside the premises.",
        "domain": "geo",
    },
    {
        "id": "attendance-search",
        "title": "Attendance Search",
        "path": "/md/attendance/search",
        "summary": "Search an employee's punches and monthly attendance, with how punches arrive (biometric, manual, geo) and where records are missing.",
        "domain": "punches",
    },
    {
        "id": "report-log",
        "title": "Report Log",
        "path": "/md/attendance/report-log",
        "summary": "The attendance report log with how often and by whom attendance reports are produced.",
        "domain": "reportlog",
    },
    {
        "id": "outpass",
        "title": "Outpass",
        "path": "/md/outpass-visitors/outpass",
        "summary": "Employee outpasses as HR sees them (requests, approvals, QR) with volumes, hours lost, repeat users and approvals waiting too long.",
        "domain": "visitors",
    },
    {
        "id": "visitors",
        "title": "Visitors",
        "path": "/md/outpass-visitors/visitors",
        "summary": "Visitors as HR sees them (passes, QR, records) with volumes, purposes and exceptions (visitors have no check-out, so who is inside now cannot be shown).",
        "domain": "visitors",
    },
    {
        "id": "tea-break",
        "title": "Tea Break",
        "path": "/md/outpass-visitors/tea-break",
        "summary": "Tea-break records with discipline analytics: overruns, minutes lost, by department and shift.",
        "domain": "tea_break",
    },
    {
        "id": "shifts",
        "title": "Manage Shift",
        "path": "/md/shifts",
        "summary": "Shifts and who is assigned to them, with coverage by shift and department and employees without a shift.",
        "domain": "shifts",
    },
    {
        "id": "leave",
        "title": "Leave & Holiday",
        "path": "/md/leave",
        "summary": "Leave requests, balances and the holiday calendar, with leave taken by type and department, trends and who is out.",
        "domain": "leave",
    },
    {
        "id": "requests",
        "title": "Requests",
        "path": "/md/requests",
        "summary": "Every request waiting for a decision (leave, permission, outpass, advance, missing punch) with how long they wait and how fast they are decided.",
        "domain": "requests",
    },
    {
        "id": "payroll",
        "title": "Payroll Analysis",
        "path": "/md/payroll",
        "summary": "Payroll cost and its trend, what changed against last month and why, cost by department and unit, overtime.",
        "domain": "payroll",
    },
    {
        "id": "reports",
        "title": "Reports",
        "path": "/md/reports",
        "summary": "Executive reports and the full report library, ready to view, print or export.",
        "domain": None,
    },
    {
        "id": "recruitment",
        "title": "Recruitment",
        "path": "/md/recruitment",
        "summary": "Open positions, the hiring funnel, new joinees, resignations and attrition.",
        "domain": "recruitment",
    },
    {
        "id": "activity",
        "title": "Activity Logs",
        "path": "/md/activity",
        "summary": "What people did in the system: volume, sensitive actions, unusual hours and sign-ins.",
        "domain": "activity",
    },
]

PAGE_BY_ID = {p["id"]: p for p in MD_PAGES}
PAGE_IDS = tuple(PAGE_BY_ID)
