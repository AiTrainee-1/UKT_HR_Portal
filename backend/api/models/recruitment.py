"""Jobs, applicants, resignations, headcount, resume screening and employee documents."""

from django.db import models

from .core import Department, Employee


# ──────────────────────────────────────────────
#  Recruitment
# ──────────────────────────────────────────────

class Job(models.Model):
    title = models.TextField()
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="department_id", related_name="jobs",
    )
    description = models.TextField(null=True, blank=True)
    requirements = models.TextField(null=True, blank=True)
    salary_range = models.TextField(null=True, blank=True, db_column="salary_range")
    status = models.TextField(default="open")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "jobs"


class Applicant(models.Model):
    job = models.ForeignKey(Job, on_delete=models.CASCADE, db_column="job_id", related_name="applicants")
    name = models.TextField()
    email = models.TextField()
    phone = models.TextField()
    cover_letter = models.TextField(null=True, blank=True, db_column="cover_letter")
    experience = models.TextField(null=True, blank=True)
    status = models.TextField(default="applied")
    interview_date = models.TextField(null=True, blank=True, db_column="interview_date")
    notes = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "applicants"


# ──────────────────────────────────────────────
#  Resignation Requests
# ──────────────────────────────────────────────

class ResignationRequest(models.Model):
    # Status flow: pending → dept_approved → approved
    #              pending → rejected (by dept head)
    #              dept_approved → rejected (by HR)
    STATUS_PENDING = "pending"
    STATUS_DEPT_APPROVED = "dept_approved"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id",
        related_name="resignation_requests",
    )
    reason = models.TextField(null=True, blank=True)
    last_working_date = models.DateField(null=True, blank=True, db_column="last_working_date")
    survey_q1_answer = models.TextField(null=True, blank=True, db_column="survey_q1_answer")
    survey_q2_answer = models.TextField(null=True, blank=True, db_column="survey_q2_answer")
    survey_q3_answer = models.TextField(null=True, blank=True, db_column="survey_q3_answer")
    status = models.TextField(default=STATUS_PENDING)
    # Dept head stage
    dept_head = models.ForeignKey(
        Employee, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="dept_head_id", related_name="resignation_reviews",
    )
    dept_head_status = models.TextField(null=True, blank=True, db_column="dept_head_status")
    dept_head_comment = models.TextField(null=True, blank=True, db_column="dept_head_comment")
    dept_head_approved_at = models.DateTimeField(null=True, blank=True, db_column="dept_head_approved_at")
    # HR stage
    hr_comment = models.TextField(null=True, blank=True, db_column="hr_comment")
    approved_by = models.TextField(null=True, blank=True, db_column="approved_by")
    approved_at = models.DateTimeField(null=True, blank=True, db_column="approved_at")
    # Track which stage rejected
    rejected_by = models.TextField(null=True, blank=True, db_column="rejected_by")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")

    class Meta:
        db_table = "resignation_requests"


# ──────────────────────────────────────────────
#  Department Headcount (Required Staffing)
# ──────────────────────────────────────────────

class DepartmentHeadcount(models.Model):
    department = models.OneToOneField(
        Department, on_delete=models.CASCADE, db_column="department_id",
        related_name="headcount",
    )
    required_count = models.IntegerField(default=0, db_column="required_count")
    notes = models.TextField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "department_headcounts"


# ──────────────────────────────────────────────
#  Resume Screening (ATS)
# ──────────────────────────────────────────────

class HiringRuleSet(models.Model):
    """
    Department-scoped hiring criteria used to score uploaded resumes.
    Multiple rule sets can exist per department (e.g. different roles within
    the same department) -HR picks one explicitly at screening time.
    """
    name = models.TextField()
    department = models.ForeignKey(
        Department, on_delete=models.CASCADE, db_column="department_id",
        related_name="hiring_rule_sets",
    )
    required_skills = models.JSONField(default=list, blank=True, db_column="required_skills")
    soft_skills = models.JSONField(default=list, blank=True, db_column="soft_skills")
    education_qualification = models.TextField(null=True, blank=True, db_column="education_qualification")
    min_experience_years = models.DecimalField(
        max_digits=4, decimal_places=1, default=0, db_column="min_experience_years",
    )
    preferred_city = models.TextField(null=True, blank=True, db_column="preferred_city")
    other_requirements = models.TextField(null=True, blank=True, db_column="other_requirements")
    is_active = models.BooleanField(default=True, db_column="is_active")
    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "hiring_rule_sets"


