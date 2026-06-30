from django.urls import path

from . import views
from .shift_views import (
    shift_templates, shift_template_detail,
    shift_assignments, shift_assignment_detail,
    bulk_shift_assignments, sync_production_shifts,
)
from .leave_views import (
    leave_types, leave_type_detail,
    leave_balances, allocate_leave,
    holidays, holiday_detail,
    employee_requests, employee_request_action,
    employee_permissions, employee_permission_detail,
)
from .settlement_views import (
    advances, advance_detail, advance_repayments,
)
from .hr_user_views import (
    roles, role_detail,
    hr_users, hr_user_detail,
    audit_logs, audit_logs_stats,
)
from .salary_slip_views import (
    salary_slips, salary_slip_detail, email_salary_slip, employee_salary_slips,
)
from .org_views import (
    branches, branch_detail,
    designations, designation_detail,
)
from .manager_views import (
    department_managers, department_manager_detail,
    manager_department_assignments, manager_employee_assignments,
    manager_me, manager_pending_requests,
    manager_update_leave_status, manager_update_permission_status,
)
from .reports_views import (
    attendance_report, attendance_summary_report,
    leave_report, leave_balance_report,
    payroll_report, pf_esi_report,
    employee_report, headcount_report,
    settlement_report, new_joinings_report,
)
from .attendance_views import (
    attendance_summary, attendance_daily, attendance_monthly_trend,
    attendance_employee_history, biometric_punch, manual_attendance,
    sync_biometric_api,
)
from .payroll_views import (
    session_configs, session_config_detail,
    attendance_logs, upload_attendance_excel, process_punch_sessions,
    work_sessions, work_session_detail,
    payroll_list, generate_payroll, payroll_detail, payroll_breakdown,
    seed_attendance, payroll_settings_view,
)

