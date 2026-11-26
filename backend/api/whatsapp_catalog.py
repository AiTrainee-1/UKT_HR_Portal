"""
The catalog of every WhatsApp message the HRMS can send.

    HRMS module -> notification service -> TYPE (this file) -> queue -> Meta template -> employee

One entry per message type says what it is called, which HRMS module it belongs
to, which switch on the WhatsApp Control page turns it off, its default wording
and which {{variables}} that wording may use. Everything else -the control page,
the template drafts, the message log, the on/off checks, the send queue- reads this
catalog, so adding a new notification is one entry here plus one call to
`whatsapp_service.send_notification` from the module that raises it.

Meta WhatsApp Cloud API (2026-11-20, whatsappintegrationsetup.md §7.2). A business may start a WhatsApp conversation
with an APPROVED Meta template only, so every type also names the template it goes out as:

  meta_template   "" = `hrms_<key>`; a name where the guide's table gives another one (hrms_otp, hrms_document,
                  hrms_punch_reminder, hrms_visitor_at_reception, hrms_gate_out, hrms_gate_in); "-" = never sent
                  through Meta (the description says why). HR can point a type at another approved template
                  (WhatsAppSettings.template_overrides).
  meta_header     "document" for the PDFs, "image" for the ID card: the file travels in the template's header.
  meta_category   UTILITY for everything about an employee's own work; AUTHENTICATION for the three one-time codes,
                  which share ONE copy-code template `hrms_otp` (Meta writes its words itself).

The default wording below is what WhatsApp Control's "Create template" drafts start from (the sign-off becomes the
template's footer), and what the message log shows when this server does not have the approved template's text. Meta
rules it follows: it never starts or ends with a variable, has fixed text around every variable, and each variable is
ONE line (a caller passes single-line values; whatsapp_cloud.sanitize_param flattens anything else). A template cannot
drop a line, so an empty optional value is sent as "-".

Each type also says how the send queue treats it (whatsapp_dispatcher.py):

  kind        code       a one-time code the employee is waiting for: sent at once, never queued
              requested  about the employee's own request (approved / rejected, Geo decisions)
              automatic  the system decided it (attendance alerts, reminders, gate, visitors, HoD
                         reminders): at most WhatsAppSettings.max_per_employee_per_day of these per
                         employee per day
              document   a file HR sends
  priority    lower goes first: code 0, document 3, requested 4, automatic 5
  freshness   minutes after it was raised that it is still worth sending (None: until the end of the
              day). Nothing is ever sent after the end of the day it was raised on (IST).

Wording uses {{name}} placeholders. The numbered form ({{1}}, {{2}} ...) still works (a
positional template HR made by hand at Meta): the number is the variable's position in
`variables`, so the ORDER of a type's variables must never change (append new ones at the end).

When the catalog wording itself is rendered (the log of a message whose template text this
server does not have), a line whose placeholders are all empty is dropped, so optional
details ("Note: {{comment}}") vanish instead of leaving an empty label behind.

The default wordings were reviewed on 2026-11-06 to look like a company writing to its own
staff, not a bulk sender: short, plain, no emojis or capitals, no motivational lines, signed
"- UK Textiles HR", no link in an automatic message (only the Geo punch decisions carry a map
link). The wording HR once saved on the old Message Text tab is no longer sent: with Meta the
wording IS the approved template.

No message carries a link to the Employee Web App (the owner does not want one), and the
placeholder that used to hold it is gone: see RETIRED_VARIABLES for how wording HR saved
earlier is kept from ever printing it.

This module deliberately imports nothing from the rest of the app (models import it).
"""

from dataclasses import dataclass

# ── modules (what the "Related HRMS module" column and the filters show) ────────

MODULES = {
    "documents": "Documents",
    "otp": "OTP & Login",
    "attendance": "Attendance",
    "approvals": "Approvals",
    "hod": "Department Heads",
    "geo": "Geo Attendance",
    "geo_alerts": "On-Duty tracking alerts",
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
    "hod": "hod_notifications_enabled",
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
    "holiday_work": "Holiday Work Compensation",
    "birthday_compensation": "Birthday Compensation",
    "resignation": "Resignation",
    "advance": "Advance",
    "request": "Other Requests",
}

# ── how the send queue treats each kind (see the module docstring) ──────────────

KIND_CODE = "code"
KIND_REQUESTED = "requested"
KIND_AUTOMATIC = "automatic"
KIND_DOCUMENT = "document"
KINDS = (KIND_CODE, KIND_REQUESTED, KIND_AUTOMATIC, KIND_DOCUMENT)

