from django.urls import include, path

from api.adms_views import adms_cdata

urlpatterns = [
    path("api/", include("api.urls")),
    # ZKTeco ADMS-mode devices are hardcoded to this bare path, not
    # namespaced under /api/ -see api/adms_views.py for why this exists
    # separately from the JSON /api/biometric/punch push endpoint.
    path("iclock/cdata", adms_cdata),
]
