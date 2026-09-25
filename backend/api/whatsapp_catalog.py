"""
The catalog of every WhatsApp message the HRMS can send.

    HRMS module -> notification service -> TEMPLATE (this file) -> provider -> employee

One entry per message type says what it is called, which HRMS module it belongs
to, which switch on the WhatsApp Control page turns it off, its default wording
and which {{variables}} that wording may use. Everything else -the control page,
the template editor, the message log, the on/off checks- reads this catalog, so
adding a new notification is one entry here plus one call to
`whatsapp_service.send_notification` from the module that raises it.

Wording uses {{name}} placeholders. Older types also accept the numbered form
({{1}}, {{2}} ...) that HR's already-saved wording was written with: the number is
the variable's position in `variables`, so the ORDER of a legacy type's
variables must never change (append new ones at the end).

A line whose placeholders are all empty is dropped when a message is rendered,
so optional details ("Note: {{comment}}") simply vanish when there is nothing to
say instead of leaving an empty label behind.

This module deliberately imports nothing from the rest of the app (models import it).
"""

from dataclasses import dataclass

# ── modules (what the "Related HRMS module" column and the filters show) ────────

MODULES = {
    "documents": "Documents",
    "otp": "OTP & Login",
    "attendance": "Attendance",
    "approvals": "Approvals",
    "geo": "Geo Attendance",
    "visitors": "Visitors",
    "outpass": "Outpass & Gate",
    "other": "Other",
}

# The switch (a WhatsAppSettings column) that turns a whole module off. A module
# with no entry is controlled only by its per-message switches.
MODULE_SWITCHES = {
    "documents": "document_notifications_enabled",
    "attendance": "attendance_alerts_enabled",
    "approvals": "approval_notifications_enabled",
    "visitors": "visitor_notification_enabled",
    "outpass": "outpass_notifications_enabled",
}

# The individual approval workflows that share the two Approved / Rejected
# templates. HR can switch each one off; the keys are stored in
# WhatsAppSettings.disabled_approval_modules. (Geo Attendance and Punch Approval
# have their own wording under the "geo" module.)
APPROVAL_MODULES = {
    "leave": "Leave",
    "permission": "Permission",
    "casual_leave": "Casual Leave",
    "missing_punch": "Missing Punch",
    "outpass": "Gate Outpass",
    "attendance_correction": "Attendance Correction",
    "resignation": "Resignation",
    "advance": "Advance",
    "request": "Other Requests",
}


@dataclass(frozen=True)
class Variable:
    name: str
    help: str
    sample: str


@dataclass(frozen=True)
class MessageType:
    key: str
    label: str
    module: str
    body: str
    variables: tuple = ()
    # WhatsAppSettings column that switches just this message on/off, if any.
    switch: str | None = None
    # A one-time code that is missing from the wording would be a message nobody can log in with.
    must_contain_code: bool = False
    # Messages with no editable wording (a contact card carries no text).
    has_wording: bool = True
    description: str = ""

    @property
    def variable_names(self) -> list[str]:
        return [v.name for v in self.variables]


def V(name: str, help: str, sample: str) -> Variable:
    return Variable(name, help, sample)


_TYPES: list[MessageType] = []


def _add(**kwargs) -> None:
    _TYPES.append(MessageType(**kwargs))


SIGN = "UK Textiles HRMS"

# ── Documents (the wording is a caption; the file itself is attached) ─────────

