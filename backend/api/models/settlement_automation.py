"""Settlement Automation Method (owner 2026-11-26): Settings -> Settlement chooses the Normal Method (the Settlement page as
it always was) or the Automation Method, a month-wise workflow HR -> MD -> HR final -> auditor -> accounts.

See api/settlement_automation/ for the rules; these are only the tables.
"""

from django.db import models

from .payroll import Advance


class SettlementSettings(models.Model):
    """One row: which method the Settlement page runs, and where the Automation Method's files go."""

    METHOD_NORMAL = "normal"
    METHOD_AUTOMATION = "automation"
    METHODS = [(METHOD_NORMAL, "Normal Method"), (METHOD_AUTOMATION, "Automation Method")]

    method = models.TextField(choices=METHODS, default=METHOD_NORMAL, db_default=METHOD_NORMAL)
    # e-mail addresses (lists of strings): the finalized report goes to the auditor, the bank file to accounts
    auditor_emails = models.JSONField(default=list, blank=True)
    auditor_cc = models.JSONField(default=list, blank=True)
    accounts_emails = models.JSONField(default=list, blank=True)
    accounts_cc = models.JSONField(default=list, blank=True)
    # how long the auditor's review link works (days, 2026-11-27)
    auditor_link_days = models.IntegerField(default=7, db_default=7)

    # ── Salary Advance rules (owner 2026-11-27: every rule set here, not in code; api/advance_rules.py) ──
    sa_percent = models.IntegerField(
        default=50, db_default=50
    )  # % of the salary earned from the 1st to `sa_earned_through`
    sa_window_from = models.IntegerField(default=21, db_default=21)  # employees apply from this day ...
    sa_window_to = models.IntegerField(default=22, db_default=22)  # ... to this day of the month
    sa_earned_through = models.IntegerField(default=20, db_default=20)  # the earned salary counts the 1st to this day
    sa_per_month = models.IntegerField(default=1, db_default=1)  # Salary Advances an employee may have in a month
    sa_rejected_allows_reapply = models.BooleanField(default=True, db_default=True)  # a rejected one does not count

    # ── Term Loan rules (staff only) ──
    tl_limit_percent = models.IntegerField(default=100, db_default=100)  # % of the fixed monthly salary
    tl_allow_above_salary = models.BooleanField(default=False, db_default=False)  # may the % go above 100?
    tl_max_months = models.IntegerField(default=6, db_default=6)  # longest repayment (EMIs), at most 12
    tl_min_amount = models.IntegerField(default=1000, db_default=1000)
    tl_per_year = models.IntegerField(default=1, db_default=1)  # Term Loans approved per calendar year
    tl_min_service_months = models.IntegerField(default=6, db_default=6)
    tl_reapply_next_month = models.BooleanField(default=True, db_default=True)  # rejected: wait for the next month
    tl_one_open = models.BooleanField(default=True, db_default=True)  # one waiting or active Term Loan at a time
    updated_by = models.TextField(blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "settlement_settings"


class SettlementBatch(models.Model):
    """One run of the workflow for the requests of ONE type (Salary Advance or Term Loan, owner 2026-11-27: managed and
    followed up independently) raised in a month. A month has Batch 1, Batch 2, ... of each type: requests that arrive
    after HR forwarded a batch to the MD wait in the month's next batch of their type."""

    STAGE_HR_REVIEW = "hr_review"
    STAGE_MD_REVIEW = "md_review"
    # the MD changed amounts / rejected requests / asked for corrections: HR reworks and resubmits to the MD (2026-11-27)
    STAGE_MD_CHANGES = "md_changes"
    STAGE_HR_FINAL = "hr_final"
    STAGE_AUDITOR_SEND = "auditor_send"
    STAGE_AUDITOR_REVIEW = "auditor_review"
    # the auditor changed the settlement or asked for corrections: HR reworks it and resubmits it to the auditor
    STAGE_AUDITOR_CHANGES = "auditor_changes"
    STAGE_ACCOUNTS_SEND = "accounts_send"
    STAGE_COMPLETED = "completed"
    STAGES = [
        (STAGE_HR_REVIEW, "HR Review"),
        (STAGE_MD_REVIEW, "MD Review & Approval"),
        (STAGE_MD_CHANGES, "HR Rework (MD Changes)"),
        (STAGE_HR_FINAL, "HR Final Settlement"),
        (STAGE_AUDITOR_SEND, "Send to Auditor"),
        (STAGE_AUDITOR_REVIEW, "Auditor Review"),
        (STAGE_AUDITOR_CHANGES, "HR Rework (Auditor Changes)"),
        (STAGE_ACCOUNTS_SEND, "Send Bank File to Accounts"),
        (STAGE_COMPLETED, "Completed"),
    ]

    month = models.IntegerField()
    year = models.IntegerField()
    # Advance.advance_type of every request in it: "general" (Salary Advance) | "term" (Term Loan)
    advance_type = models.TextField(default="general", db_default="general")
    number = models.IntegerField(default=1)
    stage = models.TextField(choices=STAGES, default=STAGE_HR_REVIEW)

    forwarded_at = models.DateTimeField(null=True, blank=True)
    forwarded_by = models.TextField(blank=True, default="")
    hr_note = models.TextField(blank=True, default="")  # HR's note to the MD with the batch

    md_confirmed_at = models.DateTimeField(null=True, blank=True)
    md_confirmed_by = models.TextField(blank=True, default="")
    md_note = models.TextField(blank=True, default="")  # the MD's instructions for the whole batch
    # the re-approval cycles (owner 2026-11-27): which round of the MD's / auditor's review this is (1 = the first), and
    # the MD's latest "Return to HR for rework" with their instructions
    md_round = models.IntegerField(default=1, db_default=1)
    auditor_round = models.IntegerField(default=1, db_default=1)
    md_returned_at = models.DateTimeField(null=True, blank=True)
    md_returned_by = models.TextField(blank=True, default="", db_default="")
    md_return_note = models.TextField(blank=True, default="", db_default="")

    finalized_at = models.DateTimeField(null=True, blank=True)
    finalized_by = models.TextField(blank=True, default="")
    # who finalized it: "hr" (HR Final Settlement) | "md" (the MD sent it straight to the auditor, 2026-11-27)
    finalized_via = models.TextField(blank=True, default="", db_default="")
    final_note = models.TextField(blank=True, default="")

    auditor_sent_at = models.DateTimeField(null=True, blank=True)
    auditor_sent_by = models.TextField(blank=True, default="")
    auditor_recipients = models.JSONField(default=list, blank=True)
    auditor_confirmed_at = models.DateTimeField(null=True, blank=True)
    auditor_confirmed_by = models.TextField(blank=True, default="")
    auditor_note = models.TextField(blank=True, default="")
    # the auditor's own answer from the review portal (2026-11-27): "" | approved | changes, when, and their note
    auditor_outcome = models.TextField(blank=True, default="", db_default="")
    auditor_submitted_at = models.DateTimeField(null=True, blank=True)
    auditor_submitted_note = models.TextField(blank=True, default="", db_default="")
    # HR's review of the auditor's changes
    changes_accepted_at = models.DateTimeField(null=True, blank=True)
    changes_accepted_by = models.TextField(blank=True, default="", db_default="")
    changes_note = models.TextField(blank=True, default="", db_default="")
    # who sent the bank file to Accounts: "hr" | "auditor"
    accounts_sent_via = models.TextField(blank=True, default="", db_default="")

    accounts_sent_at = models.DateTimeField(null=True, blank=True)
    accounts_sent_by = models.TextField(blank=True, default="")
    accounts_recipients = models.JSONField(default=list, blank=True)

    completed_at = models.DateTimeField(null=True, blank=True)
    # every step as it happened: [{at, by, action, note}]
    history = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "settlement_batches"
        ordering = ["-year", "-month", "number"]
        constraints = [
            models.UniqueConstraint(
                fields=["month", "year", "advance_type", "number"], name="settlement_batch_month_type_number_uniq"
            ),
        ]


class SettlementBatchItem(models.Model):
    """One request in a batch: HR's review note, the MD's decision and HR's final settlement of it."""

    DECISION_APPROVED = "approved"
    DECISION_REJECTED = "rejected"
    DECISIONS = [(DECISION_APPROVED, "Approved"), (DECISION_REJECTED, "Rejected")]

    batch = models.ForeignKey(SettlementBatch, on_delete=models.CASCADE, related_name="items")
    advance = models.OneToOneField(Advance, on_delete=models.CASCADE, related_name="settlement_item")
    hr_note = models.TextField(blank=True, default="")
    # HR's review before the MD (2026-11-27): a proposal - "" (not reviewed yet: kept as asked) | approve (kept as asked,
    # reviewed) | reduce | reject, the reduced amount; the remark is `hr_note`. Forwarding pre-fills the MD's decision with
    # a reduce / reject; the MD accepts or changes it.
    hr_action = models.TextField(blank=True, default="", db_default="")
    hr_amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)

    # Salary Advance rounding (owner 2026-11-27): the amount asked for, capped at the eligible limit and rounded to the
    # nearest ₹500 (₹250 and up rounds up), never above the limit. Worked out while the request is at HR Review, frozen
    # at Forward; it is the workflow's "as asked" amount from then on. Null: a Term Loan, or an older batch.
    rounded_amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    rounding_limit = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)  # the limit it used

    md_decision = models.TextField(choices=DECISIONS, blank=True, default="")
    md_amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    md_remark = models.TextField(blank=True, default="")
    md_decided_at = models.DateTimeField(null=True, blank=True)

    final_decision = models.TextField(choices=DECISIONS, blank=True, default="")
    final_amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    final_start_month = models.IntegerField(null=True, blank=True)
    final_start_year = models.IntegerField(null=True, blank=True)
    final_months = models.IntegerField(null=True, blank=True)  # a Term Loan's repayment months HR settled on
    final_remark = models.TextField(blank=True, default="")
    final_changed_at = models.DateTimeField(null=True, blank=True)

    # the auditor's answer on one request in the review portal (2026-11-27): "" (not reviewed) | approve | reduce | reject,
    # the amount, the remark
    auditor_action = models.TextField(blank=True, default="", db_default="")
    auditor_amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    auditor_remark = models.TextField(blank=True, default="", db_default="")
    auditor_at = models.DateTimeField(null=True, blank=True)

    # flagged for HR's rework (2026-11-27): "" | "md" (the MD changed it / asked for a correction) | "auditor"; cleared once
    # HR answered it (accepted the change, kept or changed its own decision)
    rework = models.TextField(blank=True, default="", db_default="")
    # every earlier decision on the request, kept when a rework round replaces it: [{at, by, role, round, action,
    # amount, remark}] (role hr | md | auditor)
    trail = models.JSONField(default=list, blank=True, db_default=[])

    # the settlement was written to the advance (since 2026-11-27 once the audit is through: the auditor approved it,
    # HR accepted the auditor's changes, or HR confirmed the auditor's review by hand)
    applied = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "settlement_batch_items"
        ordering = ["id"]