# The kind a module's messages have unless the entry says otherwise.
_KIND_OF_MODULE = {
    "documents": KIND_DOCUMENT,
    "otp": KIND_CODE,
    "attendance": KIND_AUTOMATIC,
    "approvals": KIND_REQUESTED,
    "hod": KIND_AUTOMATIC,
    "geo": KIND_REQUESTED,
    "geo_alerts": KIND_AUTOMATIC,
    "visitors": KIND_AUTOMATIC,
    "outpass": KIND_AUTOMATIC,
}
PRIORITY_OF_KIND = {KIND_CODE: 0, KIND_DOCUMENT: 3, KIND_REQUESTED: 4, KIND_AUTOMATIC: 5}
# A bulk send (every salary slip of a month) goes behind everything time-critical, so a few hundred documents never
# starve an approval or an alert until it is too late to send.
PRIORITY_BULK = 6


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
    # WhatsAppSettings column that switches just this message on/off, if any. A type without one (or sharing one with
    # another type) is switched one by one through WhatsAppSettings.disabled_message_types.
    switch: str | None = None
    # A one-time code that is missing from the wording would be a message nobody can log in with.
    must_contain_code: bool = False
    # A type with no wording of its own, so no template draft (the retired visitor contact card).
    has_wording: bool = True
    description: str = ""
    # The send queue (module docstring). Filled in by _add from the module when not given.
    kind: str = ""
    priority: int = 5
    # Minutes after it was raised that it is still worth sending; None = until the end of that day.
    fresh_minutes: int | None = None
    # A WhatsAppSettings column holding the freshness in minutes instead (a punch reminder: its lead window).
    fresh_setting: str | None = None
    # Meta WhatsApp Cloud API (2026-11-20). Every business-started message goes out as an APPROVED Meta template.
    # meta_template: the template's name ("" = the default f"hrms_{key}"; "-" = this type is not sent through Meta at
    # all, e.g. the retired visitor contact card); HR may point a type at another template (WhatsAppSettings.
    # template_overrides). meta_header: "" | "document" | "image" (a document / photo travels in the template's header).
    # meta_category: UTILITY for everything about an employee's own work, AUTHENTICATION for the one-time codes.
    meta_template: str = ""
    meta_header: str = ""
    meta_category: str = "UTILITY"
    # The Department Head copy of another type (the On-Duty tracking alerts, 2026-11-21): it follows that type's switch
    # (`switch` names the same column) and is never a switch of its own on WhatsApp Control.
    escalation_of: str = ""

    @property
    def variable_names(self) -> list[str]:
        return [v.name for v in self.variables]

    @property
    def default_template_name(self) -> str | None:
        """The Meta template this type is sent as unless HR chose another one; None = not sent through Meta."""
        if self.meta_template == "-":
            return None
        return self.meta_template or f"hrms_{self.key}"


def V(name: str, help: str, sample: str) -> Variable:
    return Variable(name, help, sample)


_TYPES: list[MessageType] = []


def _add(**kwargs) -> None:
    kind = kwargs.get("kind") or _KIND_OF_MODULE.get(kwargs["module"], KIND_AUTOMATIC)
    kwargs["kind"] = kind
    kwargs.setdefault("priority", PRIORITY_OF_KIND[kind])
    _TYPES.append(MessageType(**kwargs))


# The sign-off of every default wording: who the message is from.
SIGN = "- UK Textiles HR"

# Placeholders no message type offers any more. Wording HR saved before they were retired (migration 0130 removes
# them from the stored text; this is the second line of defence) can still name one: the editor refuses it as an
# unknown placeholder, and rendering drops the whole line instead of sending an empty label or a stray address.
# "link" was the Employee Web App address of the request in the two approval messages.
RETIRED_VARIABLES = frozenset({"link"})

# ── Documents (the wording is a caption; the file travels in the template's header) ─────────

_add(
    key="salary_slip",
    label="Salary Slip",
    module="documents",
    description="The salary slip PDF, sent with a short caption.",
    meta_header="document",
    body=f"*Salary Slip*\n\nDear {{{{employee_name}}}},\nYour salary slip for {{{{month_year}}}} is attached.\n\n{SIGN}",
    variables=(V("employee_name", "Employee name", "Asha Kumar"), V("month_year", "Month and year", "August 2026")),
)
_add(
    key="id_card",
    label="ID Card",
    module="documents",
    description="The employee ID card image, sent with a short caption.",
    meta_header="image",
    body=f"*Employee ID Card*\n\nDear {{{{employee_name}}}},\nYour employee ID card is attached.\n\n{SIGN}",
    variables=(V("employee_name", "Employee name", "Asha Kumar"),),
)
_add(
    key="offer_letter",
    label="Offer Letter",
    module="documents",
    description="The offer letter PDF, sent with a short caption.",
    meta_header="document",
    body=(
        f"*Offer Letter*\n\nDear {{{{employee_name}}}},\nYour offer letter for the position of {{{{designation}}}} "
        f"is attached.\n\n{SIGN}"
    ),
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
    meta_header="document",
    body=f"*Experience Letter*\n\nDear {{{{employee_name}}}},\nYour experience letter is attached.\n\n{SIGN}",
    variables=(V("employee_name", "Employee name", "Asha Kumar"),),
)
_add(
    key="resignation_letter",
    label="Resignation Letter",
    module="documents",
    description="The resignation letter PDF, sent with a short caption.",
    meta_header="document",
    body=(
        f"*Resignation Letter*\n\nDear {{{{employee_name}}}},\nYour resignation letter is attached.\n"
        f"Last working day: {{{{last_working_day}}}}\n\n{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("last_working_day", "Last working day", "30 Sep 2026"),
    ),
)
_add(
    key="other",
    label="Other Document",
    module="documents",
    description=(
        "Any other employee document HR sends from the Documents page (a photo of a document goes as a one-page PDF: "
        "a document header carries files, not pictures)."
    ),
    meta_template="hrms_document",
    meta_header="document",
    body=f"*Document*\n\nDear {{{{employee_name}}}},\nYour {{{{document_category}}}} document is attached.\n\n{SIGN}",
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("document_category", "Document category", "Appointment Letter"),
    ),
)

