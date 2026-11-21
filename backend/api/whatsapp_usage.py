"""
WhatsApp Control -> Overview and Usage & Cost (2026-11-20): how much WhatsApp is used, what it costs, and what needs
HR's attention. It reads the message log (WhatsAppMessageLog), the settings and the local template mirror; the only
calls to Meta are the number's state (whatsapp_service.phone_status, cached 5 minutes) and Meta's own cost figures
(pricing analytics, cached 10 minutes). Nothing here sends a message.

Pricing (Meta charges per delivered template message, by pricing category; India rates before 18% GST):

    DEFAULT_RATES   authentication 0.1150, utility 0.1150, marketing 0.8631, service 0 (rupees). HR overrides any of them
                    (WhatsAppSettings.price_rates) on WhatsApp Control -> Settings.
    A message's category   its pricing_category from Meta's webhook, else (a one-time code) authentication, else its
                    template's category (WhatsAppTemplate), else the catalog's meta_category, lowercased.
    Billable        what the webhook said (billable), else every message Meta accepted (sent / delivered / read) that is
                    not a free service message. A message that never went through Meta (no template name and no pricing
                    from the webhook: sent before the 2026-11-20 switch) is counted but never charged.
    Cost so far     billable messages x their category's rate, this month (IST).
    Projected       this month: cost so far / days elapsed (today included) x days in the month; a past month: its
                    actual total; a future month: 0. "+ 18% GST" figures are given next to each.
    Budget          WhatsAppSettings.monthly_budget (rupees, compared with the cost BEFORE GST); budgetUsedPct = cost so
                    far / budget x 100.

Counts: sent = accepted by Meta (sent + delivered + read); delivered = the ones whose latest status is delivered (not
read yet); read = read. deliveryRate = (delivered + read) / sent and readRate = read / sent, as fractions 0..1.

    parse_month(text) -> date                   "YYYY-MM" -> its first day (ValueError when it is not one)
    rates(s) -> {category: Decimal}
    category_of(document_type, pricing_category, template_name, template_categories) -> str
    usage(qs, month_start, s=None, now=None, with_meta=True) -> dict    GET usage (contract keys)
    month_counts(qs, month_start, now=None) -> dict                     overview.month
    meta_pricing(month_start, now=None) -> dict                         Meta's own figures, or why not
    overview(qs, s=None, now=None) -> dict                              GET overview (contract keys)
"""

from __future__ import annotations

import calendar
import logging
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.core.cache import cache
from django.db.models import Count
from django.db.models.functions import TruncDate
from django.utils import timezone

from . import whatsapp_catalog as catalog
from . import whatsapp_cloud as cloud
from . import whatsapp_dispatcher, whatsapp_service, whatsapp_templates
from .clock import FACTORY_TZ

logger = logging.getLogger(__name__)

CURRENCY = "INR"
CATEGORIES = ("authentication", "utility", "marketing", "service")
DEFAULT_RATES = {
    "authentication": Decimal("0.1150"),
    "utility": Decimal("0.1150"),
    "marketing": Decimal("0.8631"),
    "service": Decimal("0"),
}
GST_RATE = Decimal("0.18")
MAX_RATE = Decimal("100")

ACCEPTED = ("sent", "delivered", "read")
WAITING = ("queued", "sending", "pending")

META_CACHE_SECONDS = 600
META_ERROR_CACHE_SECONDS = 60

# Meta's messaging limit: how many different people the number may start conversations with in a rolling 24 hours.
TIER_LIMITS = {
    "TIER_50": 50,
    "TIER_250": 250,
    "TIER_1K": 1000,
    "TIER_2K": 2000,
    "TIER_10K": 10000,
    "TIER_100K": 100000,
    "TIER_UNLIMITED": None,
}
TIER_WARN_SHARE = Decimal("0.8")
BUDGET_WARN_SHARE = Decimal("0.8")
WEBHOOK_STALE = timedelta(days=2)

_CENT = Decimal("0.01")


