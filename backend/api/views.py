"""
URL entry point kept for compatibility: urls.py (`views.X`) and a few callers
import from here. The actual view code now lives in the domain modules below.
"""

from .view_common import (
    _error,
    _employee_name,
)
from .auth_views import (
    healthz,
    HR_LOCKOUT_THRESHOLD,
    HR_LOCKOUT_WINDOW_MINUTES,
    HR_LOCKOUT_DURATION_MINUTES,
    _hr_username_locked_out,
    hr_login,
    employee_login,
    logout,
    set_password,
    auth_me,
)
from .department_views import (
    departments,
    _departments_create,
    delete_department,
)
from .employee_views import (
    _employee_queryset,
    _serialize_employee,
    _serialize_employee_for_list,
    employee_photo,
    employees,
    _employees_list,
    _assign_unit_code,
    _resolve_employee_relations,
    _create_employee_from_data,
    _employees_create,
    employee_detail,
    _employee_get,
    _employee_update,
    _employee_delete,
    employee_status,
    bulk_location_tracking,
)
from .employee_bulk_views import (
    EMPLOYEE_UPLOAD_HEADERS,
    _VALID_EMPLOYMENT_TYPES,
    _VALID_SALARY_TYPES,
    _VALID_GENDERS,
    _parse_date_cell,
    _employee_row_to_data,
    bulk_upload_employees,
    _UPDATE_TEXT_FIELDS,
    _apply_row_updates,
    bulk_update_employees,
)
from .salary_record_views import (
    _salary_with_name,
    _salary_from_payroll,
    salary_records,
    _salary_records_list,
    _salary_records_create,
    update_salary_record,
    _month_attendance_counts,
    calculate_salary_records,
)
from .leave_request_views import (
    _leave_with_name,
    leave_requests,
    _resolve_employee_filter,
    _leave_requests_list,
    _count_leave_days,
    _leave_requests_create,
    update_leave_status,
    delete_leave_request,
)
from .notification_views import (
    _notif_with_name,
    notifications,
    _notifications_create,
    mark_notification_read,
    mark_all_notifications_read,
    register_push_token,
)
from .job_board_views import (
    _job_with_meta,
    jobs,
    _jobs_create,
    job_detail,
    _jobs_update,
    _jobs_delete,
    _applicant_with_title,
    applicants,
    _applicants_list,
    _applicants_submit,
    update_applicant_status,
)
from .attendance_records_views import (
    attendance,
    _attendance_list,
    _attendance_create,
)
from .dashboard_views import (
    MONTH_NAMES,
    hr_dashboard_summary,
    employee_dashboard_summary,
    interview_summary,
    salary_trends,
)
from .payroll_views import (
    session_configs,
    session_config_detail,
    attendance_logs,
    process_punch_sessions,
    work_sessions,
    work_session_detail,
    payroll_list,
    generate_payroll,
    payroll_detail,
)