# ── OTP & login (the code is never stored in the history; sent at once, never queued) ───
# All three go as ONE Meta AUTHENTICATION template, `hrms_otp` (category Authentication -> Copy code): Meta writes its
# text itself ("123456 is your verification code. For your security, do not share this code. This code expires in 5
# minutes.") and the code is both its body parameter and its copy button's. The wording below is only what the log and
# a hand-made (non-authentication) template HR points a type at would use.

_CODE_VARS = (
    V("code", "The 6-digit code (keep it in the text)", "123456"),
    V("minutes", "Minutes until the code expires", "5"),
)
OTP_TEMPLATE = "hrms_otp"
_add(
    key="otp_login",
    label="Login OTP",
    module="otp",
    description="The code an employee enters to sign in to the apps.",
    switch="otp_login_enabled",
    must_contain_code=True,
    meta_template=OTP_TEMPLATE,
    meta_category="AUTHENTICATION",
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
    meta_template=OTP_TEMPLATE,
    meta_category="AUTHENTICATION",
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
    meta_template=OTP_TEMPLATE,
    meta_category="AUTHENTICATION",
    body=(
        "{{1}} is your UK Textiles HRMS account activation code. It expires in {{2}} minutes.\n\n"
        "Enter it in the app to set your password. Never share this code with anyone."
    ),
    variables=_CODE_VARS,
)

# ── Attendance alerts and punch reminders (automatic, checked every minute) ────

_add(
    key="absent_alert",
    label="Absent Alert",
    module="attendance",
    description="Sent when no punch has been recorded within the permitted time after the employee's shift starts.",
    switch="absent_alert_enabled",
    fresh_minutes=60,
    body=(
        "*Attendance Check*\n\n"
        "Dear {{employee_name}},\n"
        "We have not received your attendance punch today.\n\n"
        "Date: {{date}}\n"
        "Shift start: {{shift_start}}\n"
        "Punch allowed until: {{cutoff_time}}\n\n"
        "If you are at work, please punch in. If you are absent today, please inform HR.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("shift_start", "Shift start time", "8:30 AM"),
        V("cutoff_time", "Last time a punch was still accepted", "9:30 AM"),
        V("status", "Attendance status", "No punch recorded yet"),
        V("shift_end", "Shift end time", "5:30 PM"),
        V("wait_minutes", "Minutes allowed after the shift starts", "60"),
    ),
)
_add(
    key="late_alert",
    label="Late Attendance Alert",
    module="attendance",
    description="Sent as soon as the first punch of the day is seen to be after the shift start plus the shift's own grace period.",
    switch="late_alert_enabled",
    fresh_minutes=30,
    body=(
        "*Late Attendance*\n\n"
        "Dear {{employee_name}},\n"
        "Your attendance today has been marked as {{status}}.\n\n"
        "Date: {{date}}\n"
        "Shift start: {{shift_start}}\n"
        "Grace period: {{grace_period}}\n"
        "First punch: {{first_punch}}\n"
        "Late by: {{late_by}}\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("shift_start", "Shift start time", "9:00 AM"),
        V("first_punch", "Time of the first punch", "9:25 AM"),
        V("late_by", "How late, counted from the end of the grace period", "15 minutes"),
        V("status", "Attendance status", "Late"),
        V("grace_minutes", "The shift's grace period in minutes (number only)", "10"),
        V("grace_period", "The shift's grace period, worded", "10 minutes"),
    ),
)
_add(
    key="four_punch_alert",
    label="Punch Reminder",
    module="attendance",
    description=(
        "A short heads-up a few minutes before each of the day's punches (check-in, lunch-out, lunch-in, check-out) "
        "is expected, if it is still missing. Off by default (owner decision, 2026-11-06)."
    ),
    switch="four_punch_alert_enabled",
    fresh_setting="four_punch_lead_minutes",
    meta_template="hrms_punch_reminder",
    body=(
        "*Punch Reminder*\n\n"
        "Dear {{employee_name}},\n"
        "Your {{punch_name}} ({{punch_number}}) is due at {{expected_time}}, in {{minutes_left}}. "
        "Please remember to punch.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("punch_name", "Which punch is coming up", "Lunch-out"),
        V("hint", "When it is expected", "Expected at 1:00 PM."),
        V("punch_number", "Which of the day's punches", "2 of 4"),
        V("greeting", "Good morning / afternoon / evening", "Good afternoon"),
        V(
            "action",
            "What to do and how soon, worded for this punch",
            "your lunch break is coming up in 15 minutes. Please remember to punch out when you leave for lunch.",
        ),
        V("expected_time", "When the punch is expected", "1:00 PM"),
        V("minutes_left", "How long until then", "15 minutes"),
        V(
            "quote",
            "A short motivational line",
            "Great teams are built by people who show up, stay committed, and give their best every day.",
        ),
        V("closing", "A friendly sign-off for this punch", "Enjoy your break, you've earned it!"),
    ),
)
_add(
    key="on_duty_punch_reminder",
    label="On-Duty Punch Reminder",
    module="attendance",
    description="The same heads-up for employees working On-Duty, asking them to complete their Geo Punch.",
    switch="four_punch_alert_enabled",
    fresh_setting="four_punch_lead_minutes",
    body=(
        "*On-Duty Punch Reminder*\n\n"
        "Dear {{employee_name}},\n"
        "You are on duty at {{destination}} today. Your Geo Punch for {{punch_name}} ({{punch_number}}) is due at "
        "{{expected_time}}, in {{minutes_left}}. Please complete it in the app.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Today's date", "25 Sep 2026"),
        V("punch_name", "Which punch is coming up", "Lunch-in"),
        V("hint", "When it is expected", "Expected at 2:00 PM."),
        V("punch_number", "Which of the day's punches", "3 of 4"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
        V("greeting", "Good morning / afternoon / evening", "Good afternoon"),
        V("expected_time", "When the punch is expected", "2:00 PM"),
        V("minutes_left", "How long until then", "15 minutes"),
        V("quote", "A short motivational line", "Every stitch counts, and so does every person on this team."),
    ),
)
_add(
    key="missing_punch_alert",
    label="Missing Punch Alert",
    module="attendance",
    description="Sent when a punch is still missing a set time after it was expected (20 minutes by default). One message per missing punch.",
    switch="missing_punch_alert_enabled",
    fresh_minutes=60,
    body=(
        "*Missing Punch*\n\n"
        "Dear {{employee_name}},\n"
        "We noticed that {{intro}}\n\n"
        "Punch: {{punch_name}}\n"
        "Expected at: {{expected_time}}\n"
        "Date: {{date}}\n\n"
        "Please punch now. If you have already punched, please contact HR.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "Date", "25 Sep 2026"),
        V("recorded", "Punches recorded so far", "1 of 4"),
        V("missing", "Punches still to come", "Lunch-out, Lunch-in, Evening check-out"),
        V("punch_name", "Which punch is missing", "Morning check-in"),
        V("expected_time", "When it was expected", "9:00 AM"),
        V("status", "Where it stands", "Punch Not Recorded"),
        V("intro", "Which punch is missing, worded for it", "your attendance punch is still missing."),
    ),
)

