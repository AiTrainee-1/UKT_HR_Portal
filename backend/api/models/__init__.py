"""
All ORM models, split by domain. Import from here (`from .models import Employee`)
exactly as before -the split is purely organisational.

Modules (each only imports from ones listed before it):
  core         Organisation: branches, departments, designations, employees, HOD (department manager) assignments.
  leave        Shifts, leave, holidays and employee requests.
  attendance   Punches, daily attendance verdicts, on-duty / geo attendance, biometric devices.
  payroll      Payroll runs, salary slips, advances, settings, increments/bonuses, overtime and compensation.
  accounts     HR-portal logins, roles/permissions, sessions, audit log, notifications and push tokens.
  recruitment  Jobs, applicants, resignations, headcount, resume screening and employee documents.
  system       Document/ID-card settings, stored files and backups.
  chat         Chat channels, messages and reactions.
  whatsapp     WhatsApp (WAClient) send log, message wording and media assets.
  gate         Outpass, gate scanners, visitors, reception and tea break.
"""

from .core import (
    Branch,
    Department,
    Designation,
    Employee,
    FamilyDependent,
    DepartmentManager,
    ManagerDepartmentAssignment,
    ManagerEmployeeAssignment,
)
from .leave import (
    ShiftTemplate,
    EmployeeShiftAssignment,
    LeaveType,
    LeaveBalance,
    Holiday,
    LeaveRequest,
    EmployeeRequest,
    CasualLeaveRequest,
    EmployeePermission,
)
from .attendance import (
    Attendance,
    AttendanceLog,
    DailyShiftLog,
    MonthlyShiftSummary,
    AttendanceDayRecord,
    AttendanceOverrideRequest,
    OnDutySession,
    OnDutyPunchVerification,
    MissingPunchRequest,
    LiveLocationPing,
    BiometricDevice,
    UnmatchedPunch,
    AutoSyncRule,
)
from .payroll import (
    PayrollRun,
    EarningItem,
    DeductionItem,
    Advance,
    AdvanceRepayment,
    SalarySlip,
    SessionConfig,
    WorkSession,
    Payroll,
    _default_late_deduction_slabs,
    PayrollSettings,
    BranchSettingsOverride,
    SalaryRecord,
    Promotion,
    SalaryIncrement,
    Bonus,
    OvertimeRecord,
    CompensationLeaveCredit,
    CompensationDayAnnouncement,
    ProductionShiftConfig,
    ProductionShiftSegment,
)
from .accounts import (
    Role,
    HRUser,
    LoginSession,
    AuditLog,
    HrLoginAttempt,
    Notification,
    PushToken,
)
from .recruitment import (
    Job,
    Applicant,
    ResignationRequest,
    DepartmentHeadcount,
    HiringRuleSet,
    ScreeningCandidate,
    EmployeeDocument,
)
from .system import (
    FileBlob,
    IdCardSettings,
    CompanyDocumentSettings,
    BackupSchedule,
    BackupDriveConfig,
)
from .chat import (
    ChatChannel,
    ChatMessage,
    ChatReaction,
)
from .whatsapp import (
    EmployeeOtp,
    WhatsAppMediaAsset,
    WhatsAppMessageLog,
    WhatsAppMessageTemplate,
    WhatsAppSettings,
)
from .gate import (
    GateQRCode,
    OutpassRecord,
    OutpassRequest,
    GateDevice,
    TeaBreakLog,
    TeaBreakRule,
    OutpassGateScan,
    Visitor,
    VisitorVisit,
    ReceptionDevice,
)