_add(
    key="salary_slip",
    label="Salary Slip",
    module="documents",
    description="The salary slip PDF, sent with a short caption.",
    body=f"💰 *Salary Slip*\n\nHello {{{{employee_name}}}},\n\nYour salary slip for *{{{{month_year}}}}* is attached.\n\nRegards,\n{SIGN}",
    variables=(V("employee_name", "Employee name", "Asha Kumar"), V("month_year", "Month and year", "August 2026")),
)
_add(
    key="id_card",
    label="ID Card",
    module="documents",
    description="The employee ID card image, sent with a short caption.",
    body=f"🪪 *Employee ID Card*\n\nHello {{{{employee_name}}}},\n\nYour employee ID card is attached.\n\nRegards,\n{SIGN}",
    variables=(V("employee_name", "Employee name", "Asha Kumar"),),
)
_add(
    key="offer_letter",
    label="Offer Letter",
    module="documents",
    description="The offer letter PDF, sent with a short caption.",
    body=f"📄 *Offer Letter*\n\nHello {{{{employee_name}}}},\n\nPlease find your offer letter for the position of *{{{{designation}}}}* attached.\n\nRegards,\n{SIGN}",
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("designation", "Designation offered", "Line Supervisor"),
    ),
)
_add(
    key="experience_letter",
    label="Experience Letter",
    module="documents",
    description="The experience letter PDF, sent with a short caption.",
    body=f"📄 *Experience Letter*\n\nHello {{{{employee_name}}}},\n\nYour experience letter is attached.\n\nRegards,\n{SIGN}",
    variables=(V("employee_name", "Employee name", "Asha Kumar"),),
)
_add(
    key="resignation_letter",
    label="Resignation Letter",
    module="documents",
    description="The resignation letter PDF, sent with a short caption.",
    body=f"📄 *Resignation Letter*\n\nHello {{{{employee_name}}}},\n\nYour resignation letter (last working day: *{{{{last_working_day}}}}*) is attached.\n\nRegards,\n{SIGN}",
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("last_working_day", "Last working day", "30 Sep 2026"),
    ),
)
_add(
    key="other",
    label="Other Document",
    module="documents",
    description="Any other employee document HR sends from the Documents page.",
    body=f"📎 *Document*\n\nHello {{{{employee_name}}}},\n\nPlease find your *{{{{document_category}}}}* document attached.\n\nRegards,\n{SIGN}",
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("document_category", "Document category", "Appointment Letter"),
    ),
)

# ── OTP & login (unchanged wording; the code is never stored in the history) ───

_CODE_VARS = (
    V("code", "The 6-digit code (keep it in the text)", "123456"),
    V("minutes", "Minutes until the code expires", "5"),
)
_add(
    key="otp_login",
    label="Login OTP",
    module="otp",
    description="The code an employee enters to sign in to the apps.",
    switch="otp_login_enabled",
    must_contain_code=True,
    body="{{1}} is your UK Textiles HRMS login code. It expires in {{2}} minutes.\n\nNever share this code with anyone.",
    variables=_CODE_VARS,
)
_add(
    key="otp_reset",
    label="Password Reset OTP",
    module="otp",
    description="The code that confirms a forgotten-password reset.",
    switch="otp_reset_enabled",
    must_contain_code=True,
    body=(
        "{{1}} is your UK Textiles HRMS password reset code. It expires in {{2}} minutes.\n\n"
        "If you didn't ask to reset your password, ignore this message and tell HR."
    ),
    variables=_CODE_VARS,
)
_add(
    key="otp_activate",
    label="Account Activation OTP",
    module="otp",
    description="The code that confirms a new employee before they choose a first password.",
    switch="otp_activate_enabled",
    must_contain_code=True,
    body=(
        "{{1}} is your UK Textiles HRMS account activation code. It expires in {{2}} minutes.\n\n"
        "Enter it in the app to set your password. Never share this code with anyone."
    ),
    variables=_CODE_VARS,
)

# ── Attendance alerts and punch reminders (automatic, checked every 5 minutes) ─

