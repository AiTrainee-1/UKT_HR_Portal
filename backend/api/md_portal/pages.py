"""The MD portal's pages. One list, used by the sidebar contract (/api/md/me) and by the assistant, which may only
suggest a page that is in it (so "you can see this on the Payroll Analysis page" always points somewhere real).

Keep it in step with frontend/src/components/md/md-nav.ts (the frontend mirror: titles, paths and order)."""

MD_PAGES: list[dict] = [
    {
        "id": "dashboard",
        "title": "Dashboard",
        "path": "/md/dashboard",
        "summary": "The company at a glance: headcount, today's attendance, payroll cost, hiring and exits, and what needs attention.",
    },
    {
        "id": "attendance",
        "title": "Attendance Analytics",
        "path": "/md/attendance",
        "summary": "Attendance, absenteeism, lateness and overtime over any period, by unit, department and day of week.",
    },
    {
        "id": "employees",
        "title": "Employees",
        "path": "/md/employees",
        "summary": "Workforce composition, tenure, movement (joiners and leavers), attrition and a searchable people directory.",
    },
    {
        "id": "visitors",
        "title": "Outpass & Visitors",
        "path": "/md/visitors",
        "summary": "Visitors and employee outpasses: volumes, purposes, time out, approvals and exceptions (visitors have no check-out, so who is inside now cannot be shown).",
    },
    {
        "id": "tea-break",
        "title": "Tea Break",
        "path": "/md/tea-break",
        "summary": "Tea-break discipline: overruns, minutes lost, by department and shift.",
    },
    {
        "id": "payroll",
        "title": "Payroll Analysis",
        "path": "/md/payroll",
        "summary": "Payroll cost and its trend, what changed against last month and why, cost by department and unit, overtime.",
    },
    {
        "id": "reports",
        "title": "Reports",
        "path": "/md/reports",
        "summary": "Executive reports and the full report library, ready to view, print or export.",
    },
    {
        "id": "recruitment",
        "title": "Recruitment",
        "path": "/md/recruitment",
        "summary": "Open positions, the hiring funnel, new joinees, resignations and attrition.",
    },
    {
        "id": "activity",
        "title": "Activity Logs",
        "path": "/md/activity",
        "summary": "What people did in the system: volume, sensitive actions, unusual hours and sign-ins.",
    },
]

PAGE_BY_ID = {p["id"]: p for p in MD_PAGES}
PAGE_IDS = tuple(PAGE_BY_ID)
