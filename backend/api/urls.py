from django.http import JsonResponse
from django.urls import include, path
from .md_portal.assistant.admin_views import assistant_settings as md_assistant_settings, assistant_test as md_assistant_test

from . import views


def api_index(request):
    """Landing response for /api/ itself (no trailing path) -otherwise this
    401s/404s at the exact URL people naturally hit first when checking the
    backend is up, since every real route below needs a path segment after
    'api/'."""
    return JsonResponse({"status": "ok", "service": "UK Textiles HRMS API", "health": "/api/healthz"})
from .shift_views import (
    shift_templates, shift_template_detail,
    shift_assignments, shift_assignment_detail,
    bulk_shift_assignments, sync_production_shifts,
    shift_assignment_plan, shift_assignment_apply, end_shift_assignments,
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
from .approval_workflow_views import approval_summary, approval_workflow_detail, approval_workflows
from .login_sessions_views import login_sessions, revoke_login_session
from .whatsapp_test_views import whatsapp_connection, whatsapp_test_message
from .push_recipients_views import phone_alert_settings, push_recipients_employees, push_recipients_settings
from .push_templates_views import push_template_preview, push_template_update, push_templates_list
from .mobile_messages_views import (
    mobile_messages_controls, mobile_messages_devices, mobile_messages_log, mobile_messages_overview,
    mobile_messages_send, mobile_messages_push_again, mobile_messages_mute, mobile_messages_remove_phone,
    mobile_messages_config,
)
from .mobile_app_version_views import (
    mobile_app_latest_version, mobile_app_version_detail, mobile_app_versions,
)
from .mobile_login_views import (
    mobile_app_logins, mobile_app_logins_export, mobile_app_reset_password,
)
from .theme_views import theme_settings, update_theme_settings
from .co_portal_views import (
    co_portal_employees, co_portal_attendance_logs,
    co_portal_departments, co_portal_designations, co_portal_branches,
)
from .hr_user_views import (
    roles, role_detail,
    hr_users, hr_user_detail,
    master_hr_users, master_hr_user_flags,
    audit_logs, audit_logs_stats,
)
from .salary_slip_views import (
    salary_slips, salary_slip_detail, email_salary_slip, employee_salary_slips,
    salary_slip_bulk_pdf, salary_slip_bulk_email, salary_slip_bulk_progress_view,
    whatsapp_salary_slip, salary_slip_bulk_whatsapp, salary_slip_bulk_whatsapp_progress,
)
from .company_documents_views import (
    document_settings_view, document_settings_list, document_settings_preview,
    offer_letter_pdf, offer_letter_email, experience_letter_pdf, salary_slip_pdf,
    offer_letter_whatsapp, experience_letter_whatsapp,
)
from .otp_views import login_options, otp_activate, otp_login, otp_request, otp_reset_password
from .whatsapp_control_views import (
    whatsapp_control_settings,
    whatsapp_employee_opt_out, whatsapp_employees, whatsapp_messages, whatsapp_overview,
    whatsapp_queue, whatsapp_queue_clear, whatsapp_usage,
    whatsapp_meta_templates, whatsapp_meta_templates_sync, whatsapp_meta_templates_create_missing,
    whatsapp_meta_template_draft, whatsapp_meta_template_delete,
)
from .support_contact_views import support_contact
from .sms_control_views import sms_messages, sms_overview, sms_settings, sms_test, sms_usage
from .shared_endpoint_views import shared_endpoint
from . import shared_endpoint_admin_views as shared_admin
from .email_control_views import (
    email_control_settings, email_control_template_preview, email_control_template_update,
    email_control_templates, email_control_test,
    email_employees, email_messages, email_overview,
)
from .hr_requests_views import hr_requests
from .hr_activity_views import hr_activity
from .whatsapp_views import whatsapp_webhook
from .branch_summary_views import branches_summary
from .org_structure_views import (
    departments_overview, department_employees,
    designations_tree, designation_employees,
)
from .org_views import (
    branches, branch_detail,
    designations, designation_detail,
)
from .department_views import assign_department, assign_designation
from .recruitment_views import (
    recruitment_dashboard, new_joinees,
    resignations, my_resignation, resignation_action, resignation_delete,
    manager_resignation_action, manager_pending_resignations,
    resignation_pdf, resignation_email, resignation_whatsapp,
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
    document_completion_stats, whatsapp_employee_document,
)
from .manager_views import (
    department_managers, department_manager_detail,
    manager_department_assignments, manager_employee_assignments,
    manager_department_employees, manager_excluded_employees,
    manager_me, manager_pending_requests,
    manager_update_leave_status, manager_update_permission_status,
    manager_update_attendance_status, manager_update_casual_leave_status,
    manager_update_on_duty_status, manager_update_missing_punch_status,
    manager_update_outpass_status,
)
from .outpass_request_views import outpass_requests, outpass_request_hr_status, generate_return_qr
from .family_views import my_family
from .gate_scanner_views import gate_login_info, gate_login, gate_scan, gate_scan_log
# Gate Pass / Visitors / Tea Break rebuild (2026-11-18): one module per slice, see the per-slice URL blocks below
from .gate_admin_views import (
    gate_devices, gate_device_detail, gate_device_reveal_password, gate_device_sign_out,
    gate_devices_summary, gate_devices_records, gate_devices_records_export, gate_devices_export,
)
from .gate_monitor_views import (
    gate_monitor_login, gate_monitor_me, gate_monitor_logout, gate_monitor_scan,
    gate_monitor_summary, gate_monitor_records, gate_monitor_records_export,
)
from .outpass_inout_views import (
    outpass_in_out, outpass_in_out_summary, outpass_in_out_detail, outpass_in_out_export, outpass_in_out_options,
)
from .visitor_admin_views import (
    visitor_visits_create, visitor_visit_detail, visitor_visit_check_out, visitor_people, visitor_export,
    reception_visit_check_out,
)
from .tea_break_admin_views import (
    tea_break_records_summary, tea_break_record_detail, tea_break_records_employees,
    tea_break_records_export, tea_break_records_options,
)
from .tea_break_views import (
    tea_break_qr_token, tea_break_my_status, tea_break_rule, tea_break_summary, tea_break_records,
)
from .geo_attendance_views import (
    geo_punch, geo_punch_precheck, geo_punch_status, live_location_ping,
    on_duty_session_request, on_duty_session_complete, on_duty_session_status,
    on_duty_punch_request,
    on_duty_sessions_hr, on_duty_session_hr_status, on_duty_session_punches_hr_status,
    on_duty_punch_verifications_hr, on_duty_punch_verification_hr_status, on_duty_punch_verification_photo,
    live_location_team, live_location_trail, live_location_route, on_duty_map,
)
from .geo_tracking import alert_views as geo_tracking_alerts, hr_views as geo_tracking_hr, views as geo_tracking_views
from .reports_views import (
    attendance_report, attendance_summary_report,
    leave_report, leave_balance_report,
    payroll_report, pf_esi_report,
    employee_report, headcount_report,
    settlement_report, new_joinings_report,
)
from .reporting.views import reports_catalog, reports_run, reports_export, reports_options
from .reporting.custom.views import (
    custom_datasets, custom_preview, custom_saved, custom_saved_detail, custom_saved_duplicate,
)
from .outpass_visitor_views import (
    outpass_qr, outpass_summary, outpass_records, outpass_gate_info, outpass_gate_submit,
    visitor_qr, visitor_summary, visitor_records, visitor_gate_info,
    visitor_check_phone, visitor_check_employee_phone, visitor_gate_new, visitor_gate_repeat,
)
from .reception_views import (
    reception_login_info, reception_login, reception_me, reception_logout,
    reception_summary, reception_visits, reception_visits_export, reception_host_lookup, reception_visitor_lookup,
)
# Visitors -> Manage Reception (HR side of the reception desks, 18 Nov 2026)
from .reception_admin_views import (
    reception_devices, reception_device_detail, reception_device_reveal_password, reception_device_sign_out,
    reception_devices_overview, reception_devices_records, reception_devices_records_export, reception_devices_export,
)
from .production_special_shifts_views import (
    production_shifts_overview, production_special_shifts, production_special_shift_detail,
    production_special_shift_assign, production_special_assignment_end, production_special_assignment_detail,
)
from .attendance_views import (
    attendance_summary, attendance_daily, attendance_monthly_trend,
    attendance_employee_history, biometric_punch, manual_attendance,
    attendance_employee_punches, attendance_monthly_summary,
    sync_biometric_api, sync_biometric_progress, attendance_report_log, attendance_report_log_sheet,
    attendance_production_report_log, attendance_production_report_log_sheet,
    set_production_day_informed, report_log_day_punches, production_report_log_day_punches,
    set_day_informed, compute_shift_logs,
    attendance_search, attendance_search_range,
    attendance_late_summary, employee_shift_monthly_stats, attendance_sync_status,
    mobile_home_summary, attendance_live_feed,
    attendance_company_summary,
)
from .growth_views import (
    employee_monthly_attendance, attendance_day_override, attendance_override_requests,
    promotions, promotion_detail,
    increment_summary, add_increment, increment_dashboard, increment_history,
    bonus_calculate, bonus_generate, bonus_list, bonus_detail, bonus_export,
    idcard_data, verify_employee, email_idcard, idcard_whatsapp,
)
from .compensation_views import (
    compensation_list,
    overtime_list, overtime_announce, overtime_assign, overtime_reject,
    balance_redeem,
    compensation_credits_list, compensation_credit_redeem,
    compensation_leave_days, compensation_leave_day_detail,
    compensation_summary,
)
from .compensation_settings_views import compensation_config, compensation_settings
from .production_shift_rules_views import production_shift_rules, production_shift_rules_preview
# Compensation overhaul (claims, announced windows, birthdays, reports, employee apps): see the block of routes below.
from .compensation_birthday_views import compensation_birthdays
from .compensation_reports_views import compensation_reports
from .compensation_windows_views import compensation_window_detail, compensation_windows
from .employee_compensation_views import employee_compensation, employee_hod
from .holiday_work_views import holiday_work_claim_detail, holiday_work_claims, holiday_work_eligible
from .manager_views import manager_update_holiday_work_status
# Compensation claims, every kind (2026-11-19): see the "Compensation claims" block of routes below.
from .compensation_claims_views import (
    compensation_balance_overview, compensation_claim_detail, compensation_claims, compensation_ledger, compensation_use,
    employee_compensation_claim_detail, employee_compensation_claims, employee_compensation_use, holiday_work_month,
)
from .system_settings_views import (
    biometric_devices, biometric_device_detail, idcard_settings_view,
    production_shift_config_view, production_shift_segments, production_shift_segment_detail,
)
from .casual_leave_views import (
    casual_leaves, casual_leave_detail, casual_leave_eligibility, my_casual_leave_eligibility,
    casual_leave_history, casual_leave_policy,
)
from .cl_adjustment_views import casual_leave_absent_dates, casual_leave_adjustments, casual_leave_assign
from .missing_punch_views import (
    missing_punch_requests, missing_punch_request_hr_status,
)
from .auto_sync_views import auto_sync_rules, auto_sync_rule_detail
from .production_employee_views import (
    assign_production_pay_cycle,
    production_cycle_change_preview,
    production_employee_transfers,
    production_employees,
)
from .production_payroll_views import (
    production_cycles_summary, production_next_period, production_generate_payroll,
    production_period_status, production_periods,
    production_skip_check, production_payroll_list,
    production_payroll_detail, production_payroll_breakdown, production_generate_progress,
)
from .production_period_workflow_views import (
    production_period_workflow, production_period_finalize, production_period_paid, production_period_unlock,
    production_new_joiners, production_new_joiners_add, production_moved_out,
)
from .payroll_insights_views import (
    staff_payroll_details, staff_payroll_issues, staff_payroll_rules,
    production_payroll_details, production_payroll_issues, production_payroll_rules,
)
from .payroll_statement_views import staff_salary_statement, production_salary_statement
from .payroll_month_workflow_views import (
    payroll_month_status, payroll_month_skipped, payroll_hold, payroll_add_to_payroll, payroll_release_and_pay,
    payroll_month_finalize, payroll_month_paid, payroll_month_unlock,
)
from .pf_esi_coverage_export import pf_esi_coverage_export
from .pf_esi_views import pf_esi_coverage, pf_esi_settings
from .tds_views import tds_employee_detail, tds_employees
from .payroll_views import (
    session_configs, session_config_detail,
    attendance_logs, process_punch_sessions,
    work_sessions, work_session_detail,
    payroll_list, generate_payroll, generate_payroll_progress, payroll_detail, payroll_breakdown,
    payroll_skip_check,
    seed_attendance, payroll_settings_view,
)
from .manual_attendance_import_views import export_punch_records, import_punch_excel
from .punch_history import punch_day_status, punch_history
from .attendance_edit_views import attendance_edit_context, attendance_override_decision
from .punch_views import (
    skipped_punches, resolve_skipped_punch,
    punch_list, punch_export, punch_import, sync_status,
)
from .device_status_views import biometric_status, biometric_status_check, biometric_status_history
from .device_control_views import (
    device_control_delete_users, device_control_employee_photo, device_control_employee_links, device_control_links, device_control_links_summary, device_control_links_history, device_control_users_history, device_control_fetch_employees,
    device_control_fetch_run,
    device_control_fetch_runs, device_control_fetch_start, device_control_overview, device_control_people,
    device_control_push_users, device_control_refresh_users, device_control_update_users,
)
from .connector_admin_views import (
    device_control_connector_detail, device_control_connector_pairing, device_control_connectors,
    device_control_operation,
)
from .connector_views import (
    connector_job_punches, connector_job_result, connector_pair, connector_poll, connector_punches,
)
from .chat_views import (
    chat_channels, chat_messages, chat_message_reactions,
)
from .backup_views import (
    backup_status, run_backup, download_backup, backup_schedule_view, backup_drive_view,
    backup_drive_test, backup_restore_validate, backup_restore_run, backup_restore_status,
)

urlpatterns = [
    path("", api_index),

    # ── Health ──────────────────────────────────────────────────────────────
    path("healthz", views.healthz),

    # ── Auth ────────────────────────────────────────────────────────────────
    path("auth/hr-login", views.hr_login),
    path("auth/employee-login", views.employee_login),
    path("auth/set-password", views.set_password),
    path("auth/login-options", login_options),
    path("auth/otp/request", otp_request),
    path("auth/otp/login", otp_login),
    path("auth/otp/reset-password", otp_reset_password),
    path("auth/otp/activate", otp_activate),
    path("auth/me", views.auth_me),
    path("auth/logout", views.logout),

    # ── Organisation ────────────────────────────────────────────────────────
    path("branches", branches),
    path("branches/<int:pk>", branch_detail),
    path("branches/summary", branches_summary),
    path("departments", views.departments),
    path("departments/<int:pk>", views.delete_department),
    path("departments/overview", departments_overview),
    path("departments/<int:pk>/employees", department_employees),
    # Set one employee's department / designation from the two org pages (department_views.py): under the pages' own
    # prefixes, so they take employees.departments / employees.designations edit rather than the Employees module.
    path("departments/assign", assign_department),
    path("designations", designations),
    path("designations/<int:pk>", designation_detail),
    path("designations/tree", designations_tree),
    path("designations/<int:pk>/employees", designation_employees),
    path("designations/assign", assign_designation),

    # ── Employees ───────────────────────────────────────────────────────────
    path("employees", views.employees),
    path("employees/production", production_employees),
    path("employees/production/assign", assign_production_pay_cycle),
    path("employees/production/cycle-change-preview", production_cycle_change_preview),
    path("employees/production/<int:pk>/transfers", production_employee_transfers),
    path("employees/<int:pk>", views.employee_detail),
    path("employees/<int:pk>/photo", views.employee_photo),
    path("employees/<int:pk>/status", views.employee_status),
    path("employees/bulk-upload", views.bulk_upload_employees),
    path("employees/bulk-update", views.bulk_update_employees),
    path("employees/location-tracking/bulk", views.bulk_location_tracking),

    # ── Shift Management ────────────────────────────────────────────────────
    path("shifts", shift_templates),
    path("shifts/<int:pk>", shift_template_detail),
    # Production shifts (owner 2026-11-16): the Settings shift groups as the default shifts + special shifts
    path("shifts/production", production_shifts_overview),
    path("shifts/production/special", production_special_shifts),
    path("shifts/production/special/<int:pk>", production_special_shift_detail),
    path("shifts/production/special/<int:pk>/assign", production_special_shift_assign),
    path("shifts/production/special-assignments/<int:pk>/end", production_special_assignment_end),
    path("shifts/production/special-assignments/<int:pk>", production_special_assignment_detail),
    path("shift-assignments", shift_assignments),
    path("shift-assignments/bulk", bulk_shift_assignments),
    path("shift-assignments/plan", shift_assignment_plan),
    path("shift-assignments/apply", shift_assignment_apply),
    path("shift-assignments/end", end_shift_assignments),
    path("shift-assignments/sync-production", sync_production_shifts),
    path("shift-assignments/<int:pk>", shift_assignment_detail),

    # ── Requests hub (read-only, every kind of request in one list) ─────────
    path("hr-requests", hr_requests),
    # HR Assistant activity (Super Admin + HR Managers; the view checks who may look): hr_activity_views.py
    path("hr-activity", hr_activity),

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
    path("salary-slips/bulk-whatsapp", salary_slip_bulk_whatsapp),
    path("salary-slips/bulk-whatsapp-progress", salary_slip_bulk_whatsapp_progress),
    path("salary-slips/<int:pk>", salary_slip_detail),
    path("salary-slips/<int:pk>/email", email_salary_slip),
    path("salary-slips/<int:pk>/whatsapp", whatsapp_salary_slip),
    path("salary-slips/<int:pk>/pdf", salary_slip_pdf),
    path("my/salary-slips", employee_salary_slips),
    path("my/documents", my_documents),

    # ── Company Documents (Offer Letter / Experience Letter / Salary Slip theming) ──
    path("document-settings", document_settings_list),
    path("document-settings/<str:doc_type>", document_settings_view),
    path("document-settings/<str:doc_type>/preview", document_settings_preview),
    path("employees/<int:employee_id>/offer-letter/pdf", offer_letter_pdf),
    path("employees/<int:employee_id>/offer-letter/email", offer_letter_email),
    path("employees/<int:employee_id>/offer-letter/whatsapp", offer_letter_whatsapp),
    path("employees/<int:employee_id>/experience-letter/pdf", experience_letter_pdf),
    path("employees/<int:employee_id>/experience-letter/whatsapp", experience_letter_whatsapp),

    # ── Notifications ───────────────────────────────────────────────────────
    path("notifications", views.notifications),
    path("notifications/mark-all-read", views.mark_all_notifications_read),
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
    path("recruitment/resignations/<int:pk>/whatsapp", resignation_whatsapp),
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
    path("employee-documents/<int:pk>/whatsapp", whatsapp_employee_document),
    path("my/resignation", my_resignation),
    path("my/family", my_family),
    path("manager/resignations", manager_pending_resignations),
    path("manager/resignations/<int:pk>/action", manager_resignation_action),

    # ── Attendance ──────────────────────────────────────────────────────────
    path("attendance", views.attendance),
    path("attendance/summary", attendance_summary),
    path("attendance/company-summary", attendance_company_summary),
    path("attendance/daily", attendance_daily),
    path("dashboard/mobile-home-summary", mobile_home_summary),
    path("attendance/live-feed", attendance_live_feed),
    path("attendance/monthly-trend", attendance_monthly_trend),
    path("attendance/employee/<int:pk>", attendance_employee_history),
    # every punch of one employee's month, and the per-employee monthly report (Staff / Production Attendance page)
    path("attendance/employee-punches", attendance_employee_punches),
    path("attendance/monthly-summary", attendance_monthly_summary),
    path("attendance/manual", manual_attendance),
    path("attendance/sync-status", attendance_sync_status),
    path("attendance/sync-biometric", sync_biometric_api),
    path("attendance/sync-biometric-progress", sync_biometric_progress),
    path("auto-sync-rules", auto_sync_rules),
    path("auto-sync-rules/<int:pk>", auto_sync_rule_detail),
    path("attendance/manual-import/export", export_punch_records),
    path("attendance/manual-import/upload", import_punch_excel),

    # ── Attendance page: Skipped / Punch View / Sync / Errors ────────────
    # Database-only replacements for the device-dependent features. None of
    # these contact a biometric device, so they work from a cloud-hosted
    # backend -see api/punch_views.py.
    path("attendance/skipped-punches", skipped_punches),
    path("attendance/skipped-punches/<int:pk>/resolve", resolve_skipped_punch),
    path("attendance/punches", punch_list),
    path("attendance/punches/export", punch_export),
    path("attendance/punches/import", punch_import),
    path("attendance/punches/day-status", punch_day_status),
    path("attendance/punches/history", punch_history),
    path("attendance/sync-status-live", sync_status),
    # Biometric Device Status page: what each device sends this server, and a connection check from this server.
    path("attendance/biometric-status", biometric_status),
    path("attendance/biometric-status/check", biometric_status_check),
    path("attendance/biometric-status/<int:pk>/history", biometric_status_history),
    path("attendance/device-control/overview", device_control_overview),
    path("attendance/device-control/people", device_control_people),
    path("attendance/device-control/users/refresh", device_control_refresh_users),
    path("attendance/device-control/users/push", device_control_push_users),
    path("attendance/device-control/users/update", device_control_update_users),
    path("attendance/device-control/users/delete", device_control_delete_users),
    path("attendance/device-control/employees/<int:pk>/photo", device_control_employee_photo),
    path("attendance/device-control/employees/<int:pk>/links", device_control_employee_links),
    path("attendance/device-control/links", device_control_links),
    path("attendance/device-control/links/summary", device_control_links_summary),
    path("attendance/device-control/links/history", device_control_links_history),
    path("attendance/device-control/users/history", device_control_users_history),
    path("attendance/device-control/fetch/employees", device_control_fetch_employees),
    path("attendance/device-control/fetch/start", device_control_fetch_start),
    path("attendance/device-control/fetch/runs", device_control_fetch_runs),
    path("attendance/device-control/fetch/runs/<int:pk>", device_control_fetch_run),
    path("attendance/device-control/connectors", device_control_connectors),
    path("attendance/device-control/connectors/<int:pk>", device_control_connector_detail),
    path("attendance/device-control/connectors/<int:pk>/pairing", device_control_connector_pairing),
    path("attendance/device-control/operations/<int:pk>", device_control_operation),

    # ── Site Connectors: what the Windows service at a factory calls (its own token, not an HR login) ──
    path("connector/pair", connector_pair),
    path("connector/poll", connector_poll),
    path("connector/jobs/<int:pk>/result", connector_job_result),
    path("connector/jobs/<int:pk>/punches", connector_job_punches),
    path("connector/punches", connector_punches),
    path("attendance/report-log", attendance_report_log),
    path("attendance/report-log/sheet", attendance_report_log_sheet),
    path("attendance/report-log/day-punches", report_log_day_punches),
    # Production Report Log (owner 2026-11-16): the same reports for production employees, at their own addresses
    path("attendance/production-report-log", attendance_production_report_log),
    path("attendance/production-report-log/sheet", attendance_production_report_log_sheet),
    path("attendance/production-report-log/day-punches", production_report_log_day_punches),
    path("attendance/production-report-log/day-informed", set_production_day_informed),
    path("attendance/day-informed", set_day_informed),

    # ── Outpass / Visitors -pure gate data-collection, see outpass_visitor_views.py ──
    path("outpass/qr", outpass_qr),
    path("outpass/summary", outpass_summary),
    path("outpass/records", outpass_records),
    path("outpass/gate/<str:token>", outpass_gate_info),
    path("outpass/gate/<str:token>/submit", outpass_gate_submit),
    path("visitor/qr", visitor_qr),
    path("visitor/summary", visitor_summary),
    path("visitor/records", visitor_records),
    path("visitor/gate/<str:token>", visitor_gate_info),
    path("visitor/gate/<str:token>/check-phone", visitor_check_phone),
    path("visitor/gate/<str:token>/check-employee-phone", visitor_check_employee_phone),
    path("visitor/gate/<str:token>/new", visitor_gate_new),
    path("visitor/gate/<str:token>/repeat", visitor_gate_repeat),

    # ── Gate Pass -> In/Out (slice B2: outpass_inout_views.py; key outpass_visitors.outpass.in_out). Literal paths
    #    before <int:pk> ──────────────────────────────────────────────────
    path("outpass/in-out", outpass_in_out),
    path("outpass/in-out/summary", outpass_in_out_summary),
    path("outpass/in-out/export", outpass_in_out_export),
    path("outpass/in-out/options", outpass_in_out_options),
    path("outpass/in-out/<int:pk>", outpass_in_out_detail),

    # ── Visitors (slice C: visitor_admin_views.py; key outpass_visitors.visitors). visitor/records and
    #    visitor/summary above stay in outpass_visitor_views.py ─────────────────────────────────────────
    path("visitor/visits", visitor_visits_create),
    path("visitor/visits/<int:pk>", visitor_visit_detail),
    path("visitor/visits/<int:pk>/check-out", visitor_visit_check_out),
    path("visitor/people", visitor_people),
    path("visitor/export", visitor_export),

    # ── Reception desks, the desk's own side (reception_views.py): login-info/login are deliberately public; the rest
    #    is reception-device-authenticated (require_reception_device: the desk's session), never an HR token ────
    path("reception-devices/login-info/<str:login_token>", reception_login_info),
    path("reception-devices/login", reception_login),
    path("reception-devices/me", reception_me),
    path("reception-devices/logout", reception_logout),
    path("reception-devices/summary", reception_summary),
    path("reception-devices/visits", reception_visits),
    path("reception-devices/visits/export", reception_visits_export),
    path("reception-devices/host-lookup", reception_host_lookup),
    path("reception-devices/visitor-lookup", reception_visitor_lookup),
    # the desk's Check out (slice C: visitor_admin_views.py; desk-authenticated, never an HR token)
    path("reception-devices/visits/<int:pk>/check-out", reception_visit_check_out),
    # ── Visitors -> Manage Reception (HR, reception_admin_views.py; key outpass_visitors.visitors.reception_devices,
    #    the reveal is ...reception_devices.view_password). Literal paths before <int:pk> ─────────────────────
    path("reception-devices", reception_devices),
    path("reception-devices/overview", reception_devices_overview),
    path("reception-devices/records", reception_devices_records),
    path("reception-devices/records/export", reception_devices_records_export),
    path("reception-devices/export", reception_devices_export),
    path("reception-devices/<int:pk>", reception_device_detail),
    path("reception-devices/<int:pk>/reveal-password", reception_device_reveal_password),
    path("reception-devices/<int:pk>/sign-out", reception_device_sign_out),
    path("attendance/search", attendance_search),
    path("attendance/search/range", attendance_search_range),
    path("attendance/compute-shifts", compute_shift_logs),
    path("attendance/late-summary", attendance_late_summary),
    path("attendance/employee-shift-stats", employee_shift_monthly_stats),
    path("attendance/employee-monthly", employee_monthly_attendance),
    path("attendance/override", attendance_day_override),
    path("attendance/override-requests", attendance_override_requests),
    path("attendance/override-requests/<int:pk>", attendance_override_decision),
    path("attendance/edit-context", attendance_edit_context),
    path("biometric/punch", biometric_punch),

    # ── Co HRMS Portal (read-only external pull, X-Portal-Key auth) ─────────
    path("co-portal/employees", co_portal_employees),
    path("co-portal/attendance-logs", co_portal_attendance_logs),
    path("co-portal/departments", co_portal_departments),
    path("co-portal/designations", co_portal_designations),
    path("co-portal/branches", co_portal_branches),

    # ── Geo Attendance (location-based punching + live tracking) ────────────
    path("attendance/geo-punch", geo_punch),
    path("attendance/geo-punch/precheck", geo_punch_precheck),
    path("attendance/geo-punch/status", geo_punch_status),
    path("on-duty-sessions/request", on_duty_session_request),
    path("on-duty-sessions/complete", on_duty_session_complete),
    path("on-duty-sessions/status", on_duty_session_status),
    path("on-duty-sessions/punch", on_duty_punch_request),
    path("on-duty-sessions", on_duty_sessions_hr),
    path("on-duty-sessions/<int:pk>/status", on_duty_session_hr_status),
    path("on-duty-sessions/<int:pk>/punches", on_duty_session_punches_hr_status),
    path("on-duty-punch-verifications", on_duty_punch_verifications_hr),
    path("on-duty-punch-verifications/<int:pk>/status", on_duty_punch_verification_hr_status),
    path("on-duty-punch-verifications/<int:pk>/photo", on_duty_punch_verification_photo),
    path("on-duty-map", on_duty_map),
    path("live-location/ping", live_location_ping),
    path("live-location/team", live_location_team),
    path("live-location/team/<int:employee_id>/trail", live_location_trail),
    path("live-location/team/<int:employee_id>/route", live_location_route),

    # ── Geo-Tracking: our own on-duty route / stop / connectivity tracking (api/geo_tracking/) ──────────
    # Employee (employee token): state, consent, batch upload, own journeys.
    path("tracking/state", geo_tracking_views.tracking_state),
    path("tracking/consent", geo_tracking_views.tracking_consent),
    path("tracking/batch", geo_tracking_views.tracking_batch),
    path("tracking/my-journeys", geo_tracking_views.my_journeys),
    # HR (module geo_attendance; branch scoped; audit-logged): journeys, raw points, export, rebuild, the live feed.
    path("tracking/journeys", geo_tracking_hr.journeys_list),
    path("tracking/journeys/day-map", geo_tracking_hr.journeys_day_map),  # every journey of one day + its route (On-Duty Map)
    path("tracking/journeys/<int:pk>", geo_tracking_views.journey_detail),  # shared: an employee reads their own
    path("tracking/journeys/<int:pk>/points", geo_tracking_hr.journey_points),
    path("tracking/journeys/<int:pk>/trail", geo_tracking_hr.journey_trail),
    path("tracking/journeys/<int:pk>/export", geo_tracking_hr.journey_export),
    path("tracking/journeys/<int:pk>/rebuild", geo_tracking_hr.journey_rebuild),
    path("tracking/live", geo_tracking_hr.live_tracks),
    # The automatic tracking alerts' log (geo_tracking/alerts.py): the Live Map tab's (permission prefix tracking/live).
    path("tracking/live/alerts", geo_tracking_alerts.tracking_alerts),
    # The geo-tracking rules (permission module settings.attendance).
    path("tracking/settings", geo_tracking_hr.tracking_settings),

    # ── Casual Leave (CL) ───────────────────────────────────────────────────
    path("casual-leaves", casual_leaves),
    path("casual-leaves/eligibility", casual_leave_eligibility),
    path("casual-leaves/my-eligibility", my_casual_leave_eligibility),
    # the yearly balance (2026-11-02): its running history, and the entitlement + cut-over day (a setting)
    path("casual-leaves/history", casual_leave_history),
    path("casual-leaves/policy", casual_leave_policy),
    # Carry Forward (2026-11-04): HR adds carried-forward days to / deducts days from a balance, and the log of it
    path("casual-leaves/adjustments", casual_leave_adjustments),
    # ... and the absent dates HR may turn into Casual Leave, and turning them
    path("casual-leaves/absent-dates", casual_leave_absent_dates),
    path("casual-leaves/assign", casual_leave_assign),
    path("casual-leaves/<int:pk>", casual_leave_detail),

    # ── Missing Punch ────────────────────────────────────────────────────────
    path("missing-punch-requests", missing_punch_requests),
    path("missing-punch-requests/<int:pk>/status", missing_punch_request_hr_status),

    # ── Growth: Promotions / Increments / ID Cards ─────────────────────────
    path("promotions", promotions),
    path("promotions/<int:pk>", promotion_detail),
    path("increments/summary", increment_summary),
    path("increments/dashboard", increment_dashboard),
    path("increments/history", increment_history),
    path("increments", add_increment),
    path("bonus/calculate", bonus_calculate),
    path("bonus/generate", bonus_generate),
    path("bonus/export", bonus_export),
    path("bonus", bonus_list),
    path("bonus/<int:pk>", bonus_detail),
    path("compensation", compensation_list),
    path("compensation/ot", overtime_list),
    path("compensation/ot/announce", overtime_announce),
    path("compensation/ot/assign", overtime_assign),
    path("compensation/ot/reject", overtime_reject),
    # GET compensation/balance moved to compensation_claims_views (the Compensation claims block below); the HR direct
    # redeem stays here.
    path("compensation/balance/redeem", balance_redeem),
    # Settings -> Compensation (module `settings.compensation`) and its read-only twin for the page (module `compensation`)
    path("compensation/settings", compensation_settings),
    path("compensation/config", compensation_config),
    path("compensation/credits", compensation_credits_list),
    path("compensation/credits/<int:pk>/redeem", compensation_credit_redeem),
    path("compensation/leave-days", compensation_leave_days),
    path("compensation/leave-days/<int:pk>", compensation_leave_day_detail),
    path("compensation/summary", compensation_summary),
    # ── Compensation overhaul, claims / windows / birthdays / reports (permission module `compensation`) ──
    path("compensation/holiday-work", holiday_work_claims),
    path("compensation/holiday-work/eligible", holiday_work_eligible),
    # ── Compensation claims, every kind (2026-11-19, compensation_claims_views.py; permission keys under
    #    compensation.leave.holiday_work: claims / raise / balance / credits). Literal paths before <int:pk>. ──
    path("compensation/holiday-work/month", holiday_work_month),
    path("compensation/claims", compensation_claims),
    path("compensation/claims/<int:pk>", compensation_claim_detail),
    path("compensation/use", compensation_use),
    path("compensation/balance", compensation_balance_overview),
    path("compensation/ledger", compensation_ledger),
    # employee tokens (the mobile app / Employee Web App; allowlisted as employee/*)
    path("employee/compensation/claims", employee_compensation_claims),
    path("employee/compensation/claims/<int:pk>", employee_compensation_claim_detail),
    path("employee/compensation/use", employee_compensation_use),
    # ── end of the Compensation claims block ──
    path("compensation/holiday-work/<int:pk>", holiday_work_claim_detail),
    path("compensation/birthdays", compensation_birthdays),
    path("compensation/windows", compensation_windows),
    path("compensation/windows/<int:pk>", compensation_window_detail),
    path("compensation/reports", compensation_reports),
    # ── end of the Compensation overhaul claims / windows / birthdays / reports block ──
    path("idcard", idcard_data),
    path("idcard/email", email_idcard),
    path("idcard/whatsapp", idcard_whatsapp),
    path("idcard-settings", idcard_settings_view),

    # ── WhatsApp: Meta's webhook (whatsapp_views.whatsapp_webhook) ─────────────
    # Both spellings: the webhook URL is registered with the trailing-slash form, and APPEND_SLASH cannot redirect a
    # POST. (The old wording endpoints whatsapp/templates... are retired: the wording IS the approved Meta template.)
    path("whatsapp/webhook", whatsapp_webhook),
    path("whatsapp/webhook/", whatsapp_webhook),

    # ── WhatsApp Control page (HR portal) ────────────────────────────────────
    path("whatsapp-control/overview", whatsapp_overview),
    path("whatsapp-control/usage", whatsapp_usage),
    path("whatsapp-control/messages", whatsapp_messages),
    path("whatsapp-control/employees", whatsapp_employees),
    path("whatsapp-control/employees/<int:employee_id>/opt-out", whatsapp_employee_opt_out),
    path("whatsapp-control/settings", whatsapp_control_settings),
    # the send queue (whatsapp_dispatcher.py)
    path("whatsapp-control/queue", whatsapp_queue),
    path("whatsapp-control/queue/clear", whatsapp_queue_clear),
    # Send a test / Connection check (whatsapp_test_views.py)
    path("whatsapp-control/test-message", whatsapp_test_message),
    path("whatsapp-control/connection", whatsapp_connection),
    # Meta message templates (whatsapp_templates.py). The old "Message Text" wording endpoints
    # (whatsapp-control/templates...) are retired.
    path("whatsapp-control/meta-templates", whatsapp_meta_templates),
    path("whatsapp-control/meta-templates/sync", whatsapp_meta_templates_sync),
    path("whatsapp-control/meta-templates/create-missing", whatsapp_meta_templates_create_missing),
    path("whatsapp-control/meta-templates/draft/<str:type_key>", whatsapp_meta_template_draft),
    path("whatsapp-control/meta-templates/<int:pk>", whatsapp_meta_template_delete),

    # SMS Control page (HR portal): one-time codes by SMS through 2Factor
    path("sms-control/overview", sms_overview),
    path("sms-control/usage", sms_usage),
    path("sms-control/settings", sms_settings),
    path("sms-control/messages", sms_messages),
    path("sms-control/test", sms_test),

    # ── HR / software-support contacts for the employee apps (public, read-only) ──
    path("support-contact", support_contact),

    # ── Endpoint Sharing (Settings -> Endpoint Sharing) ──────────────────────────
    # The public call: API-key authenticated, no HR login, its own CORS (see shared_endpoint_views.py).
    path("shared/<str:slug>", shared_endpoint),
    # Management: super administrator only (shared_endpoint_admin_views.py).
    path("shared-endpoints/catalog", shared_admin.catalog),
    path("shared-endpoints/activity", shared_admin.activity),
    path("shared-endpoints", shared_admin.endpoints),
    path("shared-endpoints/<int:pk>", shared_admin.endpoint_detail),
    path("shared-endpoints/<int:pk>/keys", shared_admin.endpoint_keys),
    path("shared-endpoints/<int:pk>/keys/<int:kid>", shared_admin.endpoint_key_detail),
    path("shared-endpoints/<int:pk>/preview", shared_admin.endpoint_preview),
    path("shared-endpoints/<int:pk>/activity", shared_admin.endpoint_activity),
    path("shared-endpoints/<int:pk>/guide", shared_admin.endpoint_guide),

    # ── Gmail Control page (HR portal) ───────────────────────────────────────
    path("gmail-control/overview", email_overview),
    path("gmail-control/messages", email_messages),
    path("gmail-control/employees", email_employees),
    path("gmail-control/settings", email_control_settings),
    path("gmail-control/templates", email_control_templates),
    path("gmail-control/templates/<str:email_type>/preview", email_control_template_preview),
    path("gmail-control/templates/<str:email_type>", email_control_template_update),
    path("gmail-control/test-email", email_control_test),
    path("verify-employee/<str:code>", verify_employee),

    # ── Biometric Device Management ─────────────────────────────────────────
    path("biometric-devices", biometric_devices),
    path("biometric-devices/<int:pk>", biometric_device_detail),

    # ── Production Shift Workflow ────────────────────────────────────────────
    path("production-shift-config", production_shift_config_view),
    # Settings -> Production shifts (permission module `settings.attendance`): the shift table, breaks and grace that judge
    # production days from the effective date on. The preview is a POST that only reads (see READ_ONLY_POST_PATHS).
    path("production-shift-rules", production_shift_rules),
    path("production-shift-rules/preview", production_shift_rules_preview),
    path("production-shift-segments", production_shift_segments),
    path("production-shift-segments/<int:pk>", production_shift_segment_detail),

    # ── Dashboard ───────────────────────────────────────────────────────────
    path("dashboard/hr-summary", views.hr_dashboard_summary),
    path("dashboard/employee-summary", views.employee_dashboard_summary),
    path("dashboard/interview-summary", views.interview_summary),
    path("dashboard/salary-trends", views.salary_trends),

    # ── Enterprise Payroll Engine ────────────────────────────────────────────
    path("payroll-settings", payroll_settings_view),
    # PF & ESI rules (Settings -> PF & ESI) and the Co Emp / TDS categories they apply to: see pf_esi.py
    path("pf-esi-settings", pf_esi_settings),
    path("pf-esi/coverage", pf_esi_coverage),
    path("pf-esi/coverage/export", pf_esi_coverage_export),
    path("tds/employees", tds_employees),
    path("tds/employees/<int:pk>", tds_employee_detail),
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
    # Staff month workflow (2026-11-10): Hold / Unhold, new joiners, Payroll Done (lock), Mark as Paid, release & pay
    path("payroll/month-status", payroll_month_status),
    path("payroll/month-skipped", payroll_month_skipped),
    path("payroll/month-finalize", payroll_month_finalize),
    path("payroll/month-paid", payroll_month_paid),
    path("payroll/month-unlock", payroll_month_unlock),
    path("payroll/<int:pk>/hold", payroll_hold),
    path("payroll/<int:pk>/add-to-payroll", payroll_add_to_payroll),
    path("payroll/<int:pk>/release-and-pay", payroll_release_and_pay),
    path("payroll/production", production_payroll_list),
    path("payroll/production/cycles", production_cycles_summary),
    path("payroll/production/periods", production_periods),
    path("payroll/production/period-status", production_period_status),
    path("payroll/production/next-period", production_next_period),
    path("payroll/production/generate", production_generate_payroll),
    path("payroll/production/generate-progress", production_generate_progress),
    path("payroll/production/skip-check", production_skip_check),
    # The period workflow (2026-11-16, production_period_workflow.py): Payroll Done, Mark as Paid, New Joiners, Moved out
    path("payroll/production/period-workflow", production_period_workflow),
    path("payroll/production/period-finalize", production_period_finalize),
    path("payroll/production/period-paid", production_period_paid),
    path("payroll/production/period-unlock", production_period_unlock),
    path("payroll/production/new-joiners", production_new_joiners),
    path("payroll/production/new-joiners/add", production_new_joiners_add),
    path("payroll/production/moved-out", production_moved_out),
    # Payroll insights (read-only): details of one payroll, the issues payroll detected, the rules in force and the printed
    # Salary Statement. Staff under payroll/ (module `payroll`), production under payroll/production/ (`production_payroll`).
    path("payroll/issues", staff_payroll_issues),
    path("payroll/rules", staff_payroll_rules),
    path("payroll/salary-statement", staff_salary_statement),
    path("payroll/production/issues", production_payroll_issues),
    path("payroll/production/rules", production_payroll_rules),
    path("payroll/production/salary-statement", production_salary_statement),
    path("payroll/production/<int:pk>/details", production_payroll_details),
    path("payroll/production/<int:pk>/breakdown", production_payroll_breakdown),
    path("payroll/production/<int:pk>", production_payroll_detail),
    path("payroll/<int:pk>/details", staff_payroll_details),
    path("payroll/<int:pk>/breakdown", payroll_breakdown),
    path("payroll/<int:pk>", payroll_detail),

    # ── Chat (mobile + HR portal company channel) ────────────────────────────
    path("chat/channels", chat_channels),
    path("chat/channels/<int:pk>/messages", chat_messages),
    path("chat/messages/<int:pk>/reactions", chat_message_reactions),

    # ── Database Backup (Settings → Backup) ──────────────────────────────────
    path("backup", backup_status),
    path("backup/run", run_backup),
    path("backup/download/<str:filename>", download_backup),
    path("backup/schedule", backup_schedule_view),
    path("backup/drive", backup_drive_view),
    path("backup/drive/test", backup_drive_test),
    path("backup/restore/validate", backup_restore_validate),
    path("backup/restore/run", backup_restore_run),
    path("backup/restore/status", backup_restore_status),

    # ── User Management ─────────────────────────────────────────────────────
    path("roles", roles),
    path("roles/<int:pk>", role_detail),
    path("hr-users", hr_users),
    # Master page -stricter guard (ADMIN_USERNAME only), declared before
    # the <int:pk> route so "master" is never parsed as a user id.
    path("hr-users/md-assistant", md_assistant_settings),
    path("hr-users/md-assistant/test", md_assistant_test),
    path("hr-users/master", master_hr_users),
    path("hr-users/<int:pk>/master-flags", master_hr_user_flags),
    path("hr-users/<int:pk>", hr_user_detail),

    # ── Department Managers ──────────────────────────────────────────────────
    path("approval-workflows", approval_workflows),
    path("approval-workflows/<str:key>", approval_workflow_detail),
    path("approval-summary", approval_summary),
    path("department-managers", department_managers),
    path("department-managers/<int:pk>", department_manager_detail),
    path("department-managers/<int:pk>/departments", manager_department_assignments),
    path("department-managers/<int:pk>/employees", manager_employee_assignments),
    path("department-managers/<int:pk>/department-employees", manager_department_employees),
    path("department-managers/<int:pk>/excluded-employees", manager_excluded_employees),

    # ── Mobile: Manager profile + approvals ──────────────────────────────────
    path("manager/me", manager_me),
    path("manager/pending-requests", manager_pending_requests),
    path("manager/leave-requests/<int:pk>/status", manager_update_leave_status),
    path("manager/permissions/<int:pk>/status", manager_update_permission_status),
    path("manager/attendance-requests/<int:pk>/status", manager_update_attendance_status),
    path("manager/casual-leaves/<int:pk>/status", manager_update_casual_leave_status),
    path("manager/on-duty-sessions/<int:pk>/status", manager_update_on_duty_status),
    path("manager/missing-punch-requests/<int:pk>/status", manager_update_missing_punch_status),
    path("manager/outpass-requests/<int:pk>/status", manager_update_outpass_status),
    # Compensation overhaul: the HOD decides a Holiday / Sunday work claim, and the employee apps' compensation / HOD pages
    path("manager/holiday-work/<int:pk>/status", manager_update_holiday_work_status),
    path("employee/compensation", employee_compensation),
    path("employee/hod", employee_hod),

    # ── Outpass Approval -employee-requested (or On-Duty-derived) Outpass,
    #    approved by either HOD (manager/outpass-requests above) or HR ────────
    path("outpass-requests", outpass_requests),
    path("outpass-requests/<int:pk>/hr-status", outpass_request_hr_status),
    path("outpass-requests/<int:pk>/generate-return-qr", generate_return_qr),

    # ── Gate Scanner -per-gate kiosk login + QR exit verification, see
    #    gate_scanner_views.py. login-info/login/scan are deliberately public
    #    or gate-device-authenticated, not HR-token-authenticated ───────────
    path("gate-devices/login-info/<str:login_token>", gate_login_info),
    path("gate-devices/login", gate_login),
    path("gate-devices/scan", gate_scan),
    path("gate-devices/scan-log", gate_scan_log),

    # ── Manage Gates (slice B1: gate_admin_views.py; key outpass_visitors.outpass.gate_devices, the reveal is
    #    ...gate_devices.view_password). Literal paths before <int:pk> ─────────────────────────────────────
    path("gate-devices", gate_devices),
    path("gate-devices/summary", gate_devices_summary),
    path("gate-devices/records", gate_devices_records),
    path("gate-devices/records/export", gate_devices_records_export),
    path("gate-devices/export", gate_devices_export),
    path("gate-devices/<int:pk>", gate_device_detail),
    path("gate-devices/<int:pk>/reveal-password", gate_device_reveal_password),
    path("gate-devices/<int:pk>/sign-out", gate_device_sign_out),

    # ── Gate Monitor (slice A: gate_monitor_views.py). The shared /gatemonitor sign-in and console: public login,
    #    the rest gate-device-authenticated (require_gate_device), never an HR token, so not in the permission tree ──
    path("gate-monitor/login", gate_monitor_login),
    path("gate-monitor/me", gate_monitor_me),
    path("gate-monitor/logout", gate_monitor_logout),
    path("gate-monitor/scan", gate_monitor_scan),
    path("gate-monitor/summary", gate_monitor_summary),
    path("gate-monitor/records", gate_monitor_records),
    path("gate-monitor/records/export", gate_monitor_records_export),

    # ── Tea Break -permanent per-employee QR, no approval, same gate logins
    #    as above (see tea_break_views.py). qr-token/my-status are employee-
    #    token-authenticated; rule/summary/records are HR-only ─────────────
    path("tea-break/qr-token", tea_break_qr_token),
    path("tea-break/my-status", tea_break_my_status),
    path("tea-break/rule", tea_break_rule),
    path("tea-break/summary", tea_break_summary),
    path("tea-break/records", tea_break_records),
    # Tea Break page (slice D: tea_break_admin_views.py; key outpass_visitors.tea_break.records). Literal paths before
    # <int:pk>
    path("tea-break/records/summary", tea_break_records_summary),
    path("tea-break/records/employees", tea_break_records_employees),
    path("tea-break/records/export", tea_break_records_export),
    path("tea-break/records/options", tea_break_records_options),
    path("tea-break/records/<int:pk>", tea_break_record_detail),

    # ── Audit Logs ───────────────────────────────────────────────────────────
    path("audit-logs", audit_logs),
    path("audit-logs/stats", audit_logs_stats),
    path("login-sessions", login_sessions),
    path("login-sessions/<int:session_id>/revoke", revoke_login_session),
    path("mobile-app-logins", mobile_app_logins),
    path("mobile-app-logins/export", mobile_app_logins_export),
    path("mobile-app-logins/<int:employee_id>/reset-password", mobile_app_reset_password),
    # New Version tab: HR publishes builds; the employee app reads latest-version (public).
    # Mobile App Login -> Mobile Messages: the control panel for what is pushed to employees' phones
    path("mobile-app/messages/overview", mobile_messages_overview),
    path("mobile-app/messages/controls", mobile_messages_controls),
    path("mobile-app/messages/log", mobile_messages_log),
    path("mobile-app/messages/devices", mobile_messages_devices),
    path("mobile-app/messages/send", mobile_messages_send),
    # Phone Notify Control (2026-11-17): the page that now holds these, with what it added
    path("mobile-app/messages/log/<int:pk>/push-again", mobile_messages_push_again),
    path("mobile-app/messages/devices/<int:employee_id>/mute", mobile_messages_mute),
    path("mobile-app/messages/devices/phones/<int:token_id>", mobile_messages_remove_phone),
    path("mobile-app/messages/config", mobile_messages_config),
    # Phone Notify Control -> Settings: who receives phone notifications (push_recipients_views.py)
    path("mobile-app/messages/recipients", push_recipients_settings),
    path("mobile-app/messages/recipients/employees", push_recipients_employees),
    path("mobile-app/messages/alert-settings", phone_alert_settings),
    # Phone Notify Control -> Message Text: HR's wording of each kind (push_templates_views.py)
    path("mobile-app/messages/templates", push_templates_list),
    path("mobile-app/messages/templates/<str:key>", push_template_update),
    path("mobile-app/messages/templates/<str:key>/preview", push_template_preview),
    path("mobile-app/versions", mobile_app_versions),
    path("mobile-app/versions/<int:pk>", mobile_app_version_detail),
    path("mobile-app/latest-version", mobile_app_latest_version),
    path("theme-settings", theme_settings),
    path("theme-settings/update", update_theme_settings),

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

    # ── Report Center (registry-driven; see api/reporting/) ─────────────────
    path("reports/catalog",                     reports_catalog),
    path("reports/options/<str:source>",        reports_options),
    path("reports/run/<str:report_id>",         reports_run),
    path("reports/export/<str:report_id>",      reports_export),
    # Report Center -> Customise, the report builder (api/reporting/custom/; permission reports.customise). A saved
    # report runs / exports through reports/run|export/custom-<id> above.
    path("reports/custom/datasets",                     custom_datasets),
    path("reports/custom/preview",                      custom_preview),
    path("reports/custom/saved",                        custom_saved),
    path("reports/custom/saved/<int:pk>",               custom_saved_detail),
    path("reports/custom/saved/<int:pk>/duplicate",     custom_saved_duplicate),

    # ── Managing Director portal (every view behind @require_md; see api/md_portal/) ──
    path("md/", include("api.md_portal.urls")),

    # ── Mobile pages round 2026-10-31: one routes file per area so the areas never edit the same lines ──
    path("", include("api.urls_mobile_leave")),
    path("", include("api.urls_mobile_requests")),
    path("", include("api.urls_mobile_pay")),
    path("", include("api.urls_mobile_settlement")),
    path("", include("api.urls_mobile_reminders")),
    path("", include("api.urls_mobile_approvals")),
    # ── HR Requests page: HoD's (pending with each Department Head) and Notify (reminders) ──
    path("", include("api.urls_hod_reminders")),
    path("", include("api.urls_attendance_notify")),
    # ── HR -> Payroll -> Salary Slip: standalone slips, statement and bank file (no payroll; api/salary_slip_center/) ──
    path("salary-slip-center/", include("api.salary_slip_center.urls")),
    # ── Staff Payroll: Excess tab, Not included view, Payslip tab (payroll_excess_views.py; 2026-11-20) ──
    path("", include("api.urls_payroll_excess")),
    # ── Employees -> Factory Employees (factory_employee_views.py; 2026-11-20) ──
    path("", include("api.urls_factory_employees")),
    path("", include("api.urls_hr_analytics")),
]