_add(
    key="absent_alert",
    label="Absent Alert",
    module="attendance",
    description="Sent when no punch has been recorded within the permitted time after the shift starts.",
    switch="absent_alert_enabled",
    body=(
        "🚫 *Marked Absent*\n\n"
        "Hello {{employee_name}},\n\n"
        "Your attendance has not been recorded within the permitted time. You have been marked as *Absent* for today.\n\n"
        "📅 Date: {{date}}\n"
        "🕐 Shift start: {{shift_start}}\n"
        "⏳ Punch allowed until: {{cutoff_time}}\n"
        "📋 Status: {{status}}\n\n"
        "If you are at work, please punch now and inform HR. If you are on leave or something is wrong, please contact HR.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("shift_start", "Shift start time", "8:30 AM"),
        V("cutoff_time", "Last time a punch was still accepted", "9:30 AM"),
        V("status", "Attendance status", "Absent"),
        V("shift_end", "Shift end time", "5:30 PM"),
        V("wait_minutes", "Minutes allowed after the shift starts", "60"),
    ),
)
_add(
    key="late_alert",
    label="Late Attendance Alert",
    module="attendance",
    description="Sent when the first punch of the day came after the shift's grace period.",
    switch="late_alert_enabled",
    body=(
        "⏰ *Late Attendance*\n\n"
        "Hello {{employee_name}},\n\n"
        "You were marked *late* today.\n\n"
        "📅 Date: {{date}}\n"
        "🕐 Shift start: {{shift_start}}\n"
        "✅ Your punch: {{first_punch}}\n"
        "⏱ Late by: {{late_by}}\n"
        "📋 Status: {{status}}\n\n"
        "Please reach on time. If you had a valid reason, please tell HR.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("shift_start", "Shift start time", "8:30 AM"),
        V("first_punch", "Time of the first punch", "9:05 AM"),
        V("late_by", "How late, from the shift start", "35 minutes"),
        V("status", "Attendance status", "Late"),
        V("grace_minutes", "The shift's grace period in minutes", "10"),
    ),
)
_add(
    key="four_punch_alert",
    label="Punch Reminder",
    module="attendance",
    description="A friendly reminder for each of the four daily punches (check-in, lunch-out, lunch-in, check-out) that is still missing.",
    switch="four_punch_alert_enabled",
    body=(
        "⏰ *Punch Reminder*\n\n"
        "Hello {{employee_name}},\n\n"
        "Friendly reminder: please don't forget to complete your attendance punch.\n\n"
        "🔔 Punch due: *{{punch_name}}* ({{punch_number}})\n"
        "📅 Date: {{date}}\n"
        "🕐 {{hint}}\n\n"
        "Please punch now, or raise a Missing Punch request in the app if you already did.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("punch_name", "Which punch is due", "Lunch-out"),
        V("hint", "When it was due", "It was due around 12:30 PM."),
        V("punch_number", "Which of the day's punches", "2 of 4"),
    ),
)
_add(
    key="on_duty_punch_reminder",
    label="On-Duty Punch Reminder",
    module="attendance",
    description="The same reminder for employees working On-Duty, asking them to complete their Geo Punch.",
    switch="four_punch_alert_enabled",
    body=(
        "📍 *On-Duty Punch Reminder*\n\n"
        "Hello {{employee_name}},\n\n"
        "Friendly reminder: you are on duty today, so please don't forget to complete your Geo Punch in the app.\n\n"
        "🔔 Punch due: *{{punch_name}}* ({{punch_number}})\n"
        "📍 On-Duty at: {{destination}}\n"
        "📅 Date: {{date}}\n"
        "🕐 {{hint}}\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("punch_name", "Which punch is due", "Lunch-in"),
        V("hint", "When it was due", "It was due around 1:45 PM."),
        V("punch_number", "Which of the day's punches", "3 of 4"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
    ),
)
_add(
    key="missing_punch_alert",
    label="Missing Punch Alert",
    module="attendance",
    description="Sent after the shift ends when the day is still missing punches.",
    switch="missing_punch_alert_enabled",
    body=(
        "📝 *Missing Punch*\n\n"
        "Hello {{employee_name}},\n\n"
        "Your attendance for *{{date}}* is incomplete.\n\n"
        "✅ Recorded: {{recorded}}\n"
        "❗ Missing: {{missing}}\n\n"
        "Please raise a Missing Punch request in the app so your day is counted correctly.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Date", "25 Sep 2026"),
        V("recorded", "Punches recorded", "2 of 4"),
        V("missing", "Which punches are missing", "Lunch-in, Evening check-out"),
    ),
)

# ── Approvals: one Approved and one Rejected wording for every workflow ────────