def _money(value: Decimal) -> float:
    return float(Decimal(value).quantize(_CENT, rounding=ROUND_HALF_UP))


def _rate_out(value: Decimal) -> float:
    return float(Decimal(value).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def _fraction(part: int, whole: int) -> float | None:
    return round(part / whole, 4) if whole else None


def _now(now=None) -> datetime:
    return now or timezone.now()


def _today(now=None) -> date:
    return _now(now).astimezone(FACTORY_TZ).date()


def _settings(s=None):
    if s is not None:
        return s
    from .models import WhatsAppSettings

    return WhatsAppSettings.get()


# ── months ──────────────────────────────────────────────────────────────────────────


def parse_month(text: str | None, now=None) -> date:
    """'YYYY-MM' -> the first day of that month; blank -> this month (IST). ValueError otherwise."""
    if not text:
        return _today(now).replace(day=1)
    text = str(text).strip()
    if len(text) != 7 or text[4] != "-":
        raise ValueError("month must be YYYY-MM")
    year, month = int(text[:4]), int(text[5:])
    if not 2000 <= year <= 2100 or not 1 <= month <= 12:
        raise ValueError("month must be YYYY-MM")
    return date(year, month, 1)


def _month_end(month_start: date) -> date:
    return month_start.replace(day=calendar.monthrange(month_start.year, month_start.month)[1])


def _bounds(month_start: date) -> tuple[datetime, datetime]:
    """[start, end) of the month in IST, as aware datetimes."""
    start = datetime.combine(month_start, datetime.min.time(), tzinfo=FACTORY_TZ)
    end = datetime.combine(_month_end(month_start) + timedelta(days=1), datetime.min.time(), tzinfo=FACTORY_TZ)
    return start, end


# ── prices and categories ───────────────────────────────────────────────────────────


def rates(s=None) -> dict[str, Decimal]:
    """The price per billable message of each category: HR's (WhatsAppSettings.price_rates) over the defaults."""
    s = _settings(s)
    out = dict(DEFAULT_RATES)
    for key, value in (s.price_rates or {}).items():
        if key in out and value is not None:
            try:
                rate = Decimal(str(value))
            except (ArithmeticError, ValueError):
                continue
            if Decimal("0") <= rate <= MAX_RATE:
                out[key] = rate
    return out


def rates_json(s=None) -> dict[str, float]:
    return {k: _rate_out(v) for k, v in rates(s).items()}


def normalise_category(value) -> str | None:
    """Meta's pricing category in one of CATEGORIES (authentication_international -> authentication, marketing_lite ->
    marketing, referral_conversion -> service), or None."""
    text = str(value or "").strip().lower()
    if not text:
        return None
    for c in CATEGORIES:
        if text.startswith(c):
            return c
    if text in ("referral_conversion", "free_entry_point", "free_customer_service"):
        return "service"
    return None


def category_of(document_type: str, pricing_category: str, template_name: str, template_categories: dict) -> str:
    found = normalise_category(pricing_category)
    if found:
        return found
    spec = catalog.get(document_type)
    if whatsapp_templates.is_code_type(spec):
        return "authentication"
    found = normalise_category(template_categories.get(template_name or ""))
    if found:
        return found
    if spec is not None:
        return normalise_category(spec.meta_category) or "utility"
    return "utility"


def _template_categories() -> dict[str, str]:
    from .models import WhatsAppTemplate

    out: dict[str, str] = {}
    for name, category in WhatsAppTemplate.objects.values_list("name", "category"):
        out.setdefault(name, category)
    return out


# ── usage ───────────────────────────────────────────────────────────────────────────


def _empty_counts() -> dict:
    return {"sent": 0, "delivered": 0, "read": 0, "failed": 0, "skipped": 0, "expired": 0, "queued": 0, "billable": 0}


def _rows(qs, month_start: date):
    start, end = _bounds(month_start)
    return (
        qs.filter(created_at__gte=start, created_at__lt=end)
        .order_by()
        .annotate(day=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("day", "document_type", "status", "pricing_category", "billable", "template_name")
        .annotate(n=Count("id"))
    )


def _count_into(counts: dict, status: str, n: int, billable: bool) -> None:
    if status in ACCEPTED:
        counts["sent"] += n
        if status == "delivered":
            counts["delivered"] += n
        elif status == "read":
            counts["read"] += n
    elif status == "failed":
        counts["failed"] += n
    elif status == "skipped":
        counts["skipped"] += n
    elif status == "expired":
        counts["expired"] += n
    elif status in WAITING:
        counts["queued"] += n
    if billable:
        counts["billable"] += n


def _cost(month_start: date, so_far: Decimal, s, now=None) -> dict:
    today = _today(now)
    this_month = today.replace(day=1)
    days_in_month = calendar.monthrange(month_start.year, month_start.month)[1]
    if month_start == this_month:
        elapsed = today.day
        projected = so_far / elapsed * days_in_month if elapsed else so_far
    elif month_start < this_month:
        elapsed = days_in_month
        projected = so_far
    else:
        elapsed = 0
        projected = Decimal("0")
    budget = s.monthly_budget
    used = None
    projected_pct = None
    if budget is not None and budget > 0:
        used = round(float(so_far / budget * 100), 1)
        projected_pct = round(float(projected / budget * 100), 1)
    gst = Decimal("1") + GST_RATE
    return {
        "soFar": _money(so_far),
        "soFarWithGst": _money(so_far * gst),
        "projected": _money(projected),
        "projectedWithGst": _money(projected * gst),
        "gstRate": float(GST_RATE),
        "budget": float(budget) if budget is not None else None,
        "budgetUsedPct": used,
        "projectedBudgetPct": projected_pct,
        "budgetIncludesGst": False,
        "currency": CURRENCY,
        "isCurrentMonth": month_start == this_month,
        "daysElapsed": elapsed,
        "daysInMonth": days_in_month,
    }


def _tally(qs, month_start: date, s):
    """One pass over the month's log rows: per day, per category, per type, totals and the cost."""
    price = rates(s)
    template_categories = _template_categories()
    days: dict[date, dict] = {}
    by_category = {c: {"messages": 0, "billable": 0, "cost": Decimal("0")} for c in CATEGORIES}
    by_type: dict[str, dict] = {}
    totals = _empty_counts()
    so_far = Decimal("0")
    for r in _rows(qs, month_start):
        n, status = r["n"], r["status"]
        category = category_of(r["document_type"], r["pricing_category"], r["template_name"], template_categories)
        accepted = status in ACCEPTED
        # A row with neither a template nor Meta's pricing never went through Meta (sent before 2026-11-20): counted,
        # never charged.
        via_meta = bool(r["template_name"] or r["pricing_category"])
        if r["billable"] is not None:
            billable = bool(r["billable"])
        else:
            billable = accepted and via_meta and category != "service"
        cost = price[category] * n if billable else Decimal("0")
        so_far += cost
        _count_into(totals, status, n, billable)
        day = days.setdefault(r["day"], {**_empty_counts(), "byCategory": {c: 0 for c in CATEGORIES}})
        _count_into(day, status, n, billable)
        if accepted:
            day["byCategory"][category] += n
            by_category[category]["messages"] += n
        if billable:
            by_category[category]["billable"] += n
            by_category[category]["cost"] += cost
        t = by_type.setdefault(
            r["document_type"], {"messages": 0, "billable": 0, "failed": 0, "cost": Decimal("0"), "categories": set()}
        )
        if accepted:
            t["messages"] += n
            t["categories"].add(category)
        if status == "failed":
            t["failed"] += n
        if billable:
            t["billable"] += n
            t["cost"] += cost
    return days, by_category, by_type, totals, so_far, price


def month_counts(qs, month_start: date | None = None, now=None) -> dict:
    """This month's message counts (overview.month)."""
    month_start = month_start or _today(now).replace(day=1)
    totals = _empty_counts()
    start, end = _bounds(month_start)
    for row in qs.filter(created_at__gte=start, created_at__lt=end).order_by().values("status").annotate(n=Count("id")):
        _count_into(totals, row["status"], row["n"], False)
    totals.pop("billable")
    totals["deliveryRate"] = _fraction(totals["delivered"] + totals["read"], totals["sent"])
    totals["readRate"] = _fraction(totals["read"], totals["sent"])
    return totals


def usage(qs, month_start: date, s=None, now=None, with_meta: bool = True) -> dict:
    """GET /api/whatsapp-control/usage?month=YYYY-MM (see the module docstring)."""
    s = _settings(s)
    days, by_category, by_type, totals, so_far, price = _tally(qs, month_start, s)
    today = _today(now)
    last = _month_end(month_start)
    if month_start > today:
        day_list = []
    else:
        last = min(last, today)
        day_list = [month_start + timedelta(days=i) for i in range((last - month_start).days + 1)]
    empty = {**_empty_counts(), "byCategory": {c: 0 for c in CATEGORIES}}
    types = []
    for key, t in sorted(by_type.items(), key=lambda kv: (-kv[1]["messages"], kv[0])):
        spec = catalog.get(key)
        types.append(
            {
                "type": key,
                "label": spec.label if spec else key,
                "module": spec.module if spec else "other",
                "moduleLabel": catalog.MODULES.get(spec.module if spec else "other", "Other"),
                "messages": t["messages"],
                "billable": t["billable"],
                "failed": t["failed"],
                "categories": sorted(t["categories"]),
                "cost": _money(t["cost"]),
            }
        )
    result = {
        "month": f"{month_start:%Y-%m}",
        "days": [
            {
                "date": d.isoformat(),
                **{k: v for k, v in days.get(d, empty).items() if k != "byCategory"},
                "byCategory": dict(days.get(d, empty)["byCategory"]),
            }
            for d in day_list
        ],
        "totals": totals,
        "byCategory": {
            c: {
                "messages": v["messages"],
                "billable": v["billable"],
                "rate": _rate_out(price[c]),
                "cost": _money(v["cost"]),
            }
            for c, v in by_category.items()
        },
        "byType": types,
        "cost": _cost(month_start, so_far, s, now),
        "rates": {k: _rate_out(v) for k, v in price.items()},
        "defaultRates": {k: _rate_out(v) for k, v in DEFAULT_RATES.items()},
        "meta": meta_pricing(month_start, now) if with_meta else _meta_unavailable(None),
    }
    totals["deliveryRate"] = _fraction(totals["delivered"] + totals["read"], totals["sent"])
    totals["readRate"] = _fraction(totals["read"], totals["sent"])
    return result


# ── Meta's own figures ──────────────────────────────────────────────────────────────


def _meta_unavailable(error: str | None) -> dict:
    return {"available": False, "cost": None, "volume": None, "byCategory": {}, "lastSyncedAt": None, "error": error}


def meta_pricing(month_start: date, now=None) -> dict:
    """Meta's pricing analytics for the month (what Meta itself counts and charges), cached 10 minutes. Never raises:
    when Meta can't say, {available: False, error: why}."""
    today = _today(now)
    if month_start > today:
        return _meta_unavailable(None)
    if not cloud.is_configured():
        return _meta_unavailable(
            "Meta figures unavailable: WhatsApp (Meta Cloud API) is not configured on this server."
        )
    key = f"whatsapp_usage:meta_pricing:{month_start:%Y-%m}"
    cached = cache.get(key)
    if cached is not None:
        return cached
    end = min(_month_end(month_start), today)
    try:
        points = cloud.pricing_analytics(month_start, end)
    except cloud.MetaApiError as exc:
        result = _meta_unavailable(f"Meta figures unavailable: {exc}")
        cache.set(key, result, META_ERROR_CACHE_SECONDS)
        return result
    except Exception:  # an answer of an unexpected shape must never break the page
        logger.exception("WhatsApp pricing analytics could not be read")
        result = _meta_unavailable("Meta figures unavailable: Meta's answer could not be read.")
        cache.set(key, result, META_ERROR_CACHE_SECONDS)
        return result
    cost = Decimal("0")
    volume = 0
    by_category: dict[str, dict] = {}
    for p in points:
        c = normalise_category(p.get("pricing_category")) or (p.get("pricing_category") or "other")
        point_cost = Decimal(str(p.get("cost") or 0))
        point_volume = int(p.get("volume") or 0)
        cost += point_cost
        volume += point_volume
        row = by_category.setdefault(c, {"volume": 0, "cost": Decimal("0")})
        row["volume"] += point_volume
        row["cost"] += point_cost
    result = {
        "available": True,
        "cost": _money(cost),
        "volume": volume,
        "byCategory": {c: {"volume": v["volume"], "cost": _money(v["cost"])} for c, v in by_category.items()},
        "lastSyncedAt": _now(now).isoformat(),
        "error": None,
    }
    cache.set(key, result, META_CACHE_SECONDS)
    return result


# ── overview ────────────────────────────────────────────────────────────────────────


def _unique_recipients_24h(now=None) -> int:
    from .models import WhatsAppMessageLog

    since = _now(now) - timedelta(hours=24)
    return (
        WhatsAppMessageLog.objects.filter(sent_at__gte=since, status__in=ACCEPTED)
        .exclude(phone_number="")
        .values("phone_number")
        .distinct()
        .count()
    )


def connection_summary(s, status: dict | None, queue: dict, now=None) -> dict:
    configured = cloud.is_configured()
    block = whatsapp_service.sending_block_reason()
    reasons: list[str] = []
    if not configured:
        reasons.append(whatsapp_templates.not_configured_message())
    elif block:
        reasons.append(block)
    if status is not None and configured and not status.get("ok"):
        if status.get("tokenOk") is False:
            reasons.append(f"Meta refused the access token: {status.get('error')}")
        else:
            reasons.append(f"Meta did not answer the number check: {status.get('error')}")
    if not s.engine_enabled:
        reasons.append("The master switch is OFF (Message Controls): no WhatsApp message is sent, codes included.")
    if queue.get("paused"):
        reasons.append(f"Sending is paused: {queue.get('pausedReason')}")
    phone = (status or {}).get("phone") or {}
    tier = phone.get("messagingLimitTier")
    return {
        "configured": configured,
        "sendingAllowed": whatsapp_service.sending_allowed(),
        "blockReasons": reasons,
        "qualityRating": phone.get("qualityRating"),
        "messagingLimitTier": tier,
        "tierLimit": TIER_LIMITS.get(str(tier or "").upper()),
        "uniqueRecipients24h": _unique_recipients_24h(now),
        "displayNumber": phone.get("displayPhoneNumber"),
        "verifiedName": phone.get("verifiedName"),
        "status": phone.get("status"),
        "nameStatus": phone.get("nameStatus"),
        "throughput": phone.get("throughput"),
        "tokenOk": (status or {}).get("tokenOk"),
        "error": (status or {}).get("error") if status and not status.get("ok") else None,
        "checkedAt": (status or {}).get("checkedAt"),
        "lastWebhookAt": s.last_webhook_at.isoformat() if s.last_webhook_at else None,
        "apiVersion": cloud.api_version(),
    }


def templates_summary(s) -> dict:
    from .models import WhatsAppTemplate

    counts: dict[str, int] = {}
    for status, n in WhatsAppTemplate.objects.values_list("status").annotate(n=Count("id")):
        counts[str(status or "").upper()] = counts.get(str(status or "").upper(), 0) + n
    return {
        "approved": counts.get("APPROVED", 0),
        "pending": sum(counts.get(k, 0) for k in whatsapp_templates.IN_REVIEW),
        "rejected": counts.get("REJECTED", 0),
        "paused": counts.get("PAUSED", 0) + counts.get("DISABLED", 0),
        "total": sum(n for k, n in counts.items() if k != "DELETED"),
        "missingForEnabledTypes": whatsapp_templates.missing_for_enabled_types(s),
    }


def otp_summary(qs, s, month_start: date) -> dict:
    """WhatsApp codes: the master switch, whether a code can go out now, the code template, and this month's codes."""
    from . import otp_service

    status = None
    try:
        status = otp_service.channel_status(otp_service.CHANNEL_WHATSAPP)
    except Exception:  # the OTP module is the authority; a failure there must not break the overview
        logger.exception("WhatsApp OTP status could not be read")
    choice = whatsapp_service.template_for("otp_login", s)
    if status is None:
        status = {
            "enabled": bool(s.otp_enabled),
            "available": bool(
                s.otp_enabled
                and s.engine_enabled
                and whatsapp_service.is_configured()
                and choice.problem is None
                and (s.otp_login_enabled or s.otp_reset_enabled or s.otp_activate_enabled)
            ),
            "purposes": {},
            "problems": {},
            "templateName": choice.name,
            "templateStatus": choice.status,
        }
    template_minutes = None
    if choice.row is not None and str(choice.category).upper() == whatsapp_templates.AUTHENTICATION:
        footer = choice._component("FOOTER")
        template_minutes = footer.get("code_expiration_minutes")
    start, end = _bounds(month_start)
    codes = qs.filter(created_at__gte=start, created_at__lt=end, document_type__in=catalog.types_in("otp"))
    agg = {row["status"]: row["n"] for row in codes.order_by().values("status").annotate(n=Count("id"))}
    verified = None
    try:
        verified = (
            otp_service.verified_codes(otp_service.CHANNEL_WHATSAPP)
            .filter(consumed_at__gte=start, consumed_at__lt=end)
            .count()
        )
    except Exception:
        logger.exception("Verified WhatsApp codes could not be counted")
    return {
        "enabled": bool(s.otp_enabled),
        "available": bool(status.get("available")),
        "purposes": status.get("purposes") or {},
        "problems": status.get("problems") or {},
        "templateName": status.get("templateName") or choice.name,
        "templateStatus": status.get("templateStatus") or (None if choice.status == "MISSING" else choice.status),
        "expiryMinutes": int(s.otp_expiry_minutes),
        "templateExpiryMinutes": template_minutes,
        # set up but held at this moment (Meta's account pause, failures at Meta, a code limit used up): password
        # sign-in stays open meanwhile (otp_service)
        "paused": bool(status.get("paused")),
        "pauseReason": status.get("pauseReason"),
        # {perEmployeePerDay, perNumberPerHour, hourlyCap, dailyCap, hourUsed, dayUsed}
        "limits": status.get("limits"),
        "month": {
            "sent": sum(agg.get(k, 0) for k in ACCEPTED),
            "delivered": agg.get("delivered", 0) + agg.get("read", 0),
            "failed": agg.get("failed", 0),
            "verified": verified,
        },
    }


def _alert(level: str, code: str, message: str) -> dict:
    return {"level": level, "code": code, "message": message}


def alerts(s, connection: dict, month: dict, cost: dict, templates: dict, otp: dict, queue: dict, now=None) -> list:
    """What needs HR's attention, most serious first: {level: error | warning | info, code, message}."""
    from .models import WhatsAppTemplate

    out: list[dict] = []
    configured = connection["configured"]
    if not configured:
        out.append(_alert("error", "not_configured", whatsapp_templates.not_configured_message()))
    else:
        block = whatsapp_service.sending_block_reason()
        if block:
            out.append(_alert("warning", "sending_blocked", block))
        if connection.get("tokenOk") is False:
            out.append(_alert("error", "token_invalid", f"Meta refused the access token: {connection.get('error')}"))
        elif connection.get("error"):
            out.append(_alert("warning", "meta_unreachable", f"Meta did not answer: {connection.get('error')}"))
    if not s.engine_enabled:
        out.append(
            _alert("warning", "engine_off", "The master switch is OFF: no WhatsApp message is sent, codes included.")
        )
    if queue.get("paused"):
        out.append(_alert("error", "queue_paused", f"Sending is paused: {queue.get('pausedReason')}"))

    number_status = str(connection.get("status") or "").upper()
    if number_status and number_status != "CONNECTED":
        out.append(
            _alert(
                "warning",
                "number_status",
                f"Meta reports the number as {number_status.lower()}: check WhatsApp Manager -> Phone numbers.",
            )
        )
    quality = str(connection.get("qualityRating") or "").upper()
    if quality == "RED":
        out.append(
            _alert(
                "error",
                "quality_red",
                "The number's quality rating is LOW (red): Meta may lower its messaging limit or restrict it. Send "
                "fewer automatic messages and check which templates people block.",
            )
        )
    elif quality == "YELLOW":
        out.append(
            _alert(
                "warning",
                "quality_yellow",
                "The number's quality rating dropped to MEDIUM (yellow): keep messages useful and few.",
            )
        )
    limit = connection.get("tierLimit")
    unique = connection.get("uniqueRecipients24h") or 0
    if limit and unique >= limit * TIER_WARN_SHARE:
        out.append(
            _alert(
                "warning",
                "tier_near_limit",
                f"{unique} different people were messaged in the last 24 hours, near the number's limit of {limit}.",
            )
        )

    uses = whatsapp_templates.uses_map(s)
    enabled = {k for k in catalog.TYPES if whatsapp_templates.type_switched_on(k, s)}
    for row in WhatsAppTemplate.objects.filter(status__in=("REJECTED", "PAUSED", "DISABLED")).order_by("name"):
        hit = [catalog.label(t) for t in uses.get(row.name, []) if t in enabled]
        if not hit:
            continue
        status = row.status.upper()
        why = f" ({row.rejected_reason})" if status == "REJECTED" and row.rejected_reason else ""
        verb = {"REJECTED": "rejected", "PAUSED": "paused", "DISABLED": "disabled"}[status]
        out.append(
            _alert(
                "error",
                f"template_{verb}",
                f"Meta {verb} {row.name}{why}: {', '.join(hit)} {'is' if len(hit) == 1 else 'are'} skipped.",
            )
        )
    missing = [m for m in templates.get("missingForEnabledTypes", []) if m["status"] in ("MISSING", "DELETED", "DRAFT")]
    if missing:
        names = ", ".join(m["label"] for m in missing[:6]) + (
            f" and {len(missing) - 6} more" if len(missing) > 6 else ""
        )
        out.append(
            _alert(
                "warning",
                "templates_missing",
                f"{len(missing)} switched-on message type{'s have' if len(missing) != 1 else ' has'} no template yet "
                f"and {'are' if len(missing) != 1 else 'is'} skipped: {names}. Create them on Templates.",
            )
        )
    if templates.get("pending"):
        n = templates["pending"]
        out.append(
            _alert(
                "info", "templates_pending", f"{n} template{'s are' if n != 1 else ' is'} waiting for Meta's review."
            )
        )
    for row in WhatsAppTemplate.objects.filter(status="APPROVED", quality_score__in=("RED", "YELLOW")).order_by("name"):
        level = "warning" if row.quality_score == "RED" else "info"
        word = "low" if row.quality_score == "RED" else "medium"
        out.append(
            _alert(
                level,
                "template_quality",
                f"{row.name} has {word} quality at Meta: people are blocking or reporting it. Meta may pause it.",
            )
        )

    if otp.get("enabled") and otp.get("templateStatus") != "APPROVED":
        status = otp.get("templateStatus")
        state = "missing" if not status or status == "MISSING" else status.lower()
        out.append(
            _alert(
                "warning",
                "otp_template",
                f"WhatsApp codes are on, but the code template {otp.get('templateName')} is {state}: employees get no "
                "code by WhatsApp until Meta approves it (OTP tab).",
            )
        )
    elif otp.get("enabled") and otp.get("available") and otp.get("paused"):
        out.append(
            _alert(
                "warning",
                "otp_paused",
                f"WhatsApp codes are on hold: {otp.get('pauseReason') or 'they cannot be sent right now.'} Employees can "
                "sign in with their password (or an SMS code) meanwhile.",
            )
        )
    template_minutes = otp.get("templateExpiryMinutes")
    if otp.get("enabled") and template_minutes and int(template_minutes) != int(s.otp_expiry_minutes):
        out.append(
            _alert(
                "warning",
                "otp_expiry_mismatch",
                f"The code template tells employees a code expires in {template_minutes} minutes, but codes expire in "
                f"{s.otp_expiry_minutes}. Change the expiry back, or create the template again with the new expiry.",
            )
        )

    budget = cost.get("budget")
    if budget:
        if cost["soFar"] >= budget:
            out.append(
                _alert(
                    "error",
                    "budget_exceeded",
                    f"This month's WhatsApp cost (₹{cost['soFar']:.2f} before GST) is over the budget of ₹{budget:.2f}.",
                )
            )
        elif cost.get("isCurrentMonth") and cost["projected"] > budget:
            out.append(
                _alert(
                    "warning",
                    "budget_projected_over",
                    f"At this pace the month ends at about ₹{cost['projected']:.2f}, over the budget of ₹{budget:.2f}.",
                )
            )
        elif cost["soFar"] >= budget * float(BUDGET_WARN_SHARE):
            out.append(
                _alert(
                    "info",
                    "budget_near",
                    f"{cost['budgetUsedPct']:.0f}% of this month's budget (₹{budget:.2f}) is spent.",
                )
            )

    if configured:
        last = s.last_webhook_at
        if last is None:
            out.append(
                _alert(
                    "warning",
                    "webhook_never",
                    "Meta's webhook has never reached this server: delivery and read ticks, template approvals and "
                    "STOP replies are not recorded. Paste the webhook address from Settings into Meta.",
                )
            )
        elif _now(now) - last > WEBHOOK_STALE:
            from .models import WhatsAppMessageLog

            if WhatsAppMessageLog.objects.filter(sent_at__gt=last + timedelta(hours=1)).exists():
                out.append(
                    _alert(
                        "warning",
                        "webhook_stale",
                        f"No word from Meta's webhook since {timezone.localtime(last, FACTORY_TZ):%d %b %Y %H:%M} "
                        "although messages went out: check the webhook in Meta.",
                    )
                )
    failed, sent = month.get("failed", 0), month.get("sent", 0)
    if failed >= 5 and failed >= (failed + sent) * 0.1:
        out.append(
            _alert(
                "warning",
                "failures",
                f"{failed} messages failed this month: see Messages for Meta's reasons.",
            )
        )
    order = {"error": 0, "warning": 1, "info": 2}
    return sorted(out, key=lambda a: order[a["level"]])


def overview(qs, s=None, now=None) -> dict:
    """GET /api/whatsapp-control/overview (contract keys; see whatsapp_control_views)."""
    s = _settings(s)
    month_start = _today(now).replace(day=1)
    configured = cloud.is_configured()
    status = whatsapp_service.phone_status() if configured else None
    queue = whatsapp_dispatcher.queue_status()
    connection = connection_summary(s, status, queue, now)
    month = month_counts(qs, month_start, now)
    _days, _by_category, _by_type, totals, so_far, _price = _tally(qs, month_start, s)
    month["billable"] = totals["billable"]
    cost = _cost(month_start, so_far, s, now)
    templates = templates_summary(s)
    otp = otp_summary(qs, s, month_start)
    return {
        "connection": connection,
        "month": month,
        "cost": cost,
        "templates": templates,
        "otp": otp,
        "queue": queue,
        "alerts": alerts(s, connection, month, cost, templates, otp, queue, now),
    }