class ScreeningCandidate(models.Model):
    """
    One uploaded resume, its ML-extracted fields, its score against the
    HiringRuleSet it was screened with, and its place in the
    shortlist -> selected/rejected pipeline.
    """
    # rule_set is PROTECTed: a candidate row must survive rule-set edits or
    # deactivation for audit purposes -deleting a rule set with candidates
    # attached is blocked at the view layer instead.
    rule_set = models.ForeignKey(
        HiringRuleSet, on_delete=models.PROTECT, db_column="rule_set_id",
        related_name="candidates",
    )
    # Denormalized copy of rule_set.department at screening time, so
    # historical records stay meaningful even if the rule set's department
    # is later changed.
    department = models.ForeignKey(
        Department, on_delete=models.SET_NULL, null=True, blank=True,
        db_column="department_id", related_name="screening_candidates",
    )
    resume_file = models.FileField(upload_to="resumes/%Y/%m/", db_column="resume_file")
    original_filename = models.TextField(db_column="original_filename")
    source = models.TextField(default="single", db_column="source")  # "single" | "bulk"

    # Extracted fields
    candidate_name = models.TextField(null=True, blank=True, db_column="candidate_name")
    email = models.TextField(null=True, blank=True, db_column="email")
    phone = models.TextField(null=True, blank=True, db_column="phone")
    city = models.TextField(null=True, blank=True, db_column="city")
    extracted_skills = models.JSONField(default=list, blank=True, db_column="extracted_skills")
    extracted_soft_skills = models.JSONField(default=list, blank=True, db_column="extracted_soft_skills")
    extracted_experience_years = models.DecimalField(
        max_digits=4, decimal_places=1, null=True, blank=True, db_column="extracted_experience_years",
    )
    extracted_education = models.TextField(null=True, blank=True, db_column="extracted_education")
    raw_text_excerpt = models.TextField(null=True, blank=True, db_column="raw_text_excerpt")

    # Scoring
    match_score = models.DecimalField(
        max_digits=5, decimal_places=2, null=True, blank=True, db_column="match_score",
    )
    score_breakdown = models.JSONField(null=True, blank=True, db_column="score_breakdown")
    rank_in_batch = models.IntegerField(null=True, blank=True, db_column="rank_in_batch")

    # Pipeline status: uploaded -> screened -> shortlisted/not_shortlisted
    #                  -> selected -> rejected  (shortlisted -> rejected direct too)
    status = models.TextField(default="uploaded", db_column="status")

    screened_at = models.DateTimeField(null=True, blank=True, db_column="screened_at")
    interview_invited_at = models.DateTimeField(null=True, blank=True, db_column="interview_invited_at")
    interview_datetime = models.DateTimeField(null=True, blank=True, db_column="interview_datetime")
    rejection_emailed_at = models.DateTimeField(null=True, blank=True, db_column="rejection_emailed_at")
    notes = models.TextField(null=True, blank=True, db_column="notes")

    created_at = models.DateTimeField(auto_now_add=True, db_column="created_at")
    updated_at = models.DateTimeField(auto_now=True, db_column="updated_at")

    class Meta:
        db_table = "screening_candidates"


# ──────────────────────────────────────────────
#  Employee Documents
# ──────────────────────────────────────────────

class EmployeeDocument(models.Model):
    """
    One uploaded file (image or PDF) attached to an employee -PAN/Aadhaar/
    educational certs/etc., plus scanned copies of Offer/Experience/
    Resignation/Staff letters. Distinct from the on-demand PDF *generators*
    in company_documents_views.py (those synthesize a letter from Employee
    data; this stores whatever HR actually uploads). Multiple files per
    category are allowed (e.g. several educational certificates) -no
    "replace" semantics, HR deletes individually.
    """
    CATEGORY_PAN = "pan_card"
    CATEGORY_AADHAAR = "aadhaar_card"
    CATEGORY_EDUCATION = "educational_certificate"
    CATEGORY_VOTER_BIRTH = "voter_id_or_birth_certificate"
    CATEGORY_BANK_PASSBOOK = "bank_passbook"
    CATEGORY_OFFER_LETTER = "offer_letter"
    CATEGORY_EXPERIENCE_LETTER = "experience_letter"
    CATEGORY_RESIGNATION_LETTER = "resignation_letter"
    CATEGORY_STAFF_LETTER = "staff_letter"
    CATEGORY_PRODUCTION_DOCS = "production_employee_documents"
    CATEGORY_CHOICES = [
        (CATEGORY_PAN, "PAN Card"),
        (CATEGORY_AADHAAR, "Aadhaar Card"),
        (CATEGORY_EDUCATION, "Educational Certificates"),
        (CATEGORY_VOTER_BIRTH, "Voter ID or Birth Certificate"),
        (CATEGORY_BANK_PASSBOOK, "Bank Passbook"),
        (CATEGORY_OFFER_LETTER, "Offer Letter"),
        (CATEGORY_EXPERIENCE_LETTER, "Experience Letter"),
        (CATEGORY_RESIGNATION_LETTER, "Resignation Letter"),
        (CATEGORY_STAFF_LETTER, "Staff Letter"),
        (CATEGORY_PRODUCTION_DOCS, "Production Employee Documents"),
    ]

    employee = models.ForeignKey(
        Employee, on_delete=models.CASCADE, db_column="employee_id", related_name="documents",
    )
    category = models.TextField(choices=CATEGORY_CHOICES, db_column="category")
    file = models.FileField(upload_to="employee_documents/%Y/%m/", db_column="file")
    original_filename = models.TextField(db_column="original_filename")
    uploaded_by = models.TextField(null=True, blank=True, db_column="uploaded_by")
    uploaded_at = models.DateTimeField(auto_now_add=True, db_column="uploaded_at")

    class Meta:
        db_table = "employee_documents"
        ordering = ["-uploaded_at"]