_APPROVAL_VARS = (
    V("employee_name", "Employee name", "Asha Kumar"),
    V("request_type", "Which kind of request (Leave, Permission, ...)", "Leave"),
    V("date", "The date(s) the request is for", "26 Sep 2026 to 27 Sep 2026"),
    V("time", "The time, when the request has one", "10:30 AM"),
    V("details", "What was requested", "Sick Leave - 2 days"),
    V("approver", "Who approved or rejected it", "Meena (HR)"),
    V("comment", "The approver's note or rejection reason, if given", "Get well soon"),
    V("requested_on", "When it was submitted", "24 Sep 2026"),
    V(
        "link",
        "A link to the request in the employee portal, when one is set up",
        "https://portal.example/employee/leave",
    ),
    V("reason", "The employee's own reason for the request", "Fever"),
)
_add(
    key="approval_approved",
    label="Approval - Approved",
    module="approvals",
    description="Sent to the employee when a Leave, Permission, Casual Leave, Missing Punch, Outpass, Resignation, Advance or other request is approved.",
    body=(
        "✅ *Request Approved*\n\n"
        "Hello {{employee_name}},\n\n"
        "Your *{{request_type}}* request has been approved successfully.\n\n"
        "📅 Date: {{date}}\n"
        "🕐 Time: {{time}}\n"
        "📋 Request: {{details}}\n"
        "👤 Approved by: {{approver}}\n"
        "💬 Note: {{comment}}\n"
        "🔗 View request: {{link}}\n\n"
        f"Thank you,\n{SIGN}"
    ),
    variables=_APPROVAL_VARS,
)
_add(
    key="approval_rejected",
    label="Approval - Rejected",
    module="approvals",
    description="Sent to the employee when one of those requests is rejected, with the reason if one was given.",
    body=(
        "❌ *Request Rejected*\n\n"
        "Hello {{employee_name}},\n\n"
        "Your *{{request_type}}* request has been rejected.\n\n"
        "📅 Date: {{date}}\n"
        "🕐 Time: {{time}}\n"
        "📋 Request: {{details}}\n"
        "👤 Rejected by: {{approver}}\n"
        "📝 Reason: {{comment}}\n"
        "🔗 View request: {{link}}\n\n"
        f"Please contact HR if you need further clarification.\n{SIGN}"
    ),
    variables=_APPROVAL_VARS,
)

# ── Geo Attendance (On-Duty) and its punches ───────────────────────────────────

