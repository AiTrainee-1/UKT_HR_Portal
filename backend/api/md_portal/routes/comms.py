"""MD portal: Communication usage & cost routes (mounted at /api/md/comms/). Thin @md_get views over
analytics/comms.py (read-only database, MD only).

  GET overview?month=YYYY-MM&months=12
        the month's KPIs per channel (messages, failed, cost, projection, budget, change against the month before), a
        12-month series (2-24), insights and a summary sentence. Default month: this month (IST).
  GET month?month=YYYY-MM&channel=all|whatsapp|sms|email
        one month: per day, per purpose, per message type, WhatsApp pricing categories, Meta's own figure.
  GET history?channel=all|whatsapp|sms|email&month=YYYY-MM | from=YYYY-MM-DD&to=YYYY-MM-DD
              &status=sent|delivered|failed|skipped|waiting&q=&purpose=&page=1&pageSize=25
        the messages of the period, newest first (default: this month), masked contacts, status-group counts.
  GET sms-balance
        the SMS credits left on the 2Factor account (a live read, cached 5 minutes; loaded after the page).
"""

from django.urls import path

from ..analytics import comms
from ..common import MdParamError, md_get, request_params, resolve_period


def _int(params: dict, name: str, default: int) -> int:
    raw = params.get(name)
    if raw in (None, ""):
        return default
    try:
        return int(str(raw))
    except ValueError:
        raise MdParamError(f"'{name}' must be a whole number, got '{raw}'.") from None


@md_get
def overview(request):
    params = request_params(request)
    return comms.overview(params.get("month") or None, _int(params, "months", comms.MONTHS_DEFAULT))


@md_get
def month(request):
    params = request_params(request)
    return comms.month_detail(params.get("month") or None, params.get("channel") or "all")


@md_get
def history(request):
    params = request_params(request)
    return comms.history(
        resolve_period(params, default="this_month", max_days=400),
        channel=params.get("channel") or "all",
        status=params.get("status") or None,
        q=params.get("q") or "",
        purpose=params.get("purpose") or None,
        page=_int(params, "page", 1),
        page_size=_int(params, "pageSize", comms.PAGE_SIZE_DEFAULT),
    )


@md_get
def sms_balance(request):
    return comms.sms_balance()


urlpatterns = [
    path("overview", overview),
    path("month", month),
    path("history", history),
    path("sms-balance", sms_balance),
]
