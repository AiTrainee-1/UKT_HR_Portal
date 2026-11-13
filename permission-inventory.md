# HR portal permission inventory

Every page, tab, sub-tab, feature and approval in the HR portal (`/hr/...`), with the permission key that controls it in
**Account Management -> Roles & Permissions** (and in each HR Manager / HR Assistant account's own changes).

Written 2026-11-11 from a full audit of `frontend/src/App.tsx`, every HR page and its tabs, the sidebar, the API client and
the Django URL list (592 API paths). The tables below are generated from the permission tree itself
(`backend/api/permission_tree.py`), so they always match what the code enforces.

## Counts

| | Before (2026-11-10) | After |
|---|---|---|
| Keys a role can be given a level on | 55 | 325 |
| - sections / pages | 31 top-level + 9 sub-pages | 9 sections, 60 pages |
| - tabs and views | 14 (Settings tabs) + 1 (Approval Workflow Control) | 120 |
| - sub-tabs | 0 | 92 |
| - features | 0 | 44 |
| Listed but locked (Super Admin / MD / HR Manager by account type) | 0 shown | 15 |
| Keys the server enforces itself (own API or view check) | 55 of 55 mapped or checked | 190 |
| Keys that are screen only | 0 | 127 |
| Approval switches | 11 (one 'Other requests', one 'Advance') | 27 (+1 listed without a switch) |


## How to read the tables

- **Key**: what is stored in a role. A key with no setting of its own *follows* its parent (the row above it): give
  "Staff Payroll" Edit and every tab under it is Edit, unless a tab is set on its own. Nothing set at all = Hidden.
- **Enforced**
  - **Server**: the API refuses the calls of a Hidden part (403) and every change of a View-only part.
  - **Server (view check)**: the API view checks the key itself (a settings field group, a Requests kind, a report group).
  - **Server (through its parts)**: it has no API path of its own, but hiding it hides its parts, and they are enforced.
  - **Screen only**: it shares its API with its page (same path, only a query parameter differs, or the data is read by
    several tabs at once). Hidden removes it from the portal and View locks its buttons, but the server still answers the
    page's calls. The **API** column says what it shares.
  - **Locked**: listed so nothing is missing, but it cannot be given to a role: who may use it is fixed (the Super Admin,
    the master administrator, the Managing Director, or HR Managers by account type).
- **Notes**: "follows X until set" = the part was governed by another key before it had its own (so every existing role
  keeps exactly its access); "own setting" = an older key shown under the page it belongs to; "existing key" = the key
  existed before 2026-11-11.

## Out of scope

- **The Managing Director's portal (`/md/*`)**: only the account flagged as the MD opens it, whatever its role
  (`auth.require_md`, the middleware's `md/` lock, `ProtectedRoute`). Its copies of the HR pages use the MD's working
  access (`permission_registry.MD_HR_GRANTS`, `MD_VIEW_ONLY`), not a role. Not role-controlled, so not in the tree.
- **The Employee portal, the mobile app, Department Head (HOD) screens, gate scanners and reception desks**: they sign in
  with employee, HOD or device tokens, never an HR role.

## The tree

### Main

| Page / tab / sub-tab | Type | Key | Address | API | Enforced | Notes |
|---|---|---|---|---|---|---|
| Dashboard | Page | `dashboard` | - | dashboard | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Key figures | Feature | `dashboard.key_figures` | - | shares: dashboard/hr-summary (shared by several cards), attendance/summary, permissions, advances | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Today's attendance and daily trend | Feature | `dashboard.attendance` | - | shares: attendance/summary, attendance/monthly-trend (Attendance module) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Salary cost, last 12 months | Feature | `dashboard.salary_cost` | - | dashboard/salary-trends | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Headcount and workforce | Feature | `dashboard.headcount` | - | shares: departments, dashboard/hr-summary | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Pending actions | Feature | `dashboard.pending_actions` | - | shares: dashboard/hr-summary, permissions, missing-punch-requests, casual-leaves, advances | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Upcoming holidays | Feature | `dashboard.holidays` | - | shares: holidays (readable by every HR login) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Geo Attendance today | Feature | `dashboard.geo` | - | shares: dashboard/hr-summary | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Recruitment and documents | Feature | `dashboard.recruitment` | - | shares: dashboard/hr-summary, recruitment/resume-screening/candidates, recruitment/employee-documents/completion-stats | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Activity summary | Feature | `dashboard.activity` | - | shares: audit-logs/stats (readable by every HR login) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Auto Sync button | Feature | `dashboard.auto_sync` | - | shares: attendance/sync-biometric (Attendance -> Sync from devices) | Screen only |  |
| Employees | Section | `employees` | - | employees | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ All Employees - Staff | Tab | `employees.staff` | - | shares: employees?employmentType=staff (the list call, a query parameter) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ All Employees - Production | Tab | `employees.production` | - | shares: employees?employmentType=production | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ All Employees - Co Emp | Tab | `employees.co_emp` | - | pf-esi/coverage | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ TDS | Sub-tab | `employees.co_emp.tds` | - | tds | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Activate / deactivate an employee | Feature | `employees.status` | - | employees/<id>/status | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Employee profile | Page | `employees.profile` | /hr/employees/<id> | shares: employees/<id> (also the edit form's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Salary and salary history | Feature | `employees.profile.salary` | - | shares: employees/<id>, salary-records (Salary key) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Bank and statutory details | Feature | `employees.profile.bank` | - | shares: employees/<id> | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Uploaded documents | Feature | `employees.profile.documents` | - | shares: recruitment/employee-documents/<id>, employee-documents/<id>/file | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ ID card | Feature | `employees.profile.id_card` | - | shares: idcard?ids=<id> (ID Cards key) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Offer and experience letters | Feature | `employees.letters` | - | employees/<id>/(offer\|experience)-letter(/.*)? | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Add employee | Page | `employees.add` | /hr/employees/new | shares: POST employees (same path as the list) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Edit employee | Page | `employees.edit` | /hr/employees/<id>/edit | shares: employees/<id> (same path as the profile) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Bulk upload | Page | `employees.bulk_upload` | /hr/employees/bulk-upload | employees/bulk-update | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Add new employees | Tab | `employees.bulk_upload.add` | - | employees/bulk-upload | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Active employees | Tab | `employees.bulk_upload.active` | - | shares: employees/bulk-update (also the Inactive tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Inactive employees | Tab | `employees.bulk_upload.inactive` | - | shares: employees/bulk-update (also the Active tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Production Employees | Page | `employees.production_employees` | /hr/employees/productionEmployee | employees/production | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Departments | Page | `employees.departments` | - | departments | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Departments | Tab | `employees.departments.list` | - | shares: departments/overview, departments (the page's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Find & assign employees | Tab | `employees.departments.find` | - | shares: employees?search=, PATCH employees/<id> | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Find employee | Sub-tab | `employees.departments.find.search` | - | shares: employees?search= | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Unassigned | Sub-tab | `employees.departments.find.unassigned` | - | shares: employees?status=active | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Designations | Page | `employees.designations` | - | designations | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Structure | Tab | `employees.designations.structure` | - | shares: designations/tree, designations (the page's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Find & assign employees | Tab | `employees.designations.find` | - | shares: employees?search=, PATCH employees/<id> | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Find employee | Sub-tab | `employees.designations.find.search` | - | shares: employees?search= | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Unassigned | Sub-tab | `employees.designations.find.unassigned` | - | shares: employees?status=active | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Manage Branch | Page | `employees.branches` | - | branches | Server | existing key |
| Attendance | Section | `attendance` | - | attendance, attendance-logs, biometric/punch, session-configs, work-sessions | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Staff Attendance | Page | `attendance.staff` | /hr/attendance/staff | shares: attendance/summary, attendance/daily, attendance/monthly-trend with employmentType=staff | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Production Attendance | Page | `attendance.production` | /hr/attendance/production | shares: the same calls with employmentType=production | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Employee attendance search | Feature | `attendance.employee_search` | - | attendance/employee-monthly, attendance/employee-punches | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Add attendance by hand | Feature | `attendance.add_manual` | - | attendance/manual | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Skipped punches | Feature | `attendance.skipped_punches` | - | attendance/skipped-punches | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Sync from devices and Auto Sync rules | Feature | `attendance.sync` | - | attendance/sync-biometric, attendance/sync-biometric-progress, auto-sync-rules | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Attendance Search | Page | `attendance.search` | /hr/attendance/search | attendance/search | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Report Log | Page | `attendance.report_log` | /hr/attendance/report-log | attendance/report-log | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Monthly Report | Tab | `attendance.report_log.monthly` | - | attendance/late-summary, attendance/report-log/sheet | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Daily Leave Report | Tab | `attendance.report_log.leave` | - | attendance/day-informed | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Daily Late Report | Tab | `attendance.report_log.late` | - | shares: attendance/report-log (also the Daily Leave Report's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Punch View | Page | `attendance.punch_view` | /hr/attendance/punch-view | attendance/punches | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Punch View history | Page | `attendance.punch_view.history` | /hr/attendance/punch-view/history | attendance/punches/history | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Export to Excel | Feature | `attendance.punch_view.export` | - | attendance/punches/export | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Upload an edited file | Feature | `attendance.punch_view.upload` | - | attendance/punches/import | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Set a day's status | Feature | `attendance.punch_view.day_status` | - | attendance/punches/day-status | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Manual punch import | Page | `attendance.manual_import` | /hr/attendance/manual-import | attendance/manual-import | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Edit a day's attendance | Page | `attendance.edit` | /hr/attendance/edit | attendance/edit-context, attendance/override | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Missing Punch | Page | `missing_punch` | - | missing-punch-requests | Server | own setting (key existed before); existing key |
| Geo Attendance | Section | `geo_attendance` | - | live-location/team/<id>/route | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ On-Duty Approvals | Tab | `geo_attendance.approvals` | /hr/geo-attendance/approvals | on-duty-sessions | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Punch Verifications | Tab | `geo_attendance.verifications` | /hr/geo-attendance/verifications | on-duty-punch-verifications, on-duty-sessions/<id>/punches | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Live Map | Tab | `geo_attendance.live_map` | /hr/geo-attendance/live-map | live-location/team, tracking/live | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Journey History | Tab | `geo_attendance.journeys` | /hr/geo-attendance/journeys | tracking/journeys | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Simulate a journey | Sub-tab | `geo_attendance.journeys.simulate` | /hr/geo-attendance/journeys/<id>/simulate | shares: tracking/journeys/<id>, /trail (also the journey page's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Export a journey | Feature | `geo_attendance.journeys.export` | - | tracking/journeys/<id>/export | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ On-Duty Map | Tab | `geo_attendance.on_duty_map` | /hr/geo-attendance/on-duty-map | on-duty-map, tracking/journeys/day-map | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ All On-Duty | Sub-tab | `geo_attendance.on_duty_map.all` | - | shares: on-duty-map, tracking/journeys/day-map (the tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Single employee | Sub-tab | `geo_attendance.on_duty_map.single` | - | shares: live-location/team/<id>/route (also Punch Verifications') | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Tracking Settings | Tab | `geo_attendance.settings` | /hr/geo-attendance/settings | shares: employees (tracking switch), tracking/settings (Settings -> Attendance) | Screen only |  |
| Outpass / Visitors | Section | `outpass_visitors` | - | its parts' calls | Server (through its parts) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Outpass | Page | `outpass_visitors.outpass` | /hr/outpass-visitors/outpass | outpass/summary | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Overview | Tab | `outpass_visitors.outpass.overview` | /hr/outpass-visitors/outpass/overview | outpass/qr, outpass/records | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Passes | Sub-tab | `outpass_visitors.outpass.overview.passes` | /hr/outpass-visitors/outpass/overview/passes | shares: outpass-requests (the Requests page's module) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Gate QR submissions | Sub-tab | `outpass_visitors.outpass.overview.qr_submissions` | /hr/outpass-visitors/outpass/overview/qr-submissions | shares: outpass/records (also the Overview's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Requests | Tab | `outpass_visitors.outpass.requests` | /hr/outpass-visitors/outpass/requests | shares: outpass-requests (the Requests page's module) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ In/Out | Tab | `outpass_visitors.outpass.in_out` | /hr/outpass-visitors/outpass/in-out | shares: outpass-requests (the Requests page's module) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Gate scanner devices | Feature | `outpass_visitors.outpass.gate_devices` | - | gate-devices | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Visitors | Page | `outpass_visitors.visitors` | /hr/outpass-visitors/visitors | visitor/qr, visitor/records, visitor/summary | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Reception desk devices | Feature | `outpass_visitors.visitors.reception_devices` | - | reception-devices | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Tea Break | Page | `outpass_visitors.tea_break` | /hr/outpass-visitors/tea-break | tea-break, tea-break/summary | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Records | Tab | `outpass_visitors.tea_break.records` | /hr/outpass-visitors/tea-break/records | tea-break/records | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Rule | Tab | `outpass_visitors.tea_break.rule` | /hr/outpass-visitors/tea-break/rule | tea-break/rule | Server |  |

### HR Operations

| Page / tab / sub-tab | Type | Key | Address | API | Enforced | Notes |
|---|---|---|---|---|---|---|
| Manage Shift | Page | `shifts` | - | shift-assignments, shifts | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Shifts | Tab | `shifts.shifts` | - | shares: shifts (read by every tab of the page) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Assigned | Tab | `shifts.assignments` | - | shift-assignments/end | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Unassigned | Tab | `shifts.unassigned` | - | shares: employees, shift-assignments (read by every tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Assign employees to a shift | Feature | `shifts.assign` | - | shift-assignments/apply, shift-assignments/bulk, shift-assignments/plan | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Assign production staff with no shift | Feature | `shifts.sync_production` | - | shift-assignments/sync-production | Server |  |
| Leave & Holiday | Page | `leave` | - | leave-requests | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Leave Requests | Tab | `leave.requests` | - | shares: leave-requests (also Half-Day and Calendar) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Half-Day Leave | Tab | `leave.half_day` | - | shares: leave-requests (also Leave Requests and Calendar) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Permissions | Tab | `leave.permissions` | - | shares: permissions (the Requests page's module) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Calendar | Tab | `leave.calendar` | - | shares: leave-requests, casual-leaves, holidays | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Holidays | Tab | `leave.holidays` | - | holidays | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Balances | Tab | `leave.balances` | - | leave-balances, leave-types | Server |  |
| Casual Leave | Page | `casual_leave` | - | casual-leaves | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Taken this month | Tab | `casual_leave.taken` | - | shares: casual-leaves (also Requests) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Eligible | Tab | `casual_leave.eligible` | - | shares: casual-leaves/eligibility (also Not eligible and Carry Forward), POST casual-leaves | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Not eligible | Tab | `casual_leave.not_eligible` | - | shares: casual-leaves/eligibility | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Requests | Tab | `casual_leave.requests` | - | shares: casual-leaves (also Taken) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Carry Forward | Tab | `casual_leave.carry_forward` | - | its parts' calls | Server (through its parts) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Balances | Sub-tab | `casual_leave.carry_forward.balances` | - | casual-leaves/absent-dates, casual-leaves/assign | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Change log | Sub-tab | `casual_leave.carry_forward.log` | - | casual-leaves/adjustments | Server |  |
| Requests | Page | `requests` | - | employee-requests, outpass-requests, permissions | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Requests | Tab | `requests.list` | - | hr-requests | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Leave | Sub-tab | `requests.list.leave` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Permission | Sub-tab | `requests.list.permission` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Casual Leave | Sub-tab | `requests.list.casual_leave` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Missing Punch | Sub-tab | `requests.list.missing_punch` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ On-Duty | Sub-tab | `requests.list.on_duty` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ On-Duty punches | Sub-tab | `requests.list.on_duty_punch` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Outpass | Sub-tab | `requests.list.outpass` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Other requests | Sub-tab | `requests.list.request` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Attendance correction | Sub-tab | `requests.list.attendance_correction` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Holiday / Sunday work | Sub-tab | `requests.list.holiday_work` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Resignation | Sub-tab | `requests.list.resignation` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Advance | Sub-tab | `requests.list.advance` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ HoD's | Tab | `requests.hods` | - | hr/hod-pending | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Notify | Tab | `requests.notify` | - | hr/hod-reminders | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Send reminders now | Feature | `requests.notify.send` | - | hr/hod-reminders/send | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Run history | Feature | `requests.notify.history` | - | hr/hod-reminders/runs | Server |  |
| Promotion | Page | `promotion` | - | promotions | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Promote | Tab | `promotion.promote` | - | shares: promotions (POST on the list path) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ History | Tab | `promotion.history` | - | shares: promotions | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Due for review | Tab | `promotion.due` | - | shares: promotions, employees | Screen only |  |
| Increment | Page | `increment` | - | increments | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Apply increment | Tab | `increment.apply` | - | increments/summary | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ History | Tab | `increment.history` | - | shares: increments/history (read by every tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Due for increment | Tab | `increment.due` | - | shares: increments/history, employees | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Insights | Tab | `increment.insights` | - | shares: increments/history | Screen only |  |
| Bonus | Page | `bonus` | - | bonus | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Generate the register | Feature | `bonus.generate` | - | bonus/generate | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Export | Feature | `bonus.export` | - | bonus/export | Server |  |
| ID Cards | Page | `id_cards` | - | idcard, verify-employee | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Email / WhatsApp ID cards | Feature | `id_cards.send` | - | idcard/email, idcard/whatsapp | Server |  |

### Payroll

| Page / tab / sub-tab | Type | Key | Address | API | Enforced | Notes |
|---|---|---|---|---|---|---|
| Staff Payroll | Page | `payroll` | - | payroll | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payroll - Records | View | `payroll.records` | - | shares: payroll (the month list, also the Salary tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payroll - Issues | View | `payroll.issues` | - | payroll/issues | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payroll - Skipped | View | `payroll.skipped` | - | payroll/month-skipped | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payroll - Rules | View | `payroll.rules` | - | payroll/rules | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Generate payroll | Feature | `payroll.generate` | - | payroll/generate, payroll/generate-progress | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Salary statement and bank file | Feature | `payroll.exports` | - | shares: reports/export/hr-salary-statement (Reports key) and a file made in the browser | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Adjust bonus / deductions | Feature | `payroll.adjust` | - | shares: PATCH payroll/<id> (also Mark as Cleared) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payroll details | Page | `payroll.details` | /hr/payroll/details | payroll/<id>/details | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Salary | Tab | `salary` | - | salary-records | Server | own setting (key existed before); existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payslip | Tab | `salary_slip` | - | salary-slips | Server | own setting (key existed before); existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Email / WhatsApp payslips | Feature | `salary_slip.send` | - | salary-slips/<id>/(email\|whatsapp), salary-slips/bulk-email, salary-slips/bulk-progress, salary-slips/bulk-whatsapp, salary-slips/bulk-whatsapp-progress | Server |  |
| Production Payroll | Section | `production_payroll` | - | payroll/production | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Weekly | Page | `production_payroll.weekly` | /hr/production-payroll/weekly | shares: payroll/production?cycle=weekly (a query parameter) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ BiWeekly | Page | `production_payroll.biweekly` | /hr/production-payroll/biweekly | shares: payroll/production?cycle=biweekly | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Monthly | Page | `production_payroll.monthly` | /hr/production-payroll/monthly | shares: payroll/production?cycle=monthly | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payroll tab (every cycle) | Tab | `production_payroll.payroll` | - | shares: payroll/production, period-status, issues, rules | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Records | View | `production_payroll.payroll.records` | - | shares: payroll/production | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Issues | View | `production_payroll.payroll.issues` | - | shares: payroll/production/issues (also the Employees tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Skipped | View | `production_payroll.payroll.skipped` | - | shares: payroll/production/period-status (also the Employees tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Rules | View | `production_payroll.payroll.rules` | - | shares: payroll/production/rules (also the Employees tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Employees tab (every cycle) | Tab | `production_payroll.employees` | - | shares: period-status, issues, rules (also the Payroll tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Salary tab (every cycle) | Tab | `production_payroll.salary` | - | payroll/production/salary-statement | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payslip tab (every cycle) | Tab | `production_payroll.payslip` | - | shares: salary-slips (Staff Payroll -> Payslip key) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Generate payroll | Feature | `production_payroll.generate` | - | payroll/production/generate, payroll/production/skip-check | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payroll details | Page | `production_payroll.details` | /hr/production-payroll/details | payroll/production/<id>/details | Server |  |
| Compensation | Section | `compensation` | - | compensation | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ CTC Breakdown | Page | `compensation.ctc` | /hr/compensation/ctc-breakdown | shares: GET compensation (the module's root path) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ OT Detection | Page | `compensation.ot` | /hr/compensation/ot-detection | compensation/ot | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Type 1 - Late-in allowance | Sub-tab | `compensation.ot.type1` | /hr/compensation/ot-detection/type-1 | shares: compensation/ot (the page's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Late-in allowance | Sub-tab | `compensation.ot.type1.allowance` | /hr/compensation/ot-detection/type-1/allowance | shares: compensation/ot | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ How it is worked out | Sub-tab | `compensation.ot.type1.how` | /hr/compensation/ot-detection/type-1/how | shares: compensation/config | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Type 2 - Shift compensation | Sub-tab | `compensation.ot.type2` | /hr/compensation/ot-detection/type-2 | compensation/ot/assign | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Waiting for HR | Sub-tab | `compensation.ot.type2.waiting` | /hr/compensation/ot-detection/type-2/waiting | shares: compensation/ot, compensation/ot/assign | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Assigned and rejected | Sub-tab | `compensation.ot.type2.assigned` | /hr/compensation/ot-detection/type-2/assigned | shares: compensation/ot | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ How the suggested shifts are worked out | Sub-tab | `compensation.ot.type2.how` | /hr/compensation/ot-detection/type-2/how | shares: compensation/config | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Earlier records | Sub-tab | `compensation.ot.earlier` | /hr/compensation/ot-detection/earlier | compensation/ot/announce | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Compensation Leave | Page | `compensation.leave` | /hr/compensation/compensation-leave | its parts' calls | Server (through its parts) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ A. Announce late-in / early-out | Sub-tab | `compensation.leave.announcements` | /hr/compensation/compensation-leave/announcements | compensation/windows | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Announce | Sub-tab | `compensation.leave.announcements.announce` | /hr/compensation/compensation-leave/announcements/announce | shares: compensation/windows (the sub-tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Announcements | Sub-tab | `compensation.leave.announcements.list` | /hr/compensation/compensation-leave/announcements/list | shares: compensation/windows | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ B. Sunday & holiday work | Sub-tab | `compensation.leave.holiday_work` | /hr/compensation/compensation-leave/holiday-work | compensation/holiday-work | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Raise a claim | Sub-tab | `compensation.leave.holiday_work.raise` | /hr/compensation/compensation-leave/holiday-work/raise | shares: compensation/holiday-work (the sub-tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Claims | Sub-tab | `compensation.leave.holiday_work.claims` | /hr/compensation/compensation-leave/holiday-work/claims | shares: compensation/holiday-work | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Compensation balance | Sub-tab | `compensation.leave.holiday_work.balance` | /hr/compensation/compensation-leave/holiday-work/balance | compensation/balance | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Earlier Alternative-Day credits | Sub-tab | `compensation.leave.holiday_work.credits` | /hr/compensation/compensation-leave/holiday-work/credits | compensation/credits | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ C. Birthdays | Sub-tab | `compensation.leave.birthdays` | /hr/compensation/compensation-leave/birthdays | compensation/birthdays | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Who has a birthday | Sub-tab | `compensation.leave.birthdays.list` | /hr/compensation/compensation-leave/birthdays/list | shares: compensation/birthdays (the sub-tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ How it works | Sub-tab | `compensation.leave.birthdays.how` | /hr/compensation/compensation-leave/birthdays/how | shares: compensation/birthdays | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ History | Page | `compensation.history` | /hr/compensation/history | shares: compensation/reports (also the Reports page's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ OT allowance | Sub-tab | `compensation.history.ot_allowance` | /hr/compensation/history/ot-allowance | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ OT relaxation | Sub-tab | `compensation.history.ot_relaxation` | /hr/compensation/history/ot-relaxation | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ OT pay | Sub-tab | `compensation.history.ot_pay` | /hr/compensation/history/ot-pay | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Company windows | Sub-tab | `compensation.history.company_windows` | /hr/compensation/history/company-windows | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Late-in window | Sub-tab | `compensation.history.company_windows.late_in` | /hr/compensation/history/company-windows/late-in | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Early-out window | Sub-tab | `compensation.history.company_windows.early_out` | /hr/compensation/history/company-windows/early-out | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Holiday / Sunday work | Sub-tab | `compensation.history.holiday_work` | /hr/compensation/history/holiday-work | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Sunday / holiday work | Sub-tab | `compensation.history.holiday_work.work` | /hr/compensation/history/holiday-work/work | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Balance redeemed | Sub-tab | `compensation.history.holiday_work.redeemed` | /hr/compensation/history/holiday-work/redeemed | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Birthday leave | Sub-tab | `compensation.history.birthday_leave` | /hr/compensation/history/birthday-leave | shares: compensation/reports (one call for every History sub-tab) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Reports | Page | `compensation.reports` | /hr/compensation/reports | shares: compensation/reports (also History's) | Screen only |  |
| Settlement | Page | `settlement` | - | advances | Server | existing key |
| Reports | Page | `reports` | - | reports | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Payroll & Salary | Tab | `reports.payroll` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Attendance | Tab | `reports.attendance` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Leave & Requests | Tab | `reports.leave` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Gate & Visitors | Tab | `reports.gate` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Employees | Tab | `reports.employees` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ HR Reports | Tab | `reports.hr` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Loans & Bonus | Tab | `reports.finance` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Administration | Tab | `reports.admin` | - | - | Locked: Super Admin only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Executive (MD) | Tab | `reports.md` | - | - | Locked: Managing Director only |  |

### Recruitment

| Page / tab / sub-tab | Type | Key | Address | API | Enforced | Notes |
|---|---|---|---|---|---|---|
| Recruitment | Section | `recruitment` | - | applicants, jobs, recruitment | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Recruitment Dashboard | Page | `recruitment.dashboard` | /hr/recruitment/dashboard | recruitment/dashboard | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ New Joinees | Page | `recruitment.new_joinees` | - | recruitment/new-joinees | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Resignations | Page | `recruitment.resignations` | - | recruitment/resignations | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Required Roles | Page | `recruitment.required_roles` | - | recruitment/department-headcount | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Interviews | Page | `recruitment.interviews` | - | interviews | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Resume Screening | Page | `recruitment.resume_screening` | - | recruitment/resume-screening | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Upload resume | Tab | `recruitment.resume_screening.upload` | - | recruitment/resume-screening/upload-single | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Bulk resume upload | Tab | `recruitment.resume_screening.bulk` | - | recruitment/resume-screening/upload-bulk, recruitment/resume-screening/upload-bulk-progress | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Company rules & expectations | Tab | `recruitment.resume_screening.rules` | - | shares: recruitment/resume-screening/rule-sets (the upload tabs read it too) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Candidate pipeline | Tab | `recruitment.resume_screening.pipeline` | - | shares: recruitment/resume-screening/candidates (the upload tab acts on it too) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Shortlisted | Sub-tab | `recruitment.resume_screening.pipeline.shortlisted` | - | shares: recruitment/resume-screening/candidates?status= (a query parameter) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Selected | Sub-tab | `recruitment.resume_screening.pipeline.selected` | - | shares: recruitment/resume-screening/candidates?status= (a query parameter) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Rejected | Sub-tab | `recruitment.resume_screening.pipeline.rejected` | - | shares: recruitment/resume-screening/candidates?status= (a query parameter) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Not shortlisted | Sub-tab | `recruitment.resume_screening.pipeline.not_shortlisted` | - | shares: recruitment/resume-screening/candidates?status= (a query parameter) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Documents | Page | `recruitment.documents` | - | recruitment/employee-documents | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Staff | Tab | `recruitment.documents.staff` | - | shares: recruitment/employee-documents/completion-stats?employmentType=staff | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Production | Tab | `recruitment.documents.production` | - | shares: recruitment/employee-documents/completion-stats?employmentType=production | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ One employee's documents | View | `recruitment.documents.employee` | - | recruitment/employee-documents/<id> | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Letters | Sub-tab | `recruitment.documents.employee.letters` | - | shares: employees/<id>/offer-letter, experience-letter (Employees key), recruitment/resignations | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Extra documents | Sub-tab | `recruitment.documents.employee.extra` | - | employee-documents, recruitment/employee-documents/<id>/upload | Server |  |

### Administration

| Page / tab / sub-tab | Type | Key | Address | API | Enforced | Notes |
|---|---|---|---|---|---|---|
| Account Management | Page | `account_management` | - | - | Locked: Super Admin only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Accounts | Tab | `account_management.accounts` | - | - | Locked: Super Admin only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Roles & Permissions | Tab | `account_management.roles` | - | - | Locked: Super Admin only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ MD Profile | Tab | `account_management.md_profile` | - | - | Locked: Super Admin only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ HR Manager | Tab | `account_management.hr_manager` | - | - | Locked: Super Admin only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ HR Assistant | Tab | `account_management.hr_assistant` | - | - | Locked: Super Admin only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Master | Page | `account_management.master` | - | - | Locked: The master administrator only |  |
| User Management | Page | `user_management` | - | its parts' calls | Server (through its parts) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ HOD Assignment | Tab | `user_management.hod` | - | department-managers | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Find user | Sub-tab | `user_management.hod.find_user` | - | shares: employees?search= | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Unassigned staff | Sub-tab | `user_management.hod.unassigned` | - | shares: employees, department-managers/<id>/employees | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Department Head details | Page | `user_management.hod.detail` | /hr/user-management/<id> | shares: department-managers/<id> (also the HOD tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Approval Workflow Control | Tab | `user_management.approval_workflow` | - | approval-workflows | Server | existing key |
| Activity Logs | Page | `activity_logs` | - | - | Locked: Super Admin only |  |
| Assistant Activity | Page | `assistant_activity` | - | - | Locked: Super Admin and HR Managers (by account type, not by role) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ HR Assistants | Tab | `assistant_activity.hr_assistants` | - | - | Locked: Super Admin and HR Managers |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ HR Managers | Tab | `assistant_activity.hr_managers` | - | - | Locked: Super Admin only |  |
| Chat | Page | `chat` | - | chat | Server | existing key |
| Notifications | Page | `notifications` | - | notifications | Server | existing key |
| Login Devices | Page | `login_devices` | - | login-sessions | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Sign a device out | Feature | `login_devices.revoke` | - | - | Locked: Super Admin only |  |
| Mobile App Login | Page | `mobile_app_login` | - | its parts' calls | Server (through its parts) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Login Status | Tab | `mobile_app_login.logins` | - | mobile-app-logins | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Export to Excel | Feature | `mobile_app_login.logins.export` | - | mobile-app-logins/export | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Set / reset a password | Feature | `mobile_app_login.logins.password` | - | mobile-app-logins/<id>/reset-password | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Mobile Messages | Tab | `mobile_app_login.messages` | - | mobile-app/messages | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Overview | Sub-tab | `mobile_app_login.messages.overview` | - | mobile-app/messages/overview | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Controls | Sub-tab | `mobile_app_login.messages.controls` | - | shares: mobile-app/messages/controls (the Messages sub-tab reads it too) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Messages | Sub-tab | `mobile_app_login.messages.log` | - | mobile-app/messages/log | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Phones | Sub-tab | `mobile_app_login.messages.devices` | - | shares: mobile-app/messages/devices (Send a message reads it too) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Send a message | Sub-tab | `mobile_app_login.messages.send` | - | mobile-app/messages/send | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ New Version | Tab | `mobile_app_login.version` | - | mobile-app/versions | Server |  |
| WhatsApp Control | Page | `whatsapp_control` | - | whatsapp-control | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Overview | Tab | `whatsapp_control.overview` | - | whatsapp-control/queue | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Messages | Tab | `whatsapp_control.messages` | - | whatsapp-control/messages | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Employees | Tab | `whatsapp_control.employees` | - | whatsapp-control/employees | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Feature Controls | Tab | `whatsapp_control.controls` | - | shares: whatsapp-control/settings (Configuration reads it too) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Message Text | Tab | `whatsapp_control.templates` | - | whatsapp-control/templates | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Configuration | Tab | `whatsapp_control.config` | - | shares: whatsapp-control/settings | Screen only |  |
| SMS Control | Page | `sms_control` | - | sms-control | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Overview | Tab | `sms_control.overview` | /hr/sms-control/overview | shares: sms-control/overview (Settings, Test and Setup read it too) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Settings | Tab | `sms_control.settings` | /hr/sms-control/settings | sms-control/settings | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Channel | Sub-tab | `sms_control.settings.channel` | /hr/sms-control/settings/channel | shares: sms-control/settings (one call for the three sections) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Limits | Sub-tab | `sms_control.settings.limits` | /hr/sms-control/settings/limits | shares: sms-control/settings (one call for the three sections) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Switches | Sub-tab | `sms_control.settings.switches` | /hr/sms-control/settings/switches | shares: sms-control/settings (one call for the three sections) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Messages | Tab | `sms_control.messages` | /hr/sms-control/messages | sms-control/messages | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Test | Tab | `sms_control.test` | /hr/sms-control/test | sms-control/test | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Setup | Tab | `sms_control.setup` | /hr/sms-control/setup | shares: sms-control/overview | Screen only |  |
| Gmail Control | Page | `gmail_control` | - | gmail-control | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Overview | Tab | `gmail_control.overview` | - | shares: gmail-control/overview (Messages and Employees read it too) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Messages | Tab | `gmail_control.messages` | - | gmail-control/messages | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Employees | Tab | `gmail_control.employees` | - | gmail-control/employees | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Feature Controls | Tab | `gmail_control.controls` | - | shares: gmail-control/settings (Configuration and Settings -> SMTP read it too) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Message Text | Tab | `gmail_control.templates` | - | gmail-control/templates/[^/]+(/preview)? | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Configuration | Tab | `gmail_control.config` | - | its parts' calls | Server (through its parts) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Send a test email | Feature | `gmail_control.config.test_email` | - | gmail-control/test-email | Server |  |
| Biometric Connectors | Section | `biometric_connectors` | /hr/Biometric-Connectors | its parts' calls | Server (through its parts) | follows attendance until set |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Biometric Device Status | Page | `biometric_connectors.device_status` | /hr/Biometric-Connectors/device-status | attendance/biometric-status | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Device Control | Page | `biometric_connectors.device_control` | /hr/Biometric-Connectors/DeviceControl | attendance/device-control | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Overview | Tab | `biometric_connectors.device_control.overview` | - | shares: attendance/device-control/overview (every Device Control tab reads it) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Data Fetch | Tab | `biometric_connectors.device_control.fetch` | /hr/Biometric-Connectors/DeviceControl/fetch | attendance/device-control/fetch | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Data Push | Tab | `biometric_connectors.device_control.push` | /hr/Biometric-Connectors/DeviceControl/push | attendance/device-control/employees/<id>/photo, attendance/device-control/people, attendance/device-control/users | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Link / Unlink | Tab | `biometric_connectors.device_control.link_unlink` | /hr/Biometric-Connectors/DeviceControl/link-unlink | attendance/device-control/employees/<id>/links, attendance/device-control/links | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Site connectors | Tab | `biometric_connectors.device_control.connectors` | /hr/Biometric-Connectors/DeviceControl/connectors | attendance/device-control/connectors | Server |  |
| Settings | Section | `settings` | - | its parts' calls | Server (through its parts) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Company | Tab | `settings.company` | - | checked inside the view | Server (view check) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ HR Contact | Tab | `settings.hr_contact` | - | checked inside the view | Server (view check) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Themes | Tab | `settings.themes` | - | shares: theme-settings (any HR login may change it on the API: see Gaps) | Screen only | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Attendance | Tab | `settings.attendance` | - | tracking/settings | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Staff | Sub-tab | `settings.attendance.staff` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Production | Sub-tab | `settings.attendance.production` | - | production-shift-config | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Production Shifts | Tab | `settings.production_shifts` | - | production-shift-rules, production-shift-segments | Server | follows settings.attendance until set |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Staff | Sub-tab | `settings.production_shifts.staff` | - | shares: nothing (information only) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Production | Sub-tab | `settings.production_shifts.production` | - | shares: production-shift-rules (the tab's) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Late Detection | Tab | `settings.late_detection` | - | checked inside the view | Server (view check) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Staff | Sub-tab | `settings.late_detection.staff` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Production | Sub-tab | `settings.late_detection.production` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Weekly | Sub-tab | `settings.late_detection.production.weekly` | - | shares: payroll-settings prodCycles (one value for the three cycles) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ BiWeekly | Sub-tab | `settings.late_detection.production.biweekly` | - | shares: payroll-settings prodCycles | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Monthly | Sub-tab | `settings.late_detection.production.monthly` | - | shares: payroll-settings prodCycles | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Compensation | Tab | `settings.compensation` | - | compensation/settings | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Devices | Tab | `settings.devices` | - | biometric-devices | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Staff Payroll | Tab | `settings.payroll` | - | checked inside the view | Server (view check) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Payroll Rules | Sub-tab | `settings.payroll.rates` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Bonus | Sub-tab | `settings.payroll.bonus` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ OT / Compensation | Sub-tab | `settings.payroll.ot_compensation` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Production Payroll | Tab | `settings.production_payroll` | - | checked inside the view | Server (view check) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Overview | Sub-tab | `settings.production_payroll.overview` | - | shares: payroll-settings, shifts (display only) | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Weekly | Sub-tab | `settings.production_payroll.weekly` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ BiWeekly | Sub-tab | `settings.production_payroll.biweekly` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Monthly | Sub-tab | `settings.production_payroll.monthly` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Pay & Bonus | Sub-tab | `settings.production_payroll.pay_bonus` | - | checked inside the view | Server (view check) |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ PF & ESI | Tab | `settings.pf_esi` | - | shares: pf-esi-settings (any HR login reads it; only the Super Admin changes it) | Screen only | follows settings.payroll until set |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Staff | Sub-tab | `settings.pf_esi.staff` | - | shares: pf-esi-settings | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Production | Sub-tab | `settings.pf_esi.production` | - | shares: pf-esi-settings | Screen only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Salary Slip | Tab | `settings.salary_slip` | - | checked inside the view | Server (view check) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Company Documents | Tab | `settings.documents` | - | document-settings | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Offer Letter | Sub-tab | `settings.documents.offer_letter` | - | document-settings/offer_letter | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Experience Letter | Sub-tab | `settings.documents.experience_letter` | - | document-settings/experience_letter | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Salary Slip | Sub-tab | `settings.documents.salary_slip` | - | document-settings/salary_slip | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Resignation Letter | Sub-tab | `settings.documents.resignation_letter` | - | document-settings/resignation_letter | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ ID Card | Tab | `settings.idcard` | - | idcard-settings | Server | follows id_cards until set |
| &nbsp;&nbsp;&nbsp;&nbsp;└ SMTP / Email | Tab | `settings.smtp` | - | checked inside the view | Server (view check) | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ WhatsApp | Tab | `settings.whatsapp` | - | whatsapp | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Endpoint Sharing | Tab | `settings.endpoint_sharing` | - | - | Locked: Super Admin only |  |
| &nbsp;&nbsp;&nbsp;&nbsp;└ Backup | Tab | `settings.backup` | - | backup | Server | existing key |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Schedule | Feature | `settings.backup.schedule` | - | backup/schedule | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Google Drive copy | Feature | `settings.backup.drive` | - | backup/drive | Server |  |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ Restore | Feature | `settings.backup.restore` | - | backup/restore | Server |  |

## Approvals

| Heading | Approval | Kind key | Module (needs at least View) | Decision endpoint(s) | Notes |
|---|---|---|---|---|---|
| Leave & Holiday | Leave requests | `leave` | `leave` | PATCH leave-requests/<id>/status |  |
| Leave & Holiday | Permission requests | `permission` | `requests` | PUT permissions/<id> (also POST permissions with a decided status) |  |
| Casual Leave | Casual Leave requests | `casual_leave` | `casual_leave` | PATCH casual-leaves/<id> |  |
| Attendance | Missing punch requests | `missing_punch` | `missing_punch` | PATCH missing-punch-requests/<id>/status | never for HR Assistants |
| Attendance | Attendance edit requests | `attendance_correction` | `attendance` | PATCH attendance/override-requests/<id> | never for HR Assistants |
| Geo Attendance | On-Duty requests | `on_duty` | `geo_attendance` | PATCH on-duty-sessions/<id>/status |  |
| Geo Attendance | On-Duty punch verifications | `on_duty_punch` | `geo_attendance` | PATCH on-duty-punch-verifications/<id>/status, PATCH on-duty-sessions/<id>/punches |  |
| Outpass | Outpass requests | `outpass` | `requests` | PUT outpass-requests/<id>/hr-status |  |
| Requests page - Other requests (the employee request form) | Leave Request | `request_leave` | `requests` | PUT employee-requests/<id>/action (request_type=leave) | split out of `request`: follows its old switch until set |
| Requests page - Other requests (the employee request form) | Salary Enquiry | `request_salary_enquiry` | `requests` | PUT employee-requests/<id>/action (request_type=salary_enquiry) | split out of `request`: follows its old switch until set |
| Requests page - Other requests (the employee request form) | Shift Correction | `request_shift_correction` | `requests` | PUT employee-requests/<id>/action (request_type=shift_correction) | split out of `request`: follows its old switch until set |
| Requests page - Other requests (the employee request form) | Advance Request | `request_advance` | `requests` | PUT employee-requests/<id>/action (request_type=advance) | split out of `request`: follows its old switch until set |
| Requests page - Other requests (the employee request form) | Permission Request | `request_permission` | `requests` | PUT employee-requests/<id>/action (request_type=permission) | split out of `request`: follows its old switch until set |
| Requests page - Other requests (the employee request form) | General Query | `request_general` | `requests` | PUT employee-requests/<id>/action (request_type=general) | split out of `request`: follows its old switch until set |
| Recruitment | Resignations | `resignation` | `recruitment.resignations` | PATCH recruitment/resignations/<id>/action |  |
| Recruitment | Interview results | `interview_result` | `recruitment` | PATCH applicants/<id>/status (selected / rejected) | extra right on top of Edit (unset on a role with switches = follows Edit) |
| Recruitment | Resume screening decisions | `resume_decision` | `recruitment.resume_screening` | PATCH recruitment/resume-screening/candidates/<id> (selected / rejected) | extra right on top of Edit (unset on a role with switches = follows Edit) |
| Settlement | General advances | `advance_general` | `settlement` | PUT advances/<id> (general advance) | split out of `advance`: follows its old switch until set |
| Settlement | Term advances (loans) | `advance_term` | `settlement` | PUT advances/<id> (term advance) | split out of `advance`: follows its old switch until set |
| Staff Payroll | Hold / unhold a salary | `payroll_hold` | `payroll` | POST payroll/<id>/hold | extra right on top of Edit (unset on a role with switches = follows Edit) |
| Staff Payroll | Add a new joiner to the payroll | `payroll_add` | `payroll` | POST payroll/<id>/add-to-payroll | extra right on top of Edit (unset on a role with switches = follows Edit) |
| Staff Payroll | Payroll Done (lock the month) | `payroll_finalize` | `payroll` | POST payroll/month-finalize | extra right on top of Edit (unset on a role with switches = follows Edit); Only for a login that covers every branch, as before. |
| Staff Payroll | Mark the month as Paid | `payroll_mark_paid` | `payroll` | POST payroll/month-paid | extra right on top of Edit (unset on a role with switches = follows Edit); Only for a login that covers every branch, as before. |
| Staff Payroll | Release & pay | `payroll_release` | `payroll` | POST payroll/<id>/release-and-pay | extra right on top of Edit (unset on a role with switches = follows Edit); Only for a login that covers every branch, as before. |
| Staff Payroll | Mark a salary as cleared | `payroll_mark_cleared` | `payroll` | PATCH payroll/<id> {status: paid} | extra right on top of Edit (unset on a role with switches = follows Edit) |
| Compensation | OT shift compensation | `compensation_ot` | `compensation.ot` | POST compensation/ot/assign, /reject, /announce | extra right on top of Edit (unset on a role with switches = follows Edit) |
| Bonus | Bonus approval and payment | `bonus_status` | `bonus` | PATCH bonus/<id> {status} | extra right on top of Edit (unset on a role with switches = follows Edit) |
| Compensation | Holiday / Sunday work claims | `holiday_work` | - | manager/holiday-work/<id>/status (HOD token) | no switch: Decided by the Department Head only: HR has no approval step for them. |

How an approval switch works:

- A role on the **original rule** (no switches; every role made before 2026-11-10) approves exactly what it may **edit**:
  each kind above follows Edit on its module, as before.
- A role **with switches** (and every HR Manager / HR Assistant account): each kind is its own switch. A kind that was
  split out of an older one (the six request-form types out of "Other requests", General / Term out of "Advance") follows
  the old switch until it is set on its own. A kind that is an **extra right on top of Edit** (the payroll month decisions,
  Bonus, OT, interview and screening decisions) follows Edit until it is set, and never works without Edit.
- Nobody approves a kind whose module they cannot open. HR Assistants never approve missing punches or attendance edits.
- The server checks every switch in the decision endpoint itself (`hr_access.approval_refusal`), and every request's
  `approval` block tells the screens (`canAct`), so lists, counts and badges only offer what the account may decide.

## Not given a key of their own (and why)

These switch what one list shows, not what the role may reach. They follow the page or tab they are on.

| Where | What | Why no key |
|---|---|---|
| Missing Punch; Leave Requests / Half-Day / Permissions; CL Taken / Requests / Not eligible; Resignations (Active / Approved / Rejected); Settlement (Pending ... All, General / Term); On-Duty Approvals and Punch Verifications status pills; Biometric Device Status pills | status filters | the same list filtered (query parameter or in the browser) |
| Production Employees | All / Unassigned / Weekly / BiWeekly / Monthly | one list filtered by cycle (`employees/production?cycle=`) |
| Staff / Production Payroll | department tabs, Table / Cards, Issues grouped by date / employee / type, Salary Scroll / Pages | display options of the same data |
| Designations -> Structure | Tree / List | two drawings of the same designations |
| Leave & Holiday -> Holidays | List / Year view | two drawings of the same holidays |
| Manage Branch | Cards / Table | two drawings of the same branches |
| Bulk upload | Staff / Production switch | picks the template, not a page |
| Attendance Search, Punch View, Report Log, Outpass / Visitors / Tea Break, Compensation History | day / week / month / custom period pills | date filters |
| Requests -> Other requests | request-type filter | a filter; each type has its own approval switch |
| Report Center | the 157 individual reports | each report needs its group (a key) and View on the pages its data comes from (`reporting/access.py`) |
| User Management -> Approval Workflow Control | Leave & attendance / Requests / Recruitment & payroll groups | headings of one settings list |
| Settings -> Company Documents | Offer / Experience / Salary Slip / Resignation letter picker | each letter has a key (it is a sub-tab in the tree) |

## API paths with no key (the allowlist)

`tests_permission_tree.py` fails when a new API path is neither mapped to a key nor on this list.

| Paths | Why they are not role-controlled |
|---|---|
| `auth/*`, `healthz`, `` (API index) | signing in, the current account, health probes |
| `shared/<slug>` | Endpoint Sharing's public call: its own API key, never an HR token |
| `outpass/gate/*`, `visitor/gate/*`, `gate-devices/login*`, `gate-devices/scan*`, `reception-devices/login*`, `reception-devices/summary`, `reception-devices/visits` | the gate QR pages (no login) and the scanner / reception devices' own logins |
| `connector/*` | the factory Site Connector program (its own key) |
| `co-portal/*` | the CO portal (its own portal key) |
| `my/*`, `employee/*`, `live-location/ping`, `tracking/state`, `tracking/consent`, `tracking/batch`, `tracking/my-journeys`, `tea-break/qr-token`, `tea-break/my-status`, `attendance/geo-punch*`, `on-duty-sessions/request|punch|mine|status|complete`, `casual-leaves/my-eligibility`, `casual-leaves/policy`, `dashboard/employee-summary`, `dashboard/mobile-home-summary` | employee tokens (mobile app, employee portal): the middleware only ever restricts HR tokens |
| `manager/*` | Department Head (HOD) tokens |
| `md/*` | the Managing Director only (`require_md` + the middleware's own `md/` lock) |
| `roles`, `roles/<id>`, `hr-users*` | Account Management: the Super Admin only (`require_super_admin` / `require_master_admin`) |
| `shared-endpoints*` | Settings -> Endpoint Sharing: the Super Admin only |
| `hr-activity` | Assistant Activity: the Super Admin and HR Managers, checked in the view by account type |
| `approval-summary` | the approval pipelines (no data), read by every app to explain a request |
| `hr/approval-reminders` | the employees' "remind HR" nudges shown on the Requests page. Ungated before; still ungated (see Gaps) |
| `payroll-settings` | company name / logo read by every page; each saved field is checked against its Settings tab (`FIELD_GROUPS`) |
| `pf-esi-settings` | PF / ESI rates read by the payroll screens; only the Super Admin changes them (checked in the view) |
| `support-contact` | the HR contact shown on the sign-in screens (no login) |
| `mobile-app/latest-version` | the app's update check (no login) |
| `theme-settings`, `theme-settings/update` | the portal's colours, read on every page. Changing them is not checked on the API (see Gaps) |

## Portal addresses with no key

`tests_permission_tree.py` / `permission-tree.test.ts` fail when a new `/hr/...` address is neither mapped nor listed here.

| Address | Why |
|---|---|
| `/hr/account-management`, `/hr/account-management/master` | the Super Admin / the master administrator only (locked rows in the tree) |
| `/hr/activity-logs` | the Super Admin only (locked row) |
| `/hr/assistant-activity` | the Super Admin and HR Managers, by account type (locked row) |
| `/hr/salary`, `/hr/salary-slip`, `/hr/production-payroll`, `/hr/attendance/edit-requests`, `/hr/attendance/device-status`, `/hr/attendance/DeviceControl/:tab?`, `/hr/Biometric-Connectors` | old addresses that only redirect to a page above (which is checked) |

## Gaps found by the audit (not changed: each would change what an existing role may do)

1. **Themes can be changed by any HR login through the API** (`PUT theme-settings/update` only checks "is HR"); only the
   screen checks Settings -> Themes. Fixing it would refuse logins that can change it today.
2. **`hr/approval-reminders` is readable by every HR login** (employee names and request numbers). Fixing it would refuse
   logins that can read it today.
3. **Manage Shift -> Assign "preview"** and **Bulk upload -> "check the file"** are POSTs that only read, but a View-only
   role is refused them (they are not in `READ_ONLY_POST_PATHS`).
4. **Staff Payroll -> Salary tab** reads `payroll/*` (the Payroll key), not the `salary` key; **Production Payroll** Mark as
   Cleared, Adjust, the generation progress and the details' statutory card use `payroll/*` too; its Payslip tab reads
   `salary-slips` (the Payslip key). A role needs those keys as well.
5. **Interviews** reads `jobs`, `applicants` (the Recruitment section's key) and `dashboard/interview-summary` (the
   Dashboard's key): a role with only the Interviews page gets empty lists.
6. **The Dashboard** reads Attendance and Departments without checking them first: those cards stay empty for a role
   without them.
7. **Recruitment Dashboard** tiles link to `/hr/recruitment`, which has no page.
8. **The sidebar's page search** lists every page; opening one the role cannot see goes back to the home page.
9. **Casual Leave -> Carry Forward -> Assign CL** gives approved CL with Edit only (no approval switch), as before.

## Deliberate changes for existing roles (screen only, never an API answer)

1. **A page whose own key is View but with a part set to Edit on its own is no longer locked as a whole.** Before, the
   page-wide View lock also locked the part the role may edit (e.g. Settings = View with Settings -> Staff Payroll = Edit);
   now each View part locks itself (`AuthContext.isRouteViewOnly` / `hasEditablePart`).
2. **Two names in Activity Logs / Assistant Activity:** "Payroll" is now "Staff Payroll" and "Salary Slip" is "Payslip"
   (the tree's labels), e.g. "Changed in Staff Payroll (PATCH /api/payroll/1)".

## Known remaining gaps of the screen side

- Some hidden parts still load their data in the background (the API answers it, the screen does not show it): the
  Dashboard's attendance and activity cards, On-Duty Map's "All" view, and the forms of Production Shifts, PF & ESI and
  Late Detection (one form per tab).
- Live Map's "Open journey" is offered when Journey History is hidden (opening it goes back to the home page).
- The View lock recognises buttons by their words; buttons named Activate, Email, WhatsApp, Mark, Schedule or Shortlist are
  disabled by their own pages where this work touched them, not by the lock.

## How "nothing changes for existing roles" is proven

- New keys are parts of an existing key (they follow it while unset) or follow the key that governed them before
  (`inherits`). No role row was changed (no data migration).
- `tests_permission_tree.py` resolves every API path in Django's URL list for many role shapes (every old key at every
  level, mixtures, HR Manager / Assistant overrides, the Managing Director) under the old rules
  (`tests_permission_snapshot.py`, the frozen copy) and the new ones, and fails on any difference. The same test runs the
  approval rules (old "Other requests" vs each request type, old "Advance" vs General / Term).
- `permission-tree.test.ts` does the same for every `/hr/...` address of the portal (route guard, sidebar, view-only lock).
- The real roles of the local database were checked with both, read-only (see the report of 2026-11-11).