_add(
    key="geo_approval",
    label="Geo Attendance Approved",
    module="geo",
    description="Sent when HR gives the final approval of a Geo Attendance (On-Duty) request.",
    switch="geo_approval_enabled",
    body=(
        "✅ *Geo Attendance Request Approved*\n\n"
        "Hello {{employee_name}},\n\n"
        "Your Geo Attendance (On-Duty) request has been approved.\n\n"
        "📍 Destination: {{destination}}\n"
        "📅 Requested on: {{requested_on}}\n"
        "👤 Approved by: {{approved_by}}\n"
        "💬 Note: {{comment}}\n\n"
        "You can now do your on-duty work and punch from the app.\n\n"
        f"Thank you,\n{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("destination", "The destination they requested", "Tirupur Dyeing Unit"),
        V("requested_on", "When they requested it", "25 Sep 2026, 9:10 AM"),
        V("approved_by", "Who approved it", "Meena"),
        V("note", "The approver's note, already worded as a line (older wording)", "\nNote: Take the van"),
        V("comment", "The approver's note", "Take the van"),
    ),
)
_add(
    key="geo_rejection",
    label="Geo Attendance Rejected",
    module="geo",
    description="Sent when a Geo Attendance (On-Duty) request is rejected, by the Department Head or by HR.",
    switch="geo_approval_enabled",
    body=(
        "❌ *Geo Attendance Request Rejected*\n\n"
        "Hello {{employee_name}},\n\n"
        "Your Geo Attendance (On-Duty) request has been rejected.\n\n"
        "📍 Destination: {{destination}}\n"
        "📅 Requested on: {{requested_on}}\n"
        "👤 Rejected by: {{rejected_by}}\n"
        "📝 Reason: {{comment}}\n"
        "⚠️ {{punches_note}}\n\n"
        f"Please contact HR if you need further clarification.\n{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("destination", "The destination they requested", "Tirupur Dyeing Unit"),
        V("requested_on", "When they requested it", "25 Sep 2026, 9:10 AM"),
        V("rejected_by", "Who rejected it", "Meena (HR)"),
        V("comment", "The rejection reason, if given", "Not required today"),
        V(
            "punches_note",
            "A line about punches recorded under it, if any",
            "The 2 punch(es) you recorded under it were not counted.",
        ),
    ),
)
_add(
    key="geo_punch_approval",
    label="Geo Punch Approved",
    module="geo",
    description="Sent when HR approves one captured Geo Attendance punch.",
    switch="geo_approval_enabled",
    body=(
        "✅ *Geo Punch Approved*\n\n"
        "Hello {{employee_name}},\n\n"
        "Your Geo Attendance *{{punch_name}}* has been approved.\n\n"
        "📅 Date: {{date}}\n"
        "🕐 Time: {{time}}\n"
        "📍 Location: {{location}}\n"
        "👤 Approved by: {{approved_by}}\n"
        "💬 Note: {{comment}}\n\n"
        f"Thank you,\n{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("punch_name", "Check-In or Check-Out", "Check-In"),
        V("date", "Punch date", "25 Sep 2026"),
        V("time", "Punch time", "9:12 AM"),
        V("location", "A map link to where it was captured", "https://maps.google.com/?q=11.1,77.3"),
        V("approved_by", "Who approved it", "Meena"),
        V("comment", "The approver's note", ""),
    ),
)
_add(
    key="geo_punch_rejection",
    label="Geo Punch Rejected",
    module="geo",
    description="Sent when HR rejects one captured Geo Attendance punch.",
    switch="geo_approval_enabled",
    body=(
        "❌ *Geo Punch Rejected*\n\n"
        "Hello {{employee_name}},\n\n"
        "Your Geo Attendance *{{punch_name}}* has been rejected and does not count as attendance.\n\n"
        "📅 Date: {{date}}\n"
        "🕐 Time: {{time}}\n"
        "📍 Location: {{location}}\n"
        "👤 Rejected by: {{rejected_by}}\n"
        "📝 Reason: {{comment}}\n\n"
        f"You can punch again from the app. Please contact HR if you need help.\n{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("punch_name", "Check-In or Check-Out", "Check-Out"),
        V("date", "Punch date", "25 Sep 2026"),
        V("time", "Punch time", "5:35 PM"),
        V("location", "A map link to where it was captured", "https://maps.google.com/?q=11.1,77.3"),
        V("rejected_by", "Who rejected it", "Meena"),
        V("comment", "The rejection reason, if given", "Photo was unclear"),
    ),
)

# ── Visitors ───────────────────────────────────────────────────────────────────

_add(
    key="visitor_notification",
    label="Visitor Notification",
    module="visitors",
    description="Tells an employee who has arrived at reception to meet them, and why.",
    body=(
        "🚪 *Visitor at Reception*\n\n"
        "Hello {{employee_name}},\n\n"
        "You have a visitor.\n\n"
        "👤 Visitor: *{{visitor_name}}*\n"
        "📞 Contact: {{visitor_phone}}\n"
        "🏢 Company: {{company}}\n"
        "🎯 Purpose: {{purpose}}\n"
        "🙋 Here to meet: {{host_name}}\n"
        "🏬 Department: {{department}}\n"
        "📅 Date: {{visit_date}}\n"
        "🕐 Time: {{visit_time}}\n"
        "📍 Branch: {{branch}}\n\n"
        "Tap the visitor's contact card below to call them and guide them to you.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "The employee being visited", "Asha Kumar"),
        V("visitor_name", "Visitor's name", "Ravi Nair"),
        V("visitor_phone", "Visitor's phone number", "+91 98765 43210"),
        V("purpose", "Purpose of the visit", "Machine service"),
        V("company", "Visitor's company, when given", "Textile Machinery Co."),
        V("host_name", "Whom they came to meet", "Asha Kumar"),
        V("department", "That person's department", "Weaving"),
        V("visit_date", "Date of the visit", "25 Sep 2026"),
        V("visit_time", "Time of arrival", "11:20 AM"),
        V("branch", "The branch they arrived at", "Tirupur"),
        V("why_came", "Why they came, as written on the form", "Vendor"),
    ),
)
_add(
    key="visitor_contact",
    label="Visitor Contact Card",
    module="visitors",
    description="The visitor's contact card, sent right after the visitor message so the employee can tap to call.",
    has_wording=False,
    body="",
)