# ── Approvals: one Approved and one Rejected wording for every workflow ────────

# Attendance Notify (owner 2026-11-17, /hr/attendance/attendance-notify): the attendance reports HR schedules. They go to
# numbers HR typed in, not to an employee, through the same paced queue as everything else. Module "other": no module
# switch, so the attendance alerts' switch does not stop them; their own switch does.
# With Meta (2026-11-20) a report is ONE template message per number: the counts on one line ("Absent 4, CL 2, On Leave
# 1"). The employee list and the PDF with photos go by Gmail or the internal chat; WhatsApp groups can't be reached by a
# template, so a group recipient is skipped with the reason.
_add(
    key="attendance_report",
    label="Attendance Report (Attendance Notify)",
    module="other",
    kind=KIND_DOCUMENT,
    description=(
        "The attendance reports scheduled on Attendance -> Attendance Notify, sent to the numbers chosen there: the "
        "report's name, its date and the counts on one line (the employee list and the PDF go by Gmail or chat)."
    ),
    body=(
        "*Attendance Report*\n\n"
        "Report: {{report_title}}\n"
        "Date: {{date}}\n"
        "Summary: {{summary}}\n\n"
        "The employee list is in the UK Textiles HRMS.\n"
        f"{SIGN}"
    ),
    variables=(
        V("report_title", "The automation's name, the employees it covers and the branch", "Morning absentees (Staff)"),
        V("date", "The report's date or dates, with the time for a report about today", "17 Nov 2026, as of 09:30"),
        V(
            "summary",
            "Each category's count on one line, and how many employees are in the report",
            "Absent 4, CL 2, On Leave 1 (7 of 250 employees)",
        ),
    ),
)


_APPROVAL_VARS = (
    V("employee_name", "Employee name", "Asha Kumar"),
    V("request_type", "Which kind of request (Leave, Permission, ...)", "Leave"),
    V("date", "The date(s) the request is for", "26 Sep 2026 to 27 Sep 2026"),
    V("time", "The time, when the request has one", "10:30 AM"),
    V("details", "What was requested", "Sick Leave - 2 days"),
    V("approver", "Who approved or rejected it", "Meena (HR)"),
    V("comment", "The approver's note or rejection reason, if given", "Get well soon"),
    V("requested_on", "When it was submitted", "24 Sep 2026"),
    V("reason", "The employee's own reason for the request", "Fever"),
)
_add(
    key="approval_approved",
    label="Approval - Approved",
    module="approvals",
    description="Sent to the employee when a Leave, Permission, Casual Leave, Missing Punch, Outpass, Resignation, Advance or other request is approved.",
    body=(
        "*Request Approved*\n\n"
        "Dear {{employee_name}},\n"
        "Your *{{request_type}}* request has been approved.\n\n"
        "Date: {{date}}\n"
        "Time: {{time}}\n"
        "Request: {{details}}\n"
        "Approved by: {{approver}}\n"
        "Note: {{comment}}\n\n"
        f"{SIGN}"
    ),
    variables=_APPROVAL_VARS,
)
_add(
    key="approval_rejected",
    label="Approval - Rejected",
    module="approvals",
    description="Sent to the employee when one of those requests is rejected, with the reason if one was given.",
    body=(
        "*Request Rejected*\n\n"
        "Dear {{employee_name}},\n"
        "Your *{{request_type}}* request has been rejected.\n\n"
        "Date: {{date}}\n"
        "Time: {{time}}\n"
        "Request: {{details}}\n"
        "Rejected by: {{approver}}\n"
        "Reason: {{comment}}\n\n"
        "Please contact HR if you have any questions.\n"
        f"{SIGN}"
    ),
    variables=_APPROVAL_VARS,
)
# ── Department Heads (2026-11-17): what a head is told about the requests that wait for THEM ──────────────────────

