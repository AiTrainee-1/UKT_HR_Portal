"""
The catalog of every email the HRMS can send (through the Gmail / SMTP account in Settings).

    HRMS module -> email_service.send_email() -> TEMPLATE (this file) -> SMTP -> recipient

One entry per email type says what it is called, which HRMS module it belongs to, its default
subject and wording, and which {{variables}} that wording may use. Everything else -the Gmail
Control page, the wording editor, the history, the on/off checks- reads this catalog, so adding an
email is one entry here plus one call to `email_service.send_email` from the module that sends it.

Wording uses {{name}} placeholders (the same syntax as the WhatsApp messages). Blank lines separate
paragraphs, a single line break stays a line break, and **double asterisks** make text bold. A line
whose placeholders are all empty is dropped, so an optional detail simply vanishes.

A type may also have a fixed `details` table (label -> variable), such as the visitor's phone and
purpose. `{{details}}` in the wording says where the table goes; without it the table is added at
the end. HR edits the subject and the wording; the layout around them stays the same for every email.

This module deliberately imports nothing from the rest of the app (models import it).
"""

from dataclasses import dataclass

# ── modules (what the "Related HRMS module" column and the filters show) ────────

MODULES = {
    "documents": "Documents",
    "visitors": "Visitors",
    "recruitment": "Recruitment",
    "other": "Other",
}

# The switch (an EmailSettings column) that turns a whole module off. A module with no entry is
# controlled only by its per-email switches on the Message Text tab.
MODULE_SWITCHES = {
    "documents": "document_emails_enabled",
    "visitors": "visitor_emails_enabled",
    "recruitment": "recruitment_emails_enabled",
}

# The wording token that marks where a type's details table goes.
DETAILS_TOKEN = "details"


@dataclass(frozen=True)
class Variable:
    name: str
    help: str
    sample: str


@dataclass(frozen=True)
class EmailType:
    key: str
    label: str
    module: str
    subject: str
    body: str
    variables: tuple = ()
    # The banner text under the company name. May use the same {{variables}}. Not editable.
    heading: str = ""
    # Fixed details table: ((label, variable_name), ...). A row whose value is empty is dropped.
    details: tuple = ()
    # What is attached, for the wording editor ("" = nothing).
    attachment: str = ""
    # Banner colour, so a letter keeps the look it always had.
    accent: str = "#0E4B3A"
    description: str = ""

    @property
    def variable_names(self) -> list[str]:
        return [v.name for v in self.variables]


def V(name: str, help: str, sample: str) -> Variable:
    return Variable(name, help, sample)


_TYPES: list[EmailType] = []


def _add(**kwargs) -> None:
    _TYPES.append(EmailType(**kwargs))


COMPANY = V("company_name", "Company name", "UK Textiles")

# ── Documents ─────────────────────────────────────────────────────────────────

_add(
    key="salary_slip",
    label="Salary Slip",
    module="documents",
    description="A salary slip, single or bulk, with the slip PDF attached.",
    subject="Salary Slip – {{month_year}} | {{company_name}}",
    heading="Salary Slip – {{month_year}}",
    attachment="Salary slip (PDF)",
    body=(
        "Dear **{{employee_name}}**,\n\n"
        "Please find attached your salary slip for **{{month_year}}**.\n\n"
        "Net amount paid: **{{net_salary}}**\n\n"
        "This is a system-generated email. For any discrepancies, please contact HR."
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("month_year", "Month and year of the slip", "August 2026"),
        V("net_salary", "Net amount paid, with the rupee sign", "₹24,500.00"),
        COMPANY,
    ),
)
_add(
    key="offer_letter",
    label="Offer Letter",
    module="documents",
    description="The offer of employment, with the offer letter PDF attached.",
    subject="Offer of Employment – {{designation}} | {{company_name}}",
    heading="Offer of Employment",
    attachment="Offer letter (PDF)",
    body=(
        "Dear **{{employee_name}}**,\n\n"
        "We are pleased to share your offer of employment as **{{designation}}** with {{company_name}}. "
        "Please find the detailed offer letter attached."
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("designation", "The role being offered", "Senior Weaver"),
        COMPANY,
    ),
)
_add(
    key="id_card",
    label="ID Card",
    module="documents",
    description="An employee's ID card image, attached to a short note.",
    subject="Your Employee ID Card – {{company_name}}",
    heading="Employee ID Card",
    attachment="ID card (PNG image)",
    body=(
        "Dear **{{employee_name}}**,\n\nPlease find your employee ID card attached.\n\nRegards,\n{{company_name}} HR"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("employee_code", "Employee code", "UKT0042"),
        COMPANY,
    ),
)
_add(
    key="resignation_letter",
    label="Resignation Acceptance Letter",
    module="documents",
    description="Confirms an approved resignation, with the acceptance letter PDF attached.",
    subject="Resignation Acceptance Letter | {{company_name}}",
    heading="Resignation Acceptance Letter",
    accent="#006496",
    attachment="Acceptance letter (PDF)",
    details=(
        ("Employee Name", "employee_name"),
        ("Employee Code", "employee_code"),
        ("Department", "department"),
        ("Last Working Day", "last_working_day"),
        ("Approved By", "approved_by"),
        ("Approval Date", "approval_date"),
    ),
    body=(
        "Dear **{{employee_name}}**,\n\n"
        "We acknowledge receipt of your resignation and are pleased to confirm that your resignation has been "
        "**accepted with effect from {{last_working_day}}**.\n\n"
        "{{details}}\n\n"
        "We appreciate your valuable contributions during your tenure and wish you all the best in your future "
        "endeavors. Please ensure all handover formalities are completed before your last working day.\n\n"
        "Full and final settlement will be processed as per company policy.\n\n"
        "Warm Regards,\n**HR Department**\n{{company_name}}"
    ),
    variables=(
        V("employee_name", "Employee name", "Asha Kumar"),
        V("employee_code", "Employee code", "UKT0042"),
        V("department", "Department", "Weaving"),
        V("last_working_day", "Last working day", "30 September 2026"),
        V("approved_by", "Who approved the resignation", "HR Management"),
        V("approval_date", "Date the letter was issued", "25 September 2026"),
        COMPANY,
    ),
)

