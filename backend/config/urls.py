from django.urls import include, path

from api.adms_views import adms_cdata, adms_devicecmd, adms_getrequest

urlpatterns = [
    path("api/", include("api.urls")),

    # ── ZKTeco / eSSL ADMS device endpoints ──────────────────────────────
    # Hardcoded in the device firmware at these exact bare paths, NOT under
    # /api/ -see api/adms_views.py for why this is separate from the JSON
    # /api/biometric/punch push endpoint.
    #
    # Both the plain and ".aspx" spellings are registered deliberately. This
    # site's AiFace-Mars firmware ("iClock Proxy/1.09", confirmed from its
    # own requests in the Railway logs) calls the .aspx form; other ZKTeco
    # firmware calls it without. Registering only one produced a 404 on
    # every push, which the device reports as "server unreachable" with no
    # further detail -so both are accepted rather than guessing.
    path("iclock/cdata", adms_cdata),
    path("iclock/cdata.aspx", adms_cdata),
    # Command poll -must exist even though this app queues no commands; a
    # 404 here can make the device give up on the server entirely.
    path("iclock/getrequest", adms_getrequest),
    path("iclock/getrequest.aspx", adms_getrequest),
    path("iclock/devicecmd", adms_devicecmd),
    path("iclock/devicecmd.aspx", adms_devicecmd),
]