# A request reached a Department Head's step (submitted, or passed on to them): whatsapp_hod.request_waiting, called
# wherever the HRMS tells a head a request waits (approval_workflow.notify_hod_of_request, the On-Duty / Missing Punch /
# resignation submissions). One message per request and head.
_add(
    key="hod_request_waiting",
    label="New request waiting for approval",
    module="hod",
    kind=KIND_REQUESTED,  # tied to one request: never held by the per-employee daily cap of automatic messages
    switch="hod_request_waiting_enabled",
    description=(
        "Tells a Department Head that a request (leave, permission, CL, missing punch, outpass, On-Duty, resignation "
        "and the others) has reached their step and waits for their decision."
    ),
    body=(
        "*Approval Needed*\n\n"
        "Dear {{hod_name}},\n"
        "{{employee_name}} ({{employee_code}}) has a *{{request_type}}* request waiting for your approval.\n\n"
        "Date: {{date}}\n"
        "Time: {{time}}\n"
        "Request: {{details}}\n"
        "Reason: {{reason}}\n"
        "Submitted: {{requested_on}}\n\n"
        "Please review it in the UK Textiles app (Approvals).\n"
        f"{SIGN}"
    ),
    variables=(
        V("hod_name", "The Department Head's name", "Suresh Kumar"),
        V("employee_name", "Who raised the request", "Asha Kumar"),
        V("employee_code", "Their employee code", "30012"),
        V("request_type", "The kind of request", "Leave"),
        V("date", "The date(s) of the request", "26 Sep 2026 to 27 Sep 2026"),
        V("time", "The time, when the request has one", "10:30 AM"),
        V("details", "What is asked", "Sick Leave - 2 days"),
        V("reason", "The employee's reason", "Fever"),
        V("requested_on", "When it was submitted", "24 Sep 2026"),
    ),
)
# The reminder to a Department Head about the requests waiting for their approval (HR Requests page -> Notify,
# hod_reminders.py): it keeps the schedule and the recipients set there. The wording HR writes on that tab goes by email
# and phone notification; WhatsApp sends this approved template, with the pending list on one line
# ("Leave 2, Permission 1": a template variable cannot hold several lines).
_add(
    key="hod_pending_reminder",
    label="HoD Pending Approvals Reminder",
    module="hod",
    kind=KIND_AUTOMATIC,
    description=(
        "Reminds a Department Head of the requests waiting for their approval, at the times HR set on Requests -> "
        "Notify, with the pending requests on one line (Leave 2, Permission 1)."
    ),
    body=(
        "*Pending Approvals*\n\n"
        "Dear {{hod_name}},\n"
        "You have {{total}} request(s) waiting for your approval as of {{date}}: {{pending_list}}.\n"
        "Kindly review and approve them in the UK Textiles app at the earliest.\n"
        f"{SIGN}"
    ),
    variables=(
        V("hod_name", "The Department Head's name", "Suresh Kumar"),
        V("total", "How many requests are waiting for them", "4"),
        V("pending_list", "The pending requests by kind, on one line", "Leave 3, Permission 1"),
        V("date", "Today's date", "04 Nov 2026"),
    ),
)

# ── Geo Attendance (On-Duty) and its punches ───────────────────────────────────

