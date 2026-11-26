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
  whatsapp     WhatsApp (Meta Cloud API) send log, settings, Meta templates and media assets.
  mail         Email (Gmail / SMTP) send log, feature switches and wording.
  gate         Outpass, gate scanners, visitors, reception and tea break.
  md_assistant The MD portal's AI assistant: settings, conversations, daily usage.
  shared_endpoints Endpoint Sharing: the API endpoints, origins, keys and access log of data shared with other applications.
  sms          SMS one-time codes through 2Factor: the settings row and the send log.
  geo_tracking On-Duty Geo-Tracking: settings, tracks, points, events, derived segments, devices and consents.
  hod_reminders Reminders to Department Heads about pending approvals: the schedule, the rounds and each delivery.
  report_center Report Center -> Customise: the reports HR builds and saves (data source, fields, filters, sort).
  factory      Employees -> Factory Employees: the page's labels (Driver, Housekeeping, Chef ...).
  payroll_excess Staff Payroll -> Excess tab: amounts HR adds to (Excess) or takes off (Detection) a month's salary.
  salary_slip_center HR -> Payroll -> Salary Slip: standalone salary slips (no payroll) and the page's own Hold switch.
  missed_payroll HR -> Payroll -> Missed Payroll: payroll for employees the regular payroll missed (Done writes Payroll).
  investigation Employees -> Investigation: continuous absence lists, Keep active / inactive decisions, Auto Trigger.
  birthday_compensation Birthday Compensation: the dates a worked birthday's 1.00 day is placed on (HOD then HR).
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
    ManagerEmployeeExclusion,
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
    CasualLeaveAdjustment,
    CasualLeavePolicy,
    EmployeePermission,
)
from .attendance import (
    Attendance,
    AttendanceLog,
    DailyShiftLog,
    MonthlyShiftSummary,
    AttendanceDayRecord,
    AttendanceOverrideRequest,
    PunchViewHistory,
    OnDutySession,
    OnDutyPunchVerification,
    OnDutyOvertimePunch,
    MissingPunchRequest,
    LiveLocationPing,
    BiometricConnectorJob,
    BiometricConnectorPunch,
    BiometricDevice,
    BiometricDeviceOperation,
    BiometricDeviceUser,
    BiometricFetchRun,
    BiometricUserChange,
    EmployeeDeviceLinkChange,
    BiometricProbe,
    BiometricSiteConnector,
    BiometricUnknownPusher,
    UnmatchedPunch,
    AutoSyncRule,
)
from .payroll import (
    PayrollRun,
    EarningItem,
    DeductionItem,
    Advance,
    AdvanceRepayment,
    AdvanceDecision,
    SalarySlip,
    SessionConfig,
    WorkSession,
    Payroll,
    PayrollMonthClose,
    ProductionPeriodClose,
    ProductionCycleTransfer,
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
    CompensationConfig,
    CompensationRule,
    HolidayWorkClaim,
    CompensationLedger,
    ProductionShiftConfig,
    ProductionShiftSegment,
    ProductionShiftGroup,
    ProductionSpecialShiftAssignment,
    ProductionShiftRule,
    ProductionBreak,
)
from .accounts import (
    Role,
    HRUser,
    LoginSession,
    EmployeeLoginSession,
    IdempotentRequest,
    AuditLog,
    HrLoginAttempt,
    MobileMessageSettings,
    ApprovalReminder,
    Notification,
    PushOptOut,
    PushRecipient,
    PushTemplate,
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
    ApprovalWorkflowConfig,
    FileBlob,
    IdCardSettings,
    CompanyDocumentSettings,
    BackupSchedule,
    BackupDriveConfig,
    MobileAppVersion,
)
from .chat import (
    ChatChannel,
    ChatMessage,
    ChatReaction,
    ChatSettings,
)
from .whatsapp import (
    EmployeeOtp,
    WhatsAppMediaAsset,
    WhatsAppMessageLog,
    WhatsAppMessageTemplate,
    WhatsAppOptOut,
    WhatsAppSettings,
    WhatsAppTemplate,
)
from .mail import (
    EmailMessageLog,
    EmailMessageTemplate,
    EmailSettings,
)
from .gate import (
    GateQRCode,
    OutpassRecord,
    OutpassRequest,
    GateDevice,
    GateLoginAttempt,
    GateSession,
    TeaBreakLog,
    TeaBreakRule,
    OutpassGateScan,
    Visitor,
    VisitorVisit,
    ReceptionDevice,
    ReceptionLoginAttempt,
    ReceptionSession,
)
from .md_assistant import (
    MdAssistantSettings,
    MdAssistantUsage,
    MdConversation,
    MdMessage,
)
from .shared_endpoints import (
    SharedEndpoint,
    SharedEndpointAccessLog,
    SharedEndpointKey,
    SharedEndpointOrigin,
)
from .sms import (
    SmsMessageLog,
    SmsSettings,
)
from .geo_tracking import (
    DutyTrack,
    DutyTrackEvent,
    DutyTrackPoint,
    DutyTrackSegment,
    GeoTrackingAlert,
    GeoTrackingSettings,
    TrackingConsent,
    TrackingDevice,
)
from .hod_reminders import (
    HodReminderDelivery,
    HodReminderRun,
    HodReminderSettings,
)
from .attendance_notify import (
    AttendanceNotifyAutomation,
    AttendanceNotifyDelivery,
    AttendanceNotifyRecipientList,
    AttendanceNotifyRun,
    AttendanceNotifySettings,
)
from .report_center import SavedCustomReport
from .salary_slip_center import StandaloneSalaryHold, StandaloneSalarySlip
from .missed_payroll import MissedPayroll
from .investigation import EmployeeInvestigation, InvestigationSettings
from .request_auto_reject import AutoRejectedRequest, RequestAutoRejectSettings
from .payroll_excess import PayrollExcessEntry, PayrollExcessHistory
from .factory import FactoryLabel
from .enquiries import Enquiry
from .birthday_compensation import BirthdayCompensationUse
