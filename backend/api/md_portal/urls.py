"""URL table of the MD portal, mounted at /api/md/ (api/urls.py). Every view here MUST carry @require_md:
tests_md_identity walks this table and fails if one answers anyone but the MD."""

from django.urls import include, path

from . import views

urlpatterns = [
    path("me", views.md_me),
    path("org", views.md_org),
    path("dashboard/", include("api.md_portal.routes.dashboard")),
    path("attendance/", include("api.md_portal.routes.attendance")),
    path("employees/", include("api.md_portal.routes.employees")),
    path("visitors/", include("api.md_portal.routes.visitors")),
    path("tea-break/", include("api.md_portal.routes.tea_break")),
    path("payroll/", include("api.md_portal.routes.payroll")),
    path("recruitment/", include("api.md_portal.routes.recruitment")),
    path("activity/", include("api.md_portal.routes.activity")),
    path("assistant/", include("api.md_portal.assistant.urls")),
]
