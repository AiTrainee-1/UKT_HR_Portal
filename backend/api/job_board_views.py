"""Job postings and applicants (public job-apply flow)."""

from .auth import require_hr
from .models import Applicant, Job
from .serializers import applicant_json, job_json
from .view_common import _error
from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response


# --- Jobs ---


def _job_with_meta(job: Job) -> dict:
    dept_name = job.department.name if job.department_id else None
    applicant_count = Applicant.objects.filter(job_id=job.id).count()
    return job_json(job, dept_name, applicant_count)


@api_view(["GET", "POST"])
def jobs(request: Request) -> Response:
    if request.method == "GET":
        jobs_qs = Job.objects.select_related("department").order_by("id")
        return Response([_job_with_meta(j) for j in jobs_qs])
    return require_hr(_jobs_create)(request)


def _jobs_create(request: Request) -> Response:
    data = request.data
    job = Job.objects.create(
        title=data.get("title"),
        department_id=data.get("departmentId"),
        description=data.get("description"),
        requirements=data.get("requirements"),
        salary_range=data.get("salaryRange"),
        status=data.get("status", "open"),
    )
    job = Job.objects.select_related("department").get(pk=job.pk)
    return Response(_job_with_meta(job), status=201)


@api_view(["GET", "PATCH", "DELETE"])
def job_detail(request: Request, pk: int) -> Response:
    if request.method == "GET":
        job = Job.objects.select_related("department").filter(pk=pk).first()
        if not job:
            return _error("Job not found", 404)
        return Response(_job_with_meta(job))
    if request.method == "DELETE":
        return require_hr(_jobs_delete)(request, pk)
    return require_hr(_jobs_update)(request, pk)


def _jobs_update(request: Request, pk: int) -> Response:
    job = Job.objects.select_related("department").filter(pk=pk).first()
    if not job:
        return _error("Not found", 404)
    for key, attr in [
        ("title", "title"),
        ("departmentId", "department_id"),
        ("description", "description"),
        ("requirements", "requirements"),
        ("salaryRange", "salary_range"),
        ("status", "status"),
    ]:
        if key in request.data:
            setattr(job, attr, request.data[key])
    job.save()
    return Response(_job_with_meta(job))


def _jobs_delete(_request: Request, pk: int) -> Response:
    Job.objects.filter(id=pk).delete()
    return Response({"message": "Job deleted"})


# --- Applicants ---


def _applicant_with_title(applicant: Applicant) -> dict:
    job = Job.objects.filter(id=applicant.job_id).first()
    return applicant_json(applicant, job.title if job else None)


@api_view(["GET", "POST"])
def applicants(request: Request) -> Response:
    if request.method == "GET":
        return require_hr(_applicants_list)(request)
    return _applicants_submit(request)


def _applicants_list(request: Request) -> Response:
    qs = Applicant.objects.select_related("job").order_by("-id")
    job_id = request.query_params.get("jobId")
    applicant_status = request.query_params.get("status")
    if job_id:
        qs = qs.filter(job_id=int(job_id))
    if applicant_status:
        qs = qs.filter(status=applicant_status)
    return Response([_applicant_with_title(a) for a in qs])


def _applicants_submit(request: Request) -> Response:
    data = request.data
    job_id = data.get("jobId")
    if not job_id:
        return _error("jobId is required", 400)
    job = Job.objects.filter(pk=job_id).first()
    if not job:
        return _error("Job not found", 404)
    if job.status != "open":
        return _error("This position is no longer accepting applications", 400)
    if not data.get("name") or not data.get("email") or not data.get("phone"):
        return _error("Name, email, and phone are required", 400)
    applicant = Applicant.objects.create(
        job_id=job_id,
        name=data.get("name"),
        email=data.get("email"),
        phone=data.get("phone"),
        cover_letter=data.get("coverLetter"),
        experience=data.get("experience"),
    )
    return Response(_applicant_with_title(applicant), status=201)


@api_view(["PATCH"])
@require_hr
def update_applicant_status(request: Request, pk: int) -> Response:
    applicant = Applicant.objects.filter(pk=pk).first()
    if not applicant:
        return _error("Not found", 404)
    applicant.status = request.data.get("status", applicant.status)
    if "interviewDate" in request.data:
        applicant.interview_date = request.data["interviewDate"]
    if "notes" in request.data:
        applicant.notes = request.data["notes"]
    applicant.save()
    return Response(_applicant_with_title(applicant))