# ── Visitors ──────────────────────────────────────────────────────────────────

_add(
    key="visitor_arrival",
    label="Visitor Arrival",
    module="visitors",
    description="Sent to the employee a visitor came to meet, as soon as the visitor checks in at reception.",
    subject="You have a visitor: {{visitor_name}}",
    heading="Visitor Arrival Notice",
    details=(("Phone", "visitor_phone"), ("Purpose", "purpose")),
    body="Dear **{{employee_name}}**,\n\n**{{visitor_name}}** has arrived at reception to meet you.\n\n{{details}}",
    variables=(
        V("employee_name", "The employee being visited", "Asha Kumar"),
        V("visitor_name", "Visitor's name", "Ravi Nair"),
        V("visitor_phone", "Visitor's phone number", "98765 43210"),
        V("purpose", "Why they came, as written on the form", "Vendor meeting"),
        COMPANY,
    ),
)

# ── Recruitment ───────────────────────────────────────────────────────────────

_add(
    key="screening_rejection",
    label="Application Update (Rejection)",
    module="recruitment",
    description="Tells a resume-screening candidate they were not selected. Sent from Resume Screening.",
    subject="Application Update – {{company_name}}",
    heading="Recruitment Update",
    body=(
        "Dear **{{candidate_name}}**,\n\n"
        "Thank you for participating in our recruitment process and for your interest in {{company_name}}. "
        "We appreciate your time and effort. Unfortunately, you were not selected this time. We wish you all the "
        "best and hope to connect with you again in the future."
    ),
    variables=(V("candidate_name", "Candidate's name", "Meena Iyer"), COMPANY),
)
_add(
    key="interview_invite",
    label="Interview Invitation",
    module="recruitment",
    description="Invites a shortlisted resume-screening candidate to an interview.",
    subject="Interview Invitation – {{company_name}}",
    heading="Interview Invitation",
    details=(("Date & Time", "interview_datetime"), ("Location", "location")),
    body=(
        "Dear **{{candidate_name}}**,\n\n"
        "We are pleased to inform you that you have been shortlisted for the next stage of our recruitment process "
        "at {{company_name}}. We would like to invite you for a face-to-face interview at our office.\n\n"
        "{{details}}\n\n"
        "Please bring a copy of your resume and a valid photo ID. We look forward to meeting you."
    ),
    variables=(
        V("candidate_name", "Candidate's name", "Meena Iyer"),
        V("interview_datetime", "Interview date and time", "Monday, 05 October 2026 at 10:30 AM"),
        V("location", "Office address from Settings", "12 Mill Road, Tirupur"),
        COMPANY,
    ),
)

# ── Other ─────────────────────────────────────────────────────────────────────

_add(
    key="test_email",
    label="Test Email",
    module="other",
    description="The test message HR sends from the Configuration tab to check the Gmail connection.",
    subject="Test email from {{company_name}} HRMS",
    heading="Email Test",
    body=(
        "Hello,\n\n"
        "This is a test email from the {{company_name}} HRMS, sent from the Gmail Control page. "
        "If you can read this, the Gmail account in Settings is working.\n\n"
        "No action is needed."
    ),
    variables=(COMPANY,),
)


# ── lookups ────────────────────────────────────────────────────────────────────

TYPES: dict[str, EmailType] = {t.key: t for t in _TYPES}


def get(key: str) -> EmailType | None:
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