urlpatterns = [
    # ── Health ──────────────────────────────────────────────────────────────
    path("healthz", views.healthz),

    # ── Auth ────────────────────────────────────────────────────────────────
    path("auth/hr-login", views.hr_login),
    path("auth/employee-login", views.employee_login),
    path("auth/set-password", views.set_password),
    path("auth/me", views.auth_me),

    # ── Organisation ────────────────────────────────────────────────────────
    path("branches", branches),
    path("branches/<int:pk>", branch_detail),
    path("departments", views.departments),
    path("departments/<int:pk>", views.delete_department),
    path("designations", designations),
    path("designations/<int:pk>", designation_detail),

    # ── Employees ───────────────────────────────────────────────────────────
    path("employees", views.employees),
    path("employees/<int:pk>", views.employee_detail),
    path("employees/<int:pk>/status", views.employee_status),

    # ── Shift Management ────────────────────────────────────────────────────
    path("shifts", shift_templates),
    path("shifts/<int:pk>", shift_template_detail),
    path("shift-assignments", shift_assignments),
    path("shift-assignments/bulk", bulk_shift_assignments),
    path("shift-assignments/sync-production", sync_production_shifts),
    path("shift-assignments/<int:pk>", shift_assignment_detail),

    # ── Leave & Holiday ─────────────────────────────────────────────────────
    path("leave-types", leave_types),
    path("leave-types/<int:pk>", leave_type_detail),
    path("leave-balances", leave_balances),
    path("leave-balances/allocate", allocate_leave),
    path("holidays", holidays),
    path("holidays/<int:pk>", holiday_detail),
    path("leave-requests", views.leave_requests),
    path("leave-requests/<int:pk>/status", views.update_leave_status),
    path("leave-requests/<int:pk>", views.delete_leave_request),

    # ── Approved Requests (Mobile App) ──────────────────────────────────────
    path("employee-requests", employee_requests),
    path("employee-requests/<int:pk>/action", employee_request_action),

    # ── Employee Permissions ─────────────────────────────────────────────────
    path("permissions", employee_permissions),
    path("permissions/<int:pk>", employee_permission_detail),

    # ── Salary Records (legacy) ──────────────────────────────────────────────
    path("salary-records", views.salary_records),
    path("salary-records/calculate", views.calculate_salary_records),
    path("salary-records/<int:pk>", views.update_salary_record),

    # ── Settlement ──────────────────────────────────────────────────────────
    path("advances", advances),
    path("advances/<int:pk>", advance_detail),
    path("advances/<int:pk>/repayments", advance_repayments),

    # ── Salary Slips ────────────────────────────────────────────────────────
    path("salary-slips", salary_slips),
    path("salary-slips/<int:pk>", salary_slip_detail),
    path("salary-slips/<int:pk>/email", email_salary_slip),
    path("my/salary-slips", employee_salary_slips),

    # ── Notifications ───────────────────────────────────────────────────────
    path("notifications", views.notifications),
    path("notifications/<int:pk>/read", views.mark_notification_read),

    # ── Recruitment ─────────────────────────────────────────────────────────
    path("jobs", views.jobs),
    path("jobs/<int:pk>", views.job_detail),
    path("applicants", views.applicants),
    path("applicants/<int:pk>/status", views.update_applicant_status),

    # ── Attendance ──────────────────────────────────────────────────────────
    path("attendance", views.attendance),
    path("attendance/summary", attendance_summary),
    path("attendance/daily", attendance_daily),
    path("attendance/monthly-trend", attendance_monthly_trend),
    path("attendance/employee/<int:pk>", attendance_employee_history),
    path("attendance/manual", manual_attendance),
    path("attendance/sync-biometric", sync_biometric_api),
    path("biometric/punch", biometric_punch),

    # ── Dashboard ───────────────────────────────────────────────────────────
    path("dashboard/hr-summary", views.hr_dashboard_summary),
    path("dashboard/employee-summary", views.employee_dashboard_summary),
    path("dashboard/interview-summary", views.interview_summary),
    path("dashboard/salary-trends", views.salary_trends),

    # ── Enterprise Payroll Engine ────────────────────────────────────────────
    path("payroll-settings", payroll_settings_view),
    path("session-configs", session_configs),
    path("session-configs/<int:pk>", session_config_detail),
    path("attendance-logs", attendance_logs),
    path("attendance-logs/upload-excel", upload_attendance_excel),
    path("attendance-logs/process-sessions", process_punch_sessions),
    path("attendance-logs/seed", seed_attendance),
    path("work-sessions", work_sessions),
    path("work-sessions/<int:pk>", work_session_detail),
    path("payroll", payroll_list),
    path("payroll/generate", generate_payroll),
    path("payroll/<int:pk>/breakdown", payroll_breakdown),
    path("payroll/<int:pk>", payroll_detail),

    # ── User Management ─────────────────────────────────────────────────────
    path("roles", roles),
    path("roles/<int:pk>", role_detail),
    path("hr-users", hr_users),
    path("hr-users/<int:pk>", hr_user_detail),

    # ── Department Managers ──────────────────────────────────────────────────
    path("department-managers", department_managers),
    path("department-managers/<int:pk>", department_manager_detail),
    path("department-managers/<int:pk>/departments", manager_department_assignments),
    path("department-managers/<int:pk>/employees", manager_employee_assignments),

    # ── Mobile: Manager profile + approvals ──────────────────────────────────
    path("manager/me", manager_me),
    path("manager/pending-requests", manager_pending_requests),
    path("manager/leave-requests/<int:pk>/status", manager_update_leave_status),
    path("manager/permissions/<int:pk>/status", manager_update_permission_status),

    # ── Audit Logs ───────────────────────────────────────────────────────────
    path("audit-logs", audit_logs),
    path("audit-logs/stats", audit_logs_stats),

    # ── Reports ──────────────────────────────────────────────────────────────
    path("reports/attendance-log",      attendance_report),
    path("reports/attendance-summary",  attendance_summary_report),
    path("reports/leave",               leave_report),
    path("reports/leave-balance",       leave_balance_report),
    path("reports/payroll",             payroll_report),
    path("reports/pf-esi",              pf_esi_report),
    path("reports/employees",           employee_report),
    path("reports/headcount",           headcount_report),
    path("reports/settlement",          settlement_report),
    path("reports/new-joinings",        new_joinings_report),
]