# ── Outpass & gate movement ────────────────────────────────────────────────────

_GATE_VARS = (
    V("employee_name", "Employee name", "Asha Kumar"),
    V("pass_type", "Outpass type", "Official / Mill Duty"),
    V("destination", "Where they are going", "Bank"),
    V("reason", "Reason for the outpass", "Deposit cheque"),
    V("date", "Date", "25 Sep 2026"),
    V("gate_out_time", "Time recorded going OUT", "2:05 PM"),
    V("gate_in_time", "Time recorded coming back IN", "3:20 PM"),
    V("duration", "How long they were out", "1 hr 15 min"),
    V("gate_name", "The gate that recorded it", "Gate 1"),
    V("status", "Verification status", "Verified"),
    V("approved_by", "Who approved the outpass", "Meena (HR)"),
    V("next_step", "What to do next", "Please scan your Return QR at the gate when you come back."),
)
_add(
    key="outpass_gate_out",
    label="Outpass - Gate OUT",
    module="outpass",
    description="Sent when the gate records an employee going out (a verified outpass scan, or a gate QR form entry).",
    body=(
        "🚪 *Gate OUT Recorded*\n\n"
        "Hello {{employee_name}},\n\n"
        "Your gate movement has been recorded.\n\n"
        "🏷 Outpass type: {{pass_type}}\n"
        "📅 Date: {{date}}\n"
        "🕐 Gate OUT: {{gate_out_time}}\n"
        "📍 Destination: {{destination}}\n"
        "📋 Reason: {{reason}}\n"
        "🚧 Gate: {{gate_name}}\n"
        "✅ Status: {{status}}\n\n"
        "{{next_step}}\n\n"
        f"{SIGN}"
    ),
    variables=_GATE_VARS,
)
_add(
    key="outpass_gate_in",
    label="Outpass - Gate IN",
    module="outpass",
    description="Sent when the gate records an employee coming back in, with the time they were out.",
    body=(
        "🏠 *Gate IN Recorded*\n\n"
        "Hello {{employee_name}},\n\n"
        "Welcome back. Your return has been recorded.\n\n"
        "🏷 Outpass type: {{pass_type}}\n"
        "📅 Date: {{date}}\n"
        "🕐 Gate OUT: {{gate_out_time}}\n"
        "🕑 Gate IN: {{gate_in_time}}\n"
        "⏱ Time out: {{duration}}\n"
        "📍 Destination: {{destination}}\n"
        "🚧 Gate: {{gate_name}}\n"
        "✅ Status: {{status}}\n\n"
        f"{SIGN}"
    ),
    variables=_GATE_VARS,
)


# ── lookups ────────────────────────────────────────────────────────────────────

TYPES: dict[str, MessageType] = {t.key: t for t in _TYPES}


def get(key: str) -> MessageType | None:
    return TYPES.get(key)


def label(key: str) -> str:
    t = TYPES.get(key)
    return t.label if t else key


def module_of(key: str) -> str:
    t = TYPES.get(key)
    return t.module if t else "other"


def types_in(module: str) -> tuple[str, ...]:
    return tuple(t.key for t in _TYPES if t.module == module)


def choices() -> tuple[tuple[str, str], ...]:
    return tuple((t.key, t.label) for t in _TYPES)


def categories() -> dict[str, tuple[str, ...]]:
    return {module: types_in(module) for module in MODULES if types_in(module)}


def variable_help(key: str) -> str:
    t = TYPES.get(key)
    if not t or not t.variables:
        return ""
    return ", ".join(f"{{{{{v.name}}}}} {v.help}" for v in t.variables)


def sample_params(key: str) -> dict[str, str]:
    t = TYPES.get(key)
    return {v.name: v.sample for v in t.variables} if t else {}