class SettlementBatchFile(models.Model):
    """A file the workflow sent (the finalized report PDF / Excel to the auditor, the bank file to accounts), kept so HR
    can see and download exactly what went out."""

    KIND_REPORT_PDF = "report_pdf"
    KIND_REPORT_XLSX = "report_xlsx"
    KIND_BANK_FILE = "bank_file"
    KINDS = [(KIND_REPORT_PDF, "Report (PDF)"), (KIND_REPORT_XLSX, "Report (Excel)"), (KIND_BANK_FILE, "Bank file")]

    batch = models.ForeignKey(SettlementBatch, on_delete=models.CASCADE, related_name="files")
    kind = models.TextField(choices=KINDS)
    filename = models.TextField()
    content_type = models.TextField()
    content = models.BinaryField()
    size = models.IntegerField(default=0)
    sent_to = models.JSONField(default=list, blank=True)
    email_log_id = models.IntegerField(null=True, blank=True)
    email_status = models.TextField(blank=True, default="")
    created_by = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "settlement_batch_files"
        ordering = ["-created_at", "-id"]


class SettlementAuditorLink(models.Model):
    """The secure review link e-mailed to the auditor (2026-11-27): opens the public Auditor Review Portal without an HRMS
    login. Only a SHA-256 of the token is stored; the link expires, a new send revokes the older ones, and it turns
    read-only once the auditor submitted their answer."""

    DECISION_SEND_ACCOUNTS = "approved_send_accounts"
    DECISION_FORWARD_HR = "approved_forward_hr"
    DECISION_CHANGES = "changes_forward_hr"

    batch = models.ForeignKey(SettlementBatch, on_delete=models.CASCADE, related_name="auditor_links")
    token_hash = models.CharField(max_length=64, unique=True)
    sent_to = models.JSONField(default=list, blank=True)
    created_by = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)
    first_opened_at = models.DateTimeField(null=True, blank=True)
    last_opened_at = models.DateTimeField(null=True, blank=True)
    open_count = models.IntegerField(default=0)
    submitted_at = models.DateTimeField(null=True, blank=True)
    decision = models.TextField(blank=True, default="")

    class Meta:
        db_table = "settlement_auditor_links"
        ordering = ["-created_at", "-id"]
