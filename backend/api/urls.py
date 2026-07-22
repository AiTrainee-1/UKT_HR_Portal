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
    salary_slip_bulk_pdf, salary_slip_bulk_email, salary_slip_bulk_progress_view,
)
from .company_documents_views import (
    document_settings_view, document_settings_list, document_settings_preview,
    offer_letter_pdf, offer_letter_email, experience_letter_pdf, salary_slip_pdf,
)
from .org_views import (
    branches, branch_detail,
    designations, designation_detail,
)
from .recruitment_views import (
    recruitment_dashboard, new_joinees,
    resignations, my_resignation, resignation_action, resignation_delete,
    manager_resignation_action, manager_pending_resignations,
    resignation_pdf, resignation_email,
    department_headcount, department_headcount_detail,
)
from .resume_screening_views import (
    rule_sets, rule_set_detail,
    upload_single, shortlist_candidate,
    upload_bulk, upload_bulk_progress,
    candidates, candidate_detail, candidate_resume,
    reject_email_all, interview_invite_single, interview_invite_bulk,
)
from .employee_documents_views import (
    employee_documents, upload_employee_document,
    delete_employee_document, employee_document_file, my_documents,
    document_completion_stats,
)
from .manager_views import (
    department_managers, department_manager_detail,
    manager_department_assignments, manager_employee_assignments,
    manager_me, manager_pending_requests,
    manager_update_leave_status, manager_update_permission_status,
    manager_update_attendance_status, manager_update_casual_leave_status,
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
    sync_biometric_api, sync_biometric_progress, attendance_report_log, compute_shift_logs,
    attendance_late_summary, employee_shift_monthly_stats,
)
from .growth_views import (
    employee_monthly_attendance, attendance_day_override, attendance_override_requests,
    promotions, promotion_detail,
    increment_summary, add_increment, increment_dashboard,
    idcard_data, verify_employee, email_idcard,
)
from .system_settings_views import (
    biometric_devices, biometric_device_detail, idcard_settings_view,
    production_shift_config_view, production_shift_segments, production_shift_segment_detail,
)
from .casual_leave_views import (
    casual_leaves, casual_leave_detail, casual_leave_eligibility,
)
from .night_shift_views import (
    night_shift_dashboard, night_shift_recompute,
    night_shift_rules, night_shift_rule_detail,
)
from .payroll_views import (
    session_configs, session_config_detail,
    attendance_logs, process_punch_sessions,
    work_sessions, work_session_detail,
    payroll_list, generate_payroll, generate_payroll_progress, payroll_detail, payroll_breakdown,
    payroll_skip_check,
    seed_attendance, payroll_settings_view,
)
from .manual_attendance_import_views import export_punch_records, import_punch_excel
from .chat_views import (
    chat_channels, chat_messages, chat_message_reactions,
)
from .backup_views import backup_status, run_backup

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
    path("employees/bulk-upload", views.bulk_upload_employees),
    path("employees/bulk-update", views.bulk_update_employees),

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
    path("salary-slips/bulk-pdf", salary_slip_bulk_pdf),
    path("salary-slips/bulk-email", salary_slip_bulk_email),
    path("salary-slips/bulk-progress", salary_slip_bulk_progress_view),
    path("salary-slips/<int:pk>", salary_slip_detail),
    path("salary-slips/<int:pk>/email", email_salary_slip),
    path("salary-slips/<int:pk>/pdf", salary_slip_pdf),
    path("my/salary-slips", employee_salary_slips),
    path("my/documents", my_documents),

    # ── Company Documents (Offer Letter / Experience Letter / Salary Slip theming) ──
    path("document-settings", document_settings_list),
    path("document-settings/<str:doc_type>", document_settings_view),
    path("document-settings/<str:doc_type>/preview", document_settings_preview),
    path("employees/<int:employee_id>/offer-letter/pdf", offer_letter_pdf),
    path("employees/<int:employee_id>/offer-letter/email", offer_letter_email),
    path("employees/<int:employee_id>/experience-letter/pdf", experience_letter_pdf),

    # ── Notifications ───────────────────────────────────────────────────────
    path("notifications", views.notifications),
    path("notifications/<int:pk>/read", views.mark_notification_read),
    path("my/push-token", views.register_push_token),

    # ── Recruitment ─────────────────────────────────────────────────────────
    path("jobs", views.jobs),
    path("jobs/<int:pk>", views.job_detail),
    path("applicants", views.applicants),
    path("applicants/<int:pk>/status", views.update_applicant_status),
    path("recruitment/dashboard", recruitment_dashboard),
    path("recruitment/new-joinees", new_joinees),
    path("recruitment/resignations", resignations),
    path("recruitment/resignations/<int:pk>/action", resignation_action),
    path("recruitment/resignations/<int:pk>/delete", resignation_delete),
    path("recruitment/resignations/<int:pk>/pdf", resignation_pdf),
    path("recruitment/resignations/<int:pk>/email", resignation_email),
    path("recruitment/department-headcount", department_headcount),
    path("recruitment/department-headcount/<int:pk>", department_headcount_detail),
    path("recruitment/resume-screening/rule-sets", rule_sets),
    path("recruitment/resume-screening/rule-sets/<int:pk>", rule_set_detail),
    path("recruitment/resume-screening/upload-single", upload_single),
    path("recruitment/resume-screening/upload-bulk", upload_bulk),
    path("recruitment/resume-screening/upload-bulk-progress", upload_bulk_progress),
    path("recruitment/resume-screening/candidates", candidates),
    path("recruitment/resume-screening/candidates/<int:pk>", candidate_detail),
    path("recruitment/resume-screening/candidates/<int:pk>/shortlist", shortlist_candidate),
    path("recruitment/resume-screening/candidates/<int:pk>/resume", candidate_resume),
    path("recruitment/resume-screening/candidates/<int:pk>/interview-invite", interview_invite_single),
    path("recruitment/resume-screening/candidates/reject-email-all", reject_email_all),
    path("recruitment/resume-screening/candidates/interview-invite-bulk", interview_invite_bulk),
    path("recruitment/employee-documents/completion-stats", document_completion_stats),
    path("recruitment/employee-documents/<int:employee_id>", employee_documents),
    path("recruitment/employee-documents/<int:employee_id>/upload", upload_employee_document),
    path("employee-documents/<int:pk>", delete_employee_document),
    path("employee-documents/<int:pk>/file", employee_document_file),
    path("my/resignation", my_resignation),
    path("manager/resignations", manager_pending_resignations),
    path("manager/resignations/<int:pk>/action", manager_resignation_action),

    # ── Attendance ──────────────────────────────────────────────────────────
    path("attendance", views.attendance),
    path("attendance/summary", attendance_summary),
    path("attendance/daily", attendance_daily),
    path("attendance/monthly-trend", attendance_monthly_trend),
    path("attendance/employee/<int:pk>", attendance_employee_history),
    path("attendance/manual", manual_attendance),
    path("attendance/sync-biometric", sync_biometric_api),
    path("attendance/sync-biometric-progress", sync_biometric_progress),
    path("attendance/manual-import/export", export_punch_records),
    path("attendance/manual-import/upload", import_punch_excel),
    path("attendance/report-log", attendance_report_log),
    path("attendance/compute-shifts", compute_shift_logs),
    path("attendance/late-summary", attendance_late_summary),
    path("attendance/employee-shift-stats", employee_shift_monthly_stats),
    path("attendance/employee-monthly", employee_monthly_attendance),
    path("attendance/override", attendance_day_override),
    path("attendance/override-requests", attendance_override_requests),
    path("biometric/punch", biometric_punch),

    # ── Casual Leave (CL) ───────────────────────────────────────────────────
    path("casual-leaves", casual_leaves),
    path("casual-leaves/eligibility", casual_leave_eligibility),
    path("casual-leaves/<int:pk>", casual_leave_detail),

    # ── Night Shift Relaxation ──────────────────────────────────────────────
    path("night-shift/dashboard", night_shift_dashboard),
    path("night-shift/recompute", night_shift_recompute),
    path("night-shift/rules", night_shift_rules),
    path("night-shift/rules/<int:pk>", night_shift_rule_detail),

    # ── Growth: Promotions / Increments / ID Cards ─────────────────────────
    path("promotions", promotions),
    path("promotions/<int:pk>", promotion_detail),
    path("increments/summary", increment_summary),
    path("increments/dashboard", increment_dashboard),
    path("increments", add_increment),
    path("idcard", idcard_data),
    path("idcard/email", email_idcard),
    path("idcard-settings", idcard_settings_view),
    path("verify-employee/<str:code>", verify_employee),

    # ── Biometric Device Management ─────────────────────────────────────────
    path("biometric-devices", biometric_devices),
    path("biometric-devices/<int:pk>", biometric_device_detail),

    # ── Production Shift Workflow ────────────────────────────────────────────
    path("production-shift-config", production_shift_config_view),
    path("production-shift-segments", production_shift_segments),
    path("production-shift-segments/<int:pk>", production_shift_segment_detail),

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
    path("attendance-logs/process-sessions", process_punch_sessions),
    path("attendance-logs/seed", seed_attendance),
    path("work-sessions", work_sessions),
    path("work-sessions/<int:pk>", work_session_detail),
    path("payroll", payroll_list),
    path("payroll/skip-check", payroll_skip_check),
    path("payroll/generate", generate_payroll),
    path("payroll/generate-progress", generate_payroll_progress),
    path("payroll/<int:pk>/breakdown", payroll_breakdown),
    path("payroll/<int:pk>", payroll_detail),

    # ── Chat (mobile + HR portal company channel) ────────────────────────────
    path("chat/channels", chat_channels),
    path("chat/channels/<int:pk>/messages", chat_messages),
    path("chat/messages/<int:pk>/reactions", chat_message_reactions),

    # ── Database Backup (Settings → Backup) ──────────────────────────────────
    path("backup", backup_status),
    path("backup/run", run_backup),

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
    path("manager/attendance-requests/<int:pk>/status", manager_update_attendance_status),
    path("manager/casual-leaves/<int:pk>/status", manager_update_casual_leave_status),

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