_add(
    key="geo_approval",
    label="Geo Attendance Approved",
    module="geo",
    description="Sent when HR gives the final approval of a Geo Attendance (On-Duty) request.",
    switch="geo_approval_enabled",
    fresh_minutes=120,
    body=(
        "*Geo Attendance Request Approved*\n\n"
        "Dear {{employee_name}},\n"
        "Your Geo Attendance (On-Duty) request has been approved. You can now punch from the app.\n\n"
        "Destination: {{destination}}\n"
        "Requested on: {{requested_on}}\n"
        "Approved by: {{approved_by}}\n"
        "Note: {{comment}}\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("destination", "The destination they requested", "Tirupur Dyeing Unit"),
        V("requested_on", "When they requested it", "25 Sep 2026, 9:10 AM"),
        V("approved_by", "Who approved it", "Meena"),
        V("note", "The approver's note with its label (older wording)", "Note: Take the van"),
        V("comment", "The approver's note", "Take the van"),
    ),
)
_add(
    key="geo_rejection",
    label="Geo Attendance Rejected",
    module="geo",
    description="Sent when a Geo Attendance (On-Duty) request is rejected, by the Department Head or by HR.",
    switch="geo_approval_enabled",
    fresh_minutes=120,
    body=(
        "*Geo Attendance Request Rejected*\n\n"
        "Dear {{employee_name}},\n"
        "Your Geo Attendance (On-Duty) request has been rejected.\n\n"
        "Destination: {{destination}}\n"
        "Requested on: {{requested_on}}\n"
        "Rejected by: {{rejected_by}}\n"
        "Reason: {{comment}}\n"
        "{{punches_note}}\n\n"
        "Please contact HR if you have any questions.\n"
        f"{SIGN}"
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
    fresh_minutes=120,
    body=(
        "*Geo Punch Approved*\n\n"
        "Dear {{employee_name}},\n"
        "Your Geo Attendance {{punch_name}} has been approved.\n\n"
        "Date: {{date}}\n"
        "Time: {{time}}\n"
        "Location: {{location}}\n"
        "Approved by: {{approved_by}}\n"
        "Note: {{comment}}\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("punch_name", "Check-In or Check-Out", "Check-In"),
        V("date", "Punch date", "25 Sep 2026"),
        V("time", "Punch time", "9:12 AM"),
        V("location", "A map link to where it was captured", "https://maps.google.com/?q=11.1,77.3"),
        V("approved_by", "Who approved it", "Meena"),
        V("comment", "The approver's note, if given", "Location confirmed"),
    ),
)
_add(
    key="geo_punch_rejection",
    label="Geo Punch Rejected",
    module="geo",
    description="Sent when HR rejects one captured Geo Attendance punch.",
    switch="geo_approval_enabled",
    fresh_minutes=120,
    body=(
        "*Geo Punch Rejected*\n\n"
        "Dear {{employee_name}},\n"
        "Your Geo Attendance {{punch_name}} has been rejected and does not count as attendance. "
        "You can punch again from the app.\n\n"
        "Date: {{date}}\n"
        "Time: {{time}}\n"
        "Location: {{location}}\n"
        "Rejected by: {{rejected_by}}\n"
        "Reason: {{comment}}\n\n"
        f"{SIGN}"
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

# ── On-Duty tracking alerts (2026-11-21, geo_tracking/alerts.py) ───────────────
# Raised by the geo-tracking watchdog while an On-Duty track records: the employee is told what to fix, and when it is
# still not fixed after the grace period (Geo Attendance -> Settings) their Department Head is told too (the *_hod copy,
# which follows the same switch). Each kind has ONE switch here, off until HR turns it on (its two Meta templates must be
# approved first). The phone notification of the same alert is Phone Notify Control's own.

_add(
    key="geo_location_off",
    label="Location Turned Off Alert",
    module="geo_alerts",
    switch="geo_location_off_enabled",
    fresh_minutes=30,
    description=(
        "Tells an employee on On-Duty that their phone's location was turned off, so their route is not recorded. Their "
        "Department Head is told too when it stays off past the grace period."
    ),
    body=(
        "*Location Turned Off*\n\n"
        "Dear {{employee_name}},\n"
        "Your phone's location was turned off at {{since}} while you are On-Duty ({{destination}}).\n"
        "Please turn Location back on now so that your On-Duty route is recorded.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("since", "When location went off", "10:05 AM"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
        V("date", "Today's date", "21 Nov 2026"),
    ),
)
_add(
    key="geo_location_off_hod",
    label="Location Turned Off (to Department Head)",
    module="geo_alerts",
    switch="geo_location_off_enabled",
    escalation_of="geo_location_off",
    fresh_minutes=60,
    description="Tells the employee's Department Head that location is still off after the employee was alerted.",
    body=(
        "*On-Duty Alert: Location Off*\n\n"
        "Dear {{hod_name}},\n"
        "The phone location of {{employee_name}} ({{employee_code}}) has been off since {{since}} during On-Duty "
        "({{destination}}).\n"
        "They were alerted at {{alerted_at}} and have not turned it back on yet.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("hod_name", "The Department Head's name", "Suresh Kumar"),
        V("employee_name", "The employee on duty", "Asha Kumar"),
        V("employee_code", "Their employee code", "30012"),
        V("since", "When location went off", "10:05 AM"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
        V("alerted_at", "When the employee was alerted", "10:08 AM"),
    ),
)
_add(
    key="geo_permission_restricted",
    label="Background Location Permission Alert",
    module="geo_alerts",
    switch="geo_permission_restricted_enabled",
    fresh_minutes=30,
    description=(
        "Tells an employee on On-Duty that the app's location permission is not 'Allow all the time', so the route "
        "cannot be recorded in the background. Their Department Head is told too when it is not fixed in time."
    ),
    body=(
        "*Allow Location All the Time*\n\n"
        "Dear {{employee_name}},\n"
        'The location permission of the UK Textiles app on your phone is "{{permission}}", so your On-Duty route '
        "cannot be recorded in the background.\n"
        'Please open Settings > Apps > UK Textiles > Permissions > Location and choose "Allow all the time".\n\n'
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("permission", "The permission the phone has now", "Only while using the app"),
        V("since", "When it was noticed", "10:05 AM"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
    ),
)
_add(
    key="geo_permission_restricted_hod",
    label="Background Location Permission (to Department Head)",
    module="geo_alerts",
    switch="geo_permission_restricted_enabled",
    escalation_of="geo_permission_restricted",
    fresh_minutes=60,
    description="Tells the employee's Department Head that the location permission is still restricted.",
    body=(
        "*On-Duty Alert: Location Permission*\n\n"
        "Dear {{hod_name}},\n"
        "The UK Textiles app on the phone of {{employee_name}} ({{employee_code}}) has the location permission "
        '"{{permission}}" instead of "Allow all the time" since {{since}}, so their On-Duty route is not fully '
        "recorded.\n"
        "They were alerted at {{alerted_at}} and have not changed it yet.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("hod_name", "The Department Head's name", "Suresh Kumar"),
        V("employee_name", "The employee on duty", "Asha Kumar"),
        V("employee_code", "Their employee code", "30012"),
        V("permission", "The permission the phone has now", "Only while using the app"),
        V("since", "When it was noticed", "10:05 AM"),
        V("alerted_at", "When the employee was alerted", "10:08 AM"),
    ),
)
_add(
    key="geo_background_restricted",
    label="Background App Restriction Alert",
    module="geo_alerts",
    switch="geo_background_restricted_enabled",
    fresh_minutes=30,
    description=(
        "Tells an employee on On-Duty that their phone restricts the app in the background (background use restricted, "
        "or battery optimisation on), so the route may stop recording. Their Department Head is told too when it is "
        "not fixed in time."
    ),
    body=(
        "*Let the App Run in the Background*\n\n"
        "Dear {{employee_name}},\n"
        "Your phone is limiting the UK Textiles app in the background ({{restriction}}), so your On-Duty route may stop "
        "recording.\n"
        'Please open Settings > Apps > UK Textiles > Battery and choose "Unrestricted" (no battery optimisation).\n\n'
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("restriction", "What the phone restricts", "battery optimisation is on"),
        V("since", "When it was noticed", "10:05 AM"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
    ),
)
_add(
    key="geo_background_restricted_hod",
    label="Background App Restriction (to Department Head)",
    module="geo_alerts",
    switch="geo_background_restricted_enabled",
    escalation_of="geo_background_restricted",
    fresh_minutes=60,
    description="Tells the employee's Department Head that the phone still restricts the app in the background.",
    body=(
        "*On-Duty Alert: App Restricted*\n\n"
        "Dear {{hod_name}},\n"
        "The phone of {{employee_name}} ({{employee_code}}) has been limiting the UK Textiles app in the background "
        "({{restriction}}) since {{since}}, so their On-Duty route may not be recorded.\n"
        "They were alerted at {{alerted_at}} and have not changed it yet.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("hod_name", "The Department Head's name", "Suresh Kumar"),
        V("employee_name", "The employee on duty", "Asha Kumar"),
        V("employee_code", "Their employee code", "30012"),
        V("restriction", "What the phone restricts", "battery optimisation is on"),
        V("since", "When it was noticed", "10:05 AM"),
        V("alerted_at", "When the employee was alerted", "10:08 AM"),
    ),
)
_add(
    key="geo_missing_punch",
    label="Missing Geo-Punch Alert",
    module="geo_alerts",
    switch="geo_missing_punch_enabled",
    fresh_minutes=60,
    description=(
        "Tells an employee on On-Duty that a Geo-Punch is missing: none since the duty started (after the set wait), or "
        "fewer than the day's 4 punches at the end of the duty day. Their Department Head is told too when it is still "
        "missing after the grace period."
    ),
    body=(
        "*Geo-Punch Missing*\n\n"
        "Dear {{employee_name}},\n"
        "On-Duty punch check for {{date}}: {{punch_status}}.\n"
        "Please record the missing Geo-Punch in the UK Textiles app, or raise a Missing Punch request if your duty has "
        "ended.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("date", "The duty day", "21 Nov 2026"),
        V("punch_status", "What is missing", "only 2 of the day's 4 punches are recorded"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
    ),
)
_add(
    key="geo_missing_punch_hod",
    label="Missing Geo-Punch (to Department Head)",
    module="geo_alerts",
    switch="geo_missing_punch_enabled",
    escalation_of="geo_missing_punch",
    fresh_minutes=60,
    description="Tells the employee's Department Head that the Geo-Punch is still missing after the employee was alerted.",
    body=(
        "*On-Duty Alert: Geo-Punch Missing*\n\n"
        "Dear {{hod_name}},\n"
        "On-Duty punch check for {{employee_name}} ({{employee_code}}) on {{date}}: {{punch_status}}.\n"
        "They were alerted at {{alerted_at}} and it is still not recorded.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("hod_name", "The Department Head's name", "Suresh Kumar"),
        V("employee_name", "The employee on duty", "Asha Kumar"),
        V("employee_code", "Their employee code", "30012"),
        V("date", "The duty day", "21 Nov 2026"),
        V("punch_status", "What is missing", "only 2 of the day's 4 punches are recorded"),
        V("alerted_at", "When the employee was alerted", "6:32 PM"),
    ),
)
_add(
    key="geo_punch_reminder",
    label="Geo-Punch Reminder",
    module="geo_alerts",
    switch="geo_punch_reminder_enabled",
    fresh_minutes=30,
    description=(
        "A friendly reminder to an employee on On-Duty who has made no Geo-Punch for the set time (Geo Attendance -> "
        "Settings), while a punch of the day is still free. One reminder per wait; never to the Department Head."
    ),
    body=(
        "*Geo-Punch Reminder*\n\n"
        "Dear {{employee_name}},\n"
        "No Geo-Punch has been recorded for {{waited}} (since {{since_text}}) while you are On-Duty ({{destination}}).\n"
        "If your next punch is due, please record it in the UK Textiles app.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("waited", "How long since the last punch", "3 hours"),
        V("since_text", "What the wait counts from", "your punch at 9:30 AM"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
        V("punches", "Punches recorded today", "1 of 4"),
    ),
)
_add(
    key="geo_tracking_failure",
    label="On-Duty Tracking Failure Alert",
    module="geo_alerts",
    switch="geo_tracking_failure_enabled",
    fresh_minutes=30,
    description=(
        "Tells an employee on On-Duty that their phone has sent no location for the signal-lost time (the app was "
        "closed, the phone is off or offline). Their Department Head is told too when nothing arrives within the grace "
        "period."
    ),
    body=(
        "*On-Duty Tracking Stopped*\n\n"
        "Dear {{employee_name}},\n"
        "We have not received your On-Duty location since {{last_heard}}.\n"
        "Please open the UK Textiles app, stay signed in, and check that Location and mobile data are on.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("last_heard", "When the phone last sent its location", "10:05 AM"),
        V("destination", "The On-Duty destination", "Tirupur Dyeing Unit"),
    ),
)
_add(
    key="geo_tracking_failure_hod",
    label="On-Duty Tracking Failure (to Department Head)",
    module="geo_alerts",
    switch="geo_tracking_failure_enabled",
    escalation_of="geo_tracking_failure",
    fresh_minutes=60,
    description="Tells the employee's Department Head that the phone is still sending no location.",
    body=(
        "*On-Duty Alert: Tracking Stopped*\n\n"
        "Dear {{hod_name}},\n"
        "No On-Duty location has been received from {{employee_name}} ({{employee_code}}) since {{last_heard}}. The "
        "app may have been closed, or the phone is off or offline.\n"
        "They were alerted at {{alerted_at}}.\n\n"
        f"{SIGN}"
    ),
    variables=(
        V("hod_name", "The Department Head's name", "Suresh Kumar"),
        V("employee_name", "The employee on duty", "Asha Kumar"),
        V("employee_code", "Their employee code", "30012"),
        V("last_heard", "When the phone last sent its location", "10:05 AM"),
        V("alerted_at", "When the employee was alerted", "10:17 AM"),
    ),
)

# ── Visitors ───────────────────────────────────────────────────────────────────

_add(
    key="visitor_notification",
    label="Visitor Notification",
    module="visitors",
    description=(
        "Tells an employee who has arrived at reception to meet them, and why, with the visitor's phone number."
    ),
    fresh_minutes=30,
    meta_template="hrms_visitor_at_reception",
    body=(
        "*Visitor at Reception*\n\n"
        "Dear {{employee_name}},\n"
        "A visitor is waiting for you at reception.\n\n"
        "Visitor: {{visitor_name}}\n"
        "Contact: {{visitor_phone}}\n"
        "Company: {{company}}\n"
        "Purpose: {{purpose}}\n"
        "Here to meet: {{host_name}}\n"
        "Department: {{department}}\n"
        "Date: {{visit_date}}\n"
        "Time: {{visit_time}}\n"
        "Branch: {{branch}}\n\n"
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
# Retired with the Meta WhatsApp Cloud API (2026-11-20): a template message cannot carry a contact card, and a business
# may start a conversation with a template only. Kept so older log rows still have a name.
_add(
    key="visitor_contact",
    label="Visitor Contact Card",
    module="visitors",
    description=(
        "No longer sent: the official WhatsApp Cloud API can't start a conversation with a contact card. The visitor's "
        "phone number is a line of the Visitor Notification instead."
    ),
    has_wording=False,
    fresh_minutes=30,
    meta_template="-",
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
    fresh_minutes=30,
    meta_template="hrms_gate_out",
    body=(
        "*Gate Exit Recorded*\n\n"
        "Dear {{employee_name}},\n"
        "Your gate exit has been recorded.\n\n"
        "Outpass type: {{pass_type}}\n"
        "Date: {{date}}\n"
        "Gate out: {{gate_out_time}}\n"
        "Destination: {{destination}}\n"
        "Reason: {{reason}}\n"
        "Gate: {{gate_name}}\n"
        "Status: {{status}}\n\n"
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
    fresh_minutes=30,
    meta_template="hrms_gate_in",
    body=(
        "*Gate Return Recorded*\n\n"
        "Dear {{employee_name}},\n"
        "Welcome back. Your return has been recorded.\n\n"
        "Outpass type: {{pass_type}}\n"
        "Date: {{date}}\n"
        "Gate out: {{gate_out_time}}\n"
        "Gate in: {{gate_in_time}}\n"
        "Time out: {{duration}}\n"
        "Destination: {{destination}}\n"
        "Gate: {{gate_name}}\n"
        "Status: {{status}}\n\n"
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


def kind_of(key: str) -> str:
    """The queue kind of a message type (code | requested | automatic | document); an unknown type is automatic."""
    t = TYPES.get(key)
    return t.kind if t else KIND_AUTOMATIC


def types_in(module: str) -> tuple[str, ...]:
    return tuple(t.key for t in _TYPES if t.module == module)


def choices() -> tuple[tuple[str, str], ...]:
    return tuple((t.key, t.label) for t in _TYPES)


def categories() -> dict[str, tuple[str, ...]]:
    return {module: types_in(module) for module in MODULES if types_in(module)}


def individually_switched() -> tuple[str, ...]:
    """The types that need an entry in WhatsAppSettings.disabled_message_types to be switched off one by one: those with
    no boolean switch of their own, and those whose boolean is shared with another type (the two punch reminders, the
    four Geo decisions)."""
    shared: dict[str, int] = {}
    for t in _TYPES:
        if t.switch and not t.escalation_of:
            shared[t.switch] = shared.get(t.switch, 0) + 1
    # a Department Head copy follows its type's switch (escalation_of): never a switch of its own
    return tuple(t.key for t in _TYPES if not t.escalation_of and (not t.switch or shared[t.switch] > 1))


def variable_help(key: str) -> str:
    t = TYPES.get(key)
    if not t or not t.variables:
        return ""
    return ", ".join(f"{{{{{v.name}}}}} {v.help}" for v in t.variables)


def sample_params(key: str) -> dict[str, str]:
    t = TYPES.get(key)
    return {v.name: v.sample for v in t.variables} if t else {}
