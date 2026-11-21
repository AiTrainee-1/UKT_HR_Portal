"""MD portal: Communication usage & cost (/md/communications). How much the HRMS uses WhatsApp, SMS and Gmail, and what it
costs, month by month. Read-only: nothing here sends, queues or changes a message or a setting.

Every figure is the HR Control pages' own figure, made by their own code, so the MD and HR read the same number:

    WhatsApp   whatsapp_usage.usage() (WhatsApp Control -> Usage & Cost): messages = accepted by Meta (sent + delivered +
               read); cost = billable messages x their pricing category's rate (HR's rates on WhatsApp Control ->
               Settings over Meta's India defaults), BEFORE 18% GST; projected = cost so far / days elapsed x days in
               the month; budget = WhatsAppSettings.monthly_budget (compared with the cost before GST). Meta's own
               figure (pricing analytics, cached 10 minutes by WhatsApp Control) is given beside the estimate in the
               month's breakdown when Meta answers.
    SMS        sms_control_views._month_numbers() (SMS Control -> Usage): messages = accepted by 2Factor; cost = SMS sent x
               the price per SMS on SMS Control -> Settings (default 0.20); projected and budget as WhatsApp; the credits
               left come from sms_service.balance() (read from 2Factor at most every 5 minutes, shared with SMS Control)
               through their own endpoint, so the overview never waits on 2Factor.
    Gmail      EmailMessageLog counted with email_control_views._status_counts (Gmail Control): messages = accepted by
               the mail server (SMTP gives no delivery receipt). Gmail SMTP has no per-email charge and the HRMS stores
               no email price or budget (EmailSettings holds switches and a daily limit only), so its cost is 0.

The settings rows are read with ``.filter(pk=1).first()`` (never ``.get()``, which would insert inside the read-only
transaction); a missing row means the defaults, exactly as the Control pages would create it.

Status groups (the history list and its counts), the same words for the three channels:
    sent       accepted by the provider (WhatsApp sent / delivered / read; SMS sent; email sent)
    delivered  WhatsApp only: Meta's webhook reported it delivered or read (SMS and SMTP have no receipt: null)
    failed     the provider refused it, or it could not complete
    skipped    deliberately not sent (WhatsApp skipped / expired; SMS and email blocked by a limit or a switch)
    waiting    WhatsApp only: still queued / sending

Functions (each returns a common.envelope):
    overview(month, months)                     KPIs per channel for the month, the change against the month before,
                                                the projection, budgets, a 12-month series, insights and a summary
    month_detail(month, channel)                one month: per day, per purpose, per message type, WhatsApp pricing
                                                categories and Meta's own figure
    history(period, channel, status, q, purpose, page, page_size)   the message list, newest first, masked contacts
    sms_balance()                               the SMS credits left (a live 2Factor read, cached 5 minutes)
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

from django.db.models import Count, Q
from django.db.models.functions import TruncDate
from django.utils import timezone

from ... import email_catalog, sms_control_views, sms_service
from ... import whatsapp_catalog as wa_catalog
from ... import whatsapp_usage as wa_usage
from ...clock import FACTORY_TZ
from ...email_control_views import _mask as mask_email
from ...email_control_views import _status_counts as email_status_counts
from ...models import (
    EmailMessageLog,
    EmailSettings,
    SmsMessageLog,
    SmsSettings,
    WhatsAppMessageLog,
    WhatsAppSettings,
    WhatsAppTemplate,
)
from ..assistant.tools_base import string_param, tool
from ..common import (
    MdParamError,
    Period,
    add_months,
    cached,
    change,
    envelope,
    money,
    month_label,
    parse_month,
    pct,
    prov,
)

CHANNELS = ("whatsapp", "sms", "email")
CHANNEL_LABELS = {"whatsapp": "WhatsApp", "sms": "SMS", "email": "Gmail"}
PROVIDERS = {"whatsapp": "Meta WhatsApp Cloud API", "sms": "2Factor.in", "email": "Gmail (SMTP)"}
CHANNEL_CHOICES = ("all", *CHANNELS)

STATUS_GROUPS = ("sent", "delivered", "failed", "skipped", "waiting")
_GROUPS = {
    "whatsapp": {
        "sent": wa_usage.ACCEPTED,
        "delivered": ("delivered", "read"),
        "failed": ("failed",),
        "skipped": ("skipped", "expired"),
        "waiting": wa_usage.WAITING,
    },
    "sms": {"sent": ("sent",), "delivered": (), "failed": ("failed",), "skipped": ("blocked",), "waiting": ()},
    "email": {"sent": ("sent",), "delivered": (), "failed": ("failed",), "skipped": ("blocked",), "waiting": ()},
}
STATUS_LABELS = {
    "whatsapp": {
        "pending": "Waiting",
        "queued": "Queued",
        "sending": "Sending",
        "sent": "Sent",
        "delivered": "Delivered",
        "read": "Read",
        "failed": "Failed",
        "expired": "Expired (not sent)",
        "skipped": "Skipped",
    },
    "sms": {"sent": "Sent", "failed": "Failed", "blocked": "Blocked"},
    "email": {"sent": "Sent", "failed": "Failed", "blocked": "Blocked"},
}
SMS_PURPOSE_LABELS = dict(SmsMessageLog.PURPOSES)

MONTHS_DEFAULT = 12
MONTHS_MAX = 24
PAGE_SIZE_DEFAULT = 25
PAGE_SIZE_MAX = 100
ERROR_MAX = 200
INSIGHTS_MAX = 5

# A change of cost this large (either way) against the month before is worth a line.
COST_SWING_PCT = 25.0
COST_SWING_MIN = 25.0  # rupees: a few paise either way is not news
# A channel failing this often (and at least FAILURES_MIN times) is worth a line.
FAILURE_PCT = 10.0
FAILURES_MIN = 5
BUDGET_WARN_SHARE = 0.8
GMAIL_REGULAR_DAILY = 500  # Gmail's own ceiling for a regular account (Gmail Control shows it too)

# sms_control_views scopes its counts to request.hr_branch_id; the MD is company-wide (no branch), so this stands in for
# the MD's request and the figures are the company-wide ones SMS Control shows a company-wide HR account.
_COMPANY_WIDE = SimpleNamespace(hr_branch_id=None)

_SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2, "good": 3}


# ── time ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def _today() -> date:
    """The factory's date, from the same clock the Control modules use (timezone.now in IST)."""
    return timezone.now().astimezone(FACTORY_TZ).date()


def _midnight(day: date) -> datetime:
    return datetime.combine(day, datetime.min.time(), tzinfo=FACTORY_TZ)


def _month_end(first: date) -> date:
    return first.replace(day=calendar.monthrange(first.year, first.month)[1])


def _bounds(first: date) -> tuple[datetime, datetime]:
    """[start, end) of the month in IST."""
    return _midnight(first), _midnight(_month_end(first) + timedelta(days=1))


def _key(first: date) -> str:
    return f"{first.year:04d}-{first.month:02d}"


def resolve_month(value: str | None) -> date:
    """The first day of the asked month ('YYYY-MM'; blank = this month). A month that has not started is refused."""
    today = _today()
    if not value:
        return today.replace(day=1)
    year, month = parse_month(value)
    first = date(year, month, 1)
    if first > today:
        raise MdParamError(f"{month_label(year, month)} has not started yet: choose this month or an earlier one.")
    return first


def resolve_channel(value: str | None, *, allow_all: bool = True) -> str:
    text = str(value or "all").strip().lower()
    if text == "gmail":
        text = "email"
    allowed = CHANNEL_CHOICES if allow_all else CHANNELS
    if text not in allowed:
        raise MdParamError(f"'channel' must be one of: {', '.join(allowed)}.")
    return text


def _clamp_months(value) -> int:
    try:
        n = int(value or MONTHS_DEFAULT)
    except (TypeError, ValueError):
        raise MdParamError(f"'months' must be a whole number, got '{value}'.") from None
    return max(2, min(MONTHS_MAX, n))


def _project(count: int | float, first: date, today: date) -> float:
    """The month's figure at the current pace (the Control pages' projection): so far / days elapsed x days in the
    month for this month, the actual figure for a past month."""
    days_in_month = calendar.monthrange(first.year, first.month)[1]
    if first.year == today.year and first.month == today.month:
        return count / today.day * days_in_month if today.day else count
    return count


# ── settings (read, never created) ───────────────────────────────────────────────────────────────────────────────


def _wa_settings() -> WhatsAppSettings:
    return WhatsAppSettings.objects.filter(pk=1).first() or WhatsAppSettings()


def _sms_settings() -> SmsSettings:
    return SmsSettings.objects.filter(pk=1).first() or SmsSettings()


def _email_daily_limit() -> int:
    row = EmailSettings.objects.filter(pk=1).only("daily_send_limit").first()
    return int(row.daily_send_limit or 0) if row else 0


# ── one month of each channel, by the Control modules' own code ─────────────────────────────────────────────────


def _wa_usage(first: date, s: WhatsAppSettings) -> dict:
    return wa_usage.usage(WhatsAppMessageLog.objects.all(), first, s, with_meta=False)


def _sms_numbers(first: date, s: SmsSettings) -> dict:
    return sms_control_views._month_numbers(_COMPANY_WIDE, first, s)


def _email_counts(first: date) -> dict:
    start, end = _bounds(first)
    return email_status_counts(EmailMessageLog.objects.filter(created_at__gte=start, created_at__lt=end))


def _wa_figures(u: dict) -> dict:
    t = u["totals"]
    return {
        "messages": t["sent"],
        "attempts": t["sent"] + t["failed"] + t["skipped"] + t["expired"] + t["queued"],
        "delivered": t["delivered"] + t["read"],
        "read": t["read"],
        "failed": t["failed"],
        "skipped": t["skipped"] + t["expired"],
        "waiting": t["queued"],
        "billable": t["billable"],
        # WhatsApp Control gives these as fractions 0..1: the MD portal speaks percentages
        "deliveryRate": round(t["deliveryRate"] * 100, 1) if t["deliveryRate"] is not None else None,
        "readRate": round(t["readRate"] * 100, 1) if t["readRate"] is not None else None,
        "cost": u["cost"]["soFar"],
    }


def _sms_figures(n: dict) -> dict:
    t = n["totals"]
    return {
        "messages": t["sent"],
        "attempts": t["requested"],
        "delivered": None,
        "failed": t["failed"],
        "skipped": t["blocked"],
        "waiting": 0,
        "verified": t["verified"],
        "deliveryRate": t["deliveryRate"],
        "verifiedRate": t["verifiedRate"],
        "cost": n["cost"]["soFar"],
    }


def _email_figures(c: dict) -> dict:
    return {
        "messages": c["sent"],
        "attempts": c["total"],
        "delivered": None,
        "failed": c["failed"],
        "skipped": c["blocked"],
        "waiting": 0,
        "deliveryRate": pct(c["sent"], c["sent"] + c["failed"]),
        "cost": 0.0,
    }


def _failure_rate(f: dict) -> float | None:
    return pct(f["failed"], f["messages"] + f["failed"])


def _month_points(firsts: list[date], wa_s, sms_s) -> dict[str, dict]:
    """{channel: {month key: (raw, figures)}} for the months asked (oldest first)."""
    out: dict[str, dict] = {c: {} for c in CHANNELS}
    for first in firsts:
        key = _key(first)
        u = _wa_usage(first, wa_s)
        out["whatsapp"][key] = (u, _wa_figures(u))
        n = _sms_numbers(first, sms_s)
        out["sms"][key] = (n, _sms_figures(n))
        c = _email_counts(first)
        out["email"][key] = (c, _email_figures(c))
    return out


# ── the channel block (what a channel card shows) ───────────────────────────────────────────────────────────────


def _cost_block(channel: str, raw: dict) -> dict:
    """The money side of one channel's month, keyed the same for the three channels."""
    if channel == "whatsapp":
        c = raw["cost"]
        return {
            "cost": c["soFar"],
            "costWithGst": c["soFarWithGst"],
            "projectedCost": c["projected"],
            "projectedCostWithGst": c["projectedWithGst"],
            "gstRate": c["gstRate"],
            "budget": c["budget"],
            "budgetUsedPct": c["budgetUsedPct"],
            "projectedBudgetPct": c["projectedBudgetPct"],
            "costBasis": "estimate",
            "costNote": "Estimate: billable messages x the rates set in WhatsApp Control, before 18% GST.",
            "rates": raw["rates"],
        }
    if channel == "sms":
        c = raw["cost"]
        return {
            "cost": c["soFar"],
            "costWithGst": None,
            "projectedCost": c["projected"],
            "projectedCostWithGst": None,
            "gstRate": None,
            "budget": c["budget"],
            "budgetUsedPct": c["budgetUsedPct"],
            "projectedBudgetPct": c["projectedBudgetPct"],
            "costBasis": "estimate",
            "costNote": f"Estimate: SMS sent x ₹{_price_text(c['perSms'])} per SMS, the price set in SMS Control.",
            "rates": {"perSms": c["perSms"]},
        }
    return {
        "cost": 0.0,
        "costWithGst": None,
        "projectedCost": 0.0,
        "projectedCostWithGst": None,
        "gstRate": None,
        "budget": None,
        "budgetUsedPct": None,
        "projectedBudgetPct": None,
        "costBasis": "free",
        "costNote": "Gmail (SMTP) has no per-email charge, and the HRMS stores no email price or budget.",
        "rates": None,
    }


def _channel_block(channel: str, raw: dict, figures: dict, first: date, today: date, previous=None) -> dict:
    block = {
        "channel": channel,
        "label": CHANNEL_LABELS[channel],
        "provider": PROVIDERS[channel],
        **figures,
        "failureRate": _failure_rate(figures),
        "projectedMessages": round(_project(figures["messages"], first, today)),
        **_cost_block(channel, raw),
    }
    if previous is not None:
        prev_fig, prev_first = previous
        current_basis = _is_current(first, today)
        messages_now = block["projectedMessages"] if current_basis else figures["messages"]
        cost_now = block["projectedCost"] if current_basis else block["cost"]
        block["previous"] = {
            "month": _key(prev_first),
            "label": month_label(prev_first.year, prev_first.month),
            "messages": prev_fig["messages"],
            "cost": prev_fig["cost"],
        }
        block["change"] = {
            "messages": change(float(messages_now), float(prev_fig["messages"])),
            "cost": change(float(cost_now), float(prev_fig["cost"])),
        }
        block["changeBasis"] = "projected" if current_basis else "actual"
    return block


def _is_current(first: date, today: date) -> bool:
    return first.year == today.year and first.month == today.month


# ── insights and the summary sentence ───────────────────────────────────────────────────────────────────────────


def _price_text(value: float) -> str:
    """0.2 -> '0.20', 0.185 -> '0.185' (a rate keeps its paise and any finer digits)."""
    whole, _, frac = f"{value:.4f}".rstrip("0").partition(".")
    return f"{whole}.{frac.ljust(2, '0')}"


def _rupees(value: float | None) -> str:
    return "₹0" if not value else f"₹{value:,.2f}"


def _insights(blocks: dict, totals: dict, wa_raw: dict, email_peak: dict | None, email_limit: dict) -> list:
    out: list[dict] = []
    label = totals["label"]

    def add(id_, severity, title, detail, channel=None, ask=None):
        out.append(
            {
                "id": f"comms.{id_}",
                "severity": severity,
                "title": title,
                "detail": detail,
                "channel": channel,
                "page": "communications",
                "ask": ask,
            }
        )

    for channel in ("whatsapp", "sms"):
        b = blocks[channel]
        budget = b["budget"]
        if not budget:
            continue
        name = b["label"]
        if b["cost"] >= budget:
            add(
                f"{channel}-over-budget",
                "critical",
                f"{name} cost {_rupees(b['cost'])} is over its {_rupees(budget)} budget in {label}",
                f"The budget is set in {name} Control and compared with the cost before GST.",
                channel,
                f"Why is the {name} cost over budget in {label}?",
            )
        elif totals["isCurrentMonth"] and b["projectedCost"] > budget:
            add(
                f"{channel}-projected-over",
                "warning",
                f"{name} is on pace for {_rupees(b['projectedCost'])}, over its {_rupees(budget)} budget",
                f"{_rupees(b['cost'])} so far ({b['budgetUsedPct']}% of the budget) after {totals['daysElapsed']} days.",
                channel,
                f"What is driving the {name} cost this month?",
            )
        elif b["cost"] >= budget * BUDGET_WARN_SHARE:
            add(
                f"{channel}-budget-near",
                "info",
                f"{b['budgetUsedPct']}% of the {name} budget is used in {label}",
                f"{_rupees(b['cost'])} of {_rupees(budget)}.",
                channel,
            )

    previous_cost = totals["previous"]["cost"]
    now_cost = totals["projectedCost"] if totals["isCurrentMonth"] else totals["cost"]
    swing = pct(now_cost - previous_cost, previous_cost) if previous_cost else None
    if swing is not None and abs(swing) >= COST_SWING_PCT and abs(now_cost - previous_cost) >= COST_SWING_MIN:
        up = swing > 0
        word = "is on pace for" if totals["isCurrentMonth"] else "was"
        add(
            "cost-swing",
            "warning" if up else "good",
            f"Communication cost {word} {_rupees(now_cost)} in {label}, {abs(swing):g}% "
            f"{'more' if up else 'less'} than {totals['previous']['label']}",
            f"{totals['previous']['label']} cost {_rupees(previous_cost)} (WhatsApp and SMS; Gmail has no charge).",
            None,
            f"Why did communication cost {'rise' if up else 'fall'} in {label}?",
        )

    wa_types = [t for t in wa_raw.get("byType", []) if t["cost"] > 0]
    if wa_types and blocks["whatsapp"]["cost"]:
        top = max(wa_types, key=lambda t: (t["cost"], t["messages"]))
        share = pct(top["cost"], blocks["whatsapp"]["cost"], 0)
        add(
            "whatsapp-top-type",
            "info",
            f"{top['label']} messages cost the most on WhatsApp: {_rupees(top['cost'])} ({share:g}% of it)",
            f"{top['billable']} billable of {top['messages']} sent in {label} ({top['moduleLabel']}).",
            "whatsapp",
            f"Which WhatsApp messages cost the most in {label}?",
        )

    for channel in CHANNELS:
        b = blocks[channel]
        rate = b["failureRate"]
        if b["failed"] >= FAILURES_MIN and rate is not None and rate >= FAILURE_PCT:
            add(
                f"{channel}-failures",
                "warning",
                f"{b['failed']} {b['label']} messages failed in {label} ({rate:g}% of the ones tried)",
                f"See the history below, filtered to Failed, for the reasons {b['label']} gave.",
                channel,
            )

    if email_peak and email_peak["sent"]:
        limit = email_limit["value"]
        if email_peak["sent"] >= limit * BUDGET_WARN_SHARE:
            add(
                "email-peak",
                "warning",
                f"The busiest email day ({email_peak['date']}) sent {email_peak['sent']} emails, near the limit of {limit}",
                f"{email_limit['source']}. Over the limit, mail is held back until the next day.",
                "email",
            )

    out.sort(key=lambda i: _SEVERITY_ORDER[i["severity"]])
    return out[:INSIGHTS_MAX]


def _summary(blocks: dict, totals: dict) -> str:
    wa, sms, em = blocks["whatsapp"], blocks["sms"], blocks["email"]
    parts = [
        f"In {totals['label']} the HRMS sent {totals['messages']:,} messages: {wa['messages']:,} on WhatsApp, "
        f"{sms['messages']:,} SMS and {em['messages']:,} emails."
    ]
    if totals["cost"]:
        parts.append(
            f"Estimated cost {'so far ' if totals['isCurrentMonth'] else ''}{_rupees(totals['cost'])} before GST "
            f"(WhatsApp {_rupees(wa['cost'])}, SMS {_rupees(sms['cost'])}; Gmail has no per-email charge)."
        )
    else:
        parts.append("Nothing chargeable was sent (Gmail has no per-email charge).")
    if totals["isCurrentMonth"] and totals["cost"]:
        parts.append(f"At this pace the month ends near {_rupees(totals['projectedCost'])}.")
    prev = totals["previous"]
    if prev["cost"] or prev["messages"]:
        parts.append(f"{prev['label']}: {prev['messages']:,} messages, {_rupees(prev['cost'])}.")
    return " ".join(parts)


# ── provenance ──────────────────────────────────────────────────────────────────────────────────────────────────


def _provenance(rows: dict[str, int]) -> list[dict]:
    return [
        prov(
            "wa-messages",
            "WhatsApp messages",
            dataset="WhatsApp message log (WhatsApp Control)",
            definition="Messages Meta accepted in the month (IST): sent, delivered or read. Delivered counts the ones "
            "Meta's webhook reported delivered or read.",
            formula="sent + delivered + read",
            rows=rows.get("whatsapp"),
            filters=["Failed, skipped, expired and queued messages are not counted as sent"],
            caveats=["The same counting as WhatsApp Control -> Usage & Cost."],
        ),
        prov(
            "wa-cost",
            "WhatsApp cost",
            dataset="WhatsApp message log + WhatsApp Control -> Settings rates",
            definition="Estimated cost before 18% GST: each billable message x its pricing category's rate (HR's rates "
            "over Meta's India defaults: authentication and utility ₹0.115, marketing ₹0.8631, service free).",
            formula="Σ billable messages x category rate",
            rows=rows.get("whatsapp"),
            caveats=[
                "An estimate, not Meta's invoice: Meta's own figure is shown beside it when Meta answers.",
                "Messages sent before the switch to Meta's Cloud API (20 Nov 2026) are counted but never charged.",
                "The same figure as WhatsApp Control -> Usage & Cost.",
            ],
        ),
        prov(
            "sms-messages",
            "SMS messages",
            dataset="SMS log (SMS Control)",
            definition="SMS one-time codes 2Factor accepted in the month (IST), test messages included. Verified = "
            "codes employees used in time.",
            formula="SMS with status sent",
            rows=rows.get("sms"),
            caveats=["The same counting as SMS Control -> Usage."],
        ),
        prov(
            "sms-cost",
            "SMS cost",
            dataset="SMS log + SMS Control -> Settings price",
            definition="Estimated cost: SMS sent x the price per SMS set on SMS Control (₹0.20 when not set).",
            formula="SMS sent x price per SMS",
            rows=rows.get("sms"),
            caveats=["An estimate: 2Factor's own bill is not read.", "The same figure as SMS Control -> Usage."],
        ),
        prov(
            "email-messages",
            "Emails",
            dataset="Email log (Gmail Control)",
            definition="Emails the mail server accepted in the month (IST). SMTP gives no delivery receipt, so sent "
            "means accepted by Gmail.",
            formula="emails with status sent",
            rows=rows.get("email"),
            caveats=["The same counting as Gmail Control."],
        ),
        prov(
            "email-cost",
            "Email cost",
            dataset="Gmail Control settings",
            definition="Gmail (SMTP) has no per-email charge, and the HRMS stores no email price or budget, so email "
            "costs ₹0 here. Any Google Workspace subscription is outside the HRMS.",
            formula="0",
        ),
        prov(
            "projection",
            "Projected month",
            dataset="The month so far",
            definition="This month at the current pace (the Control pages' projection); a past month is its actual "
            "figure.",
            formula="so far ÷ days elapsed (today included) x days in the month",
        ),
        prov(
            "change",
            "Change against the month before",
            dataset="The month before",
            definition="This month's projected figure (for the current month) or its actual figure (a past month) "
            "against the whole month before.",
            formula="(this month - month before) ÷ month before x 100",
        ),
    ]


# ── GET overview ────────────────────────────────────────────────────────────────────────────────────────────────


def _email_days(first: date) -> dict[date, dict]:
    start, end = _bounds(first)
    out: dict[date, dict] = {}
    rows = (
        EmailMessageLog.objects.filter(created_at__gte=start, created_at__lt=end)
        .order_by()
        .annotate(day=TruncDate("created_at", tzinfo=FACTORY_TZ))
        .values("day", "status")
        .annotate(n=Count("id"))
    )
    for r in rows:
        day = out.setdefault(r["day"], {"sent": 0, "failed": 0, "blocked": 0})
        if r["status"] in day:
            day[r["status"]] += r["n"]
    return out


def _email_peak(days: dict[date, dict]) -> dict | None:
    if not days:
        return None
    day, counts = max(days.items(), key=lambda kv: (kv[1]["sent"], kv[0]))
    return {"date": day.isoformat(), "sent": counts["sent"]}


def _email_limit(daily_limit: int) -> dict:
    if daily_limit > 0:
        return {"value": daily_limit, "source": "The daily email limit set on Gmail Control"}
    return {"value": GMAIL_REGULAR_DAILY, "source": "Gmail's own ceiling for a regular account is about 500 a day"}


def sms_balance() -> dict:
    """The SMS credits left on the 2Factor account (sms_service.balance: read from 2Factor at most every 5 minutes, the
    same reading SMS Control shows). Its own endpoint, loaded after the page, because an uncached read waits on 2Factor."""
    try:
        b = sms_service.balance()
    except Exception:  # noqa: BLE001 - a balance read must never break the page
        b = {"credits": None, "checkedAt": None, "error": "The SMS balance could not be read."}
    credits = b.get("credits")
    return envelope(
        {
            "credits": credits,
            "checkedAt": b.get("checkedAt"),
            "error": b.get("error"),
            "lowCredits": sms_service.LOW_BALANCE_CREDITS,
            "isLow": isinstance(credits, (int, float)) and credits < sms_service.LOW_BALANCE_CREDITS,
        },
        provenance=[
            prov(
                "sms-balance",
                "SMS credits left",
                dataset="2Factor account (SMS Control)",
                definition="The SMS credits 2Factor reports for the account, read at most every 5 minutes.",
                caveats=["Nothing is sent to read it."],
            )
        ],
    )


def _meta(first: date) -> dict:
    try:
        m = wa_usage.meta_pricing(first)
    except Exception:  # noqa: BLE001 - Meta's figure is extra; the estimate stands without it
        return {"available": False, "cost": None, "volume": None, "error": "Meta's figure could not be read."}
    return {"available": m["available"], "cost": m["cost"], "volume": m["volume"], "error": m["error"]}


@cached()
def overview(month: str | None = None, months: int = MONTHS_DEFAULT) -> dict:
    """The executive view of one month (default this month) with the months before it."""
    first = resolve_month(month)
    months = _clamp_months(months)
    today = _today()
    firsts = [date(*add_months(first.year, first.month, -i), 1) for i in range(months - 1, -1, -1)]
    wa_s, sms_s = _wa_settings(), _sms_settings()
    points = _month_points(firsts, wa_s, sms_s)
    key, prev_first = _key(first), firsts[-2]
    prev_key = _key(prev_first)

    blocks = {}
    for channel in CHANNELS:
        raw, fig = points[channel][key]
        prev_fig = points[channel][prev_key][1]
        blocks[channel] = _channel_block(channel, raw, fig, first, today, previous=(prev_fig, prev_first))

    wa_raw = points["whatsapp"][key][0]
    email_days = _email_days(first)
    peak = _email_peak(email_days)
    limit = _email_limit(_email_daily_limit())
    blocks["email"]["peakDay"] = peak
    blocks["email"]["dailyLimit"] = limit
    current = _is_current(first, today)

    days_in_month = calendar.monthrange(first.year, first.month)[1]
    cost = money(sum(blocks[c]["cost"] for c in CHANNELS))
    projected_cost = money(sum(blocks[c]["projectedCost"] for c in CHANNELS))
    messages = sum(blocks[c]["messages"] for c in CHANNELS)
    projected_messages = sum(blocks[c]["projectedMessages"] for c in CHANNELS)
    prev_messages = sum(points[c][prev_key][1]["messages"] for c in CHANNELS)
    prev_cost = money(sum(points[c][prev_key][1]["cost"] for c in CHANNELS))
    budget_channels = [c for c in ("whatsapp", "sms") if blocks[c]["budget"]]
    budget = money(sum(blocks[c]["budget"] for c in budget_channels)) if budget_channels else None
    budget_cost = money(sum(blocks[c]["cost"] for c in budget_channels)) if budget_channels else None
    totals = {
        "label": month_label(first.year, first.month),
        "isCurrentMonth": current,
        "daysElapsed": today.day if current else days_in_month,
        "messages": messages,
        "attempts": sum(blocks[c]["attempts"] for c in CHANNELS),
        "failed": sum(blocks[c]["failed"] for c in CHANNELS),
        "cost": cost,
        "projectedCost": projected_cost,
        "projectedMessages": projected_messages,
        "budget": budget,
        "budgetCost": budget_cost,
        "budgetUsedPct": pct(budget_cost, budget) if budget else None,
        "budgetChannels": budget_channels,
        "previous": {
            "month": prev_key,
            "label": month_label(prev_first.year, prev_first.month),
            "messages": prev_messages,
            "cost": prev_cost,
        },
        "change": {
            "messages": change(float(projected_messages if current else messages), float(prev_messages)),
            "cost": change(float(projected_cost if current else cost), float(prev_cost)),
        },
        "changeBasis": "projected" if current else "actual",
    }

    series = []
    for f in firsts:
        k = _key(f)
        point = {"month": k, "label": month_label(f.year, f.month), "isCurrentMonth": _is_current(f, today)}
        for channel in CHANNELS:
            fig = points[channel][k][1]
            point[channel] = {"messages": fig["messages"], "cost": fig["cost"], "failed": fig["failed"]}
        point["messages"] = sum(point[c]["messages"] for c in CHANNELS)
        point["cost"] = money(sum(point[c]["cost"] for c in CHANNELS))
        series.append(point)

    rows = {c: blocks[c]["attempts"] for c in CHANNELS}
    notes = []
    if wa_s.pk and wa_s.last_webhook_at is None and blocks["whatsapp"]["messages"]:
        notes.append(
            "Meta's webhook has never reached this server, so WhatsApp delivery ticks and Meta's billable flags are "
            "not recorded: delivered shows 0 and the cost uses the billable rule for every accepted message."
        )
    return envelope(
        {
            "month": key,
            "label": totals["label"],
            "isCurrentMonth": current,
            "daysInMonth": days_in_month,
            "daysElapsed": totals["daysElapsed"],
            "maxMonth": _key(today.replace(day=1)),
            "totals": totals,
            "channels": [blocks[c] for c in CHANNELS],
            "series": series,
            "insights": _insights(blocks, totals, wa_raw, peak, limit),
            "summary": _summary(blocks, totals),
        },
        provenance=_provenance(rows),
        notes=notes,
    )


# ── GET month ───────────────────────────────────────────────────────────────────────────────────────────────────


def _wa_skipped_by_type(first: date) -> dict[str, int]:
    start, end = _bounds(first)
    out: dict[str, int] = {}
    rows = (
        WhatsAppMessageLog.objects.filter(
            created_at__gte=start, created_at__lt=end, status__in=_GROUPS["whatsapp"]["skipped"]
        )
        .order_by()
        .values("document_type")
        .annotate(n=Count("id"))
    )
    for r in rows:
        out[r["document_type"]] = r["n"]
    return out


def _email_breakdown(first: date) -> list[dict]:
    start, end = _bounds(first)
    by_type: dict[str, dict] = {}
    rows = (
        EmailMessageLog.objects.filter(created_at__gte=start, created_at__lt=end)
        .order_by()
        .values("email_type", "status")
        .annotate(n=Count("id"))
    )
    for r in rows:
        t = by_type.setdefault(r["email_type"], {"sent": 0, "failed": 0, "blocked": 0})
        if r["status"] in t:
            t[r["status"]] += r["n"]
    out = []
    for key, t in by_type.items():
        module = email_catalog.module_of(key)
        out.append(
            {
                "channel": "email",
                "key": key,
                "label": email_catalog.label(key),
                "purposeKey": module,
                "purposeLabel": email_catalog.MODULES.get(module, "Other"),
                "messages": t["sent"],
                "failed": t["failed"],
                "skipped": t["blocked"],
                "billable": None,
                "cost": 0.0,
            }
        )
    return out


def _wa_breakdown(u: dict, skipped: dict[str, int]) -> list[dict]:
    known = {t["type"] for t in u["byType"]}
    return [
        {
            "channel": "whatsapp",
            "key": t["type"],
            "label": t["label"],
            "purposeKey": t["module"],
            "purposeLabel": t["moduleLabel"],
            "messages": t["messages"],
            "failed": t["failed"],
            "skipped": skipped.get(t["type"], 0),
            "billable": t["billable"],
            "cost": t["cost"],
        }
        for t in u["byType"]
    ] + [
        {
            "channel": "whatsapp",
            "key": key,
            "label": wa_catalog.label(key),
            "purposeKey": wa_catalog.module_of(key),
            "purposeLabel": wa_catalog.MODULES.get(wa_catalog.module_of(key), "Other"),
            "messages": 0,
            "failed": 0,
            "skipped": n,
            "billable": 0,
            "cost": 0.0,
        }
        for key, n in skipped.items()
        if key not in known
    ]


def _sms_breakdown(n: dict) -> list[dict]:
    price = Decimal(str(n["cost"]["perSms"]))
    out = []
    for key, p in n["byPurpose"].items():
        if not (p["sent"] or p["failed"] or p["blocked"]):
            continue
        out.append(
            {
                "channel": "sms",
                "key": key,
                "label": SMS_PURPOSE_LABELS.get(key, key),
                "purposeKey": key,
                "purposeLabel": SMS_PURPOSE_LABELS.get(key, key),
                "messages": p["sent"],
                "failed": p["failed"],
                "skipped": p["blocked"],
                "billable": p["sent"],
                "verified": p["verified"],
                "cost": money(price * p["sent"]),
            }
        )
    return out


def _purposes(types: list[dict]) -> list[dict]:
    """The message types folded into their purpose (the HRMS module that sent them), per channel."""
    by: dict[tuple[str, str], dict] = {}
    for t in types:
        row = by.setdefault(
            (t["channel"], t["purposeKey"]),
            {
                "channel": t["channel"],
                "key": t["purposeKey"],
                "label": t["purposeLabel"],
                "messages": 0,
                "failed": 0,
                "skipped": 0,
                "cost": 0.0,
                "types": 0,
            },
        )
        row["messages"] += t["messages"]
        row["failed"] += t["failed"]
        row["skipped"] += t["skipped"]
        row["cost"] = money(row["cost"] + t["cost"])
        row["types"] += 1
    return sorted(by.values(), key=lambda r: (-r["cost"], -r["messages"], r["channel"], r["label"]))


@cached()
def month_detail(month: str | None = None, channel: str = "all") -> dict:
    """One month's breakdown: per day, per purpose, per message type (and WhatsApp's pricing categories)."""
    first = resolve_month(month)
    channel = resolve_channel(channel)
    wanted = CHANNELS if channel == "all" else (channel,)
    today = _today()
    current = _is_current(first, today)
    days_in_month = calendar.monthrange(first.year, first.month)[1]

    blocks: dict[str, dict] = {}
    types: list[dict] = []
    days: dict[str, dict] = {}
    last_day = min(_month_end(first), today)
    for offset in range((last_day - first).days + 1):
        d = (first + timedelta(days=offset)).isoformat()
        days[d] = {"date": d, **{c: 0 for c in wanted}, "failed": 0}
    by_category: list[dict] = []
    meta = None

    if "whatsapp" in wanted:
        u = _wa_usage(first, _wa_settings())
        blocks["whatsapp"] = _channel_block("whatsapp", u, _wa_figures(u), first, today)
        types += _wa_breakdown(u, _wa_skipped_by_type(first))
        for d in u["days"]:
            if d["date"] in days:
                days[d["date"]]["whatsapp"] = d["sent"]
                days[d["date"]]["failed"] += d["failed"]
        by_category = [
            {"key": k, "label": k.title(), **v} for k, v in u["byCategory"].items() if v["messages"] or v["billable"]
        ]
        meta = _meta(first)
        blocks["whatsapp"]["meta"] = meta
    if "sms" in wanted:
        n = _sms_numbers(first, _sms_settings())
        blocks["sms"] = _channel_block("sms", n, _sms_figures(n), first, today)
        types += _sms_breakdown(n)
        for d in n["days"]:
            if d["date"] in days:
                days[d["date"]]["sms"] = d["sent"]
                days[d["date"]]["failed"] += d["failed"]
    if "email" in wanted:
        c = _email_counts(first)
        blocks["email"] = _channel_block("email", c, _email_figures(c), first, today)
        types += _email_breakdown(first)
        email_days = _email_days(first)
        for day, counts in email_days.items():
            iso = day.isoformat()
            if iso in days:
                days[iso]["email"] = counts["sent"]
                days[iso]["failed"] += counts["failed"]
        blocks["email"]["peakDay"] = _email_peak(email_days)
        blocks["email"]["dailyLimit"] = _email_limit(_email_daily_limit())

    for d in days.values():
        d["total"] = sum(d[c] for c in wanted)
    types.sort(key=lambda t: (-t["cost"], -t["messages"], t["channel"], t["label"]))
    rows = {c: blocks[c]["attempts"] for c in wanted}
    return envelope(
        {
            "month": _key(first),
            "label": month_label(first.year, first.month),
            "channel": channel,
            "channelsShown": list(wanted),
            "isCurrentMonth": current,
            "daysInMonth": days_in_month,
            "daysElapsed": today.day if current else days_in_month,
            "channels": [blocks[c] for c in wanted],
            "days": list(days.values()),
            "byPurpose": _purposes(types),
            "byType": types,
            "byCategory": by_category,
            "meta": meta,
        },
        provenance=_provenance(rows),
    )


# ── GET history ─────────────────────────────────────────────────────────────────────────────────────────────────


def _module_q(field: str, catalog_types: dict, module: str, types_in) -> Q:
    """The rows of one module (purpose); 'other' also takes types the catalog does not know."""
    q = Q(**{f"{field}__in": types_in(module)})
    if module == "other":
        q |= ~Q(**{f"{field}__in": list(catalog_types)})
    return q


def _search_q(q: str, extra: tuple[str, ...]) -> Q:
    cond = (
        Q(employee__first_name__icontains=q)
        | Q(employee__last_name__icontains=q)
        | Q(employee__employee_code__icontains=q)
    )
    for field in extra:
        cond |= Q(**{f"{field}__icontains": q})
    return cond


def _channel_qs(channel: str, start: datetime, end: datetime, q: str, purpose: str | None):
    if channel == "whatsapp":
        qs = WhatsAppMessageLog.objects.filter(created_at__gte=start, created_at__lt=end)
        if purpose:
            if purpose not in wa_catalog.MODULES:
                raise MdParamError(f"'purpose' for WhatsApp must be one of: {', '.join(wa_catalog.MODULES)}.")
            qs = qs.filter(_module_q("document_type", wa_catalog.TYPES, purpose, wa_catalog.types_in))
        if q:
            qs = qs.filter(_search_q(q, ("recipient_label",)))
    elif channel == "sms":
        qs = SmsMessageLog.objects.filter(created_at__gte=start, created_at__lt=end)
        if purpose:
            if purpose not in SMS_PURPOSE_LABELS:
                raise MdParamError(f"'purpose' for SMS must be one of: {', '.join(SMS_PURPOSE_LABELS)}.")
            qs = qs.filter(purpose=purpose)
        if q:
            qs = qs.filter(_search_q(q, ()))
    else:
        qs = EmailMessageLog.objects.filter(created_at__gte=start, created_at__lt=end)
        if purpose:
            if purpose not in email_catalog.MODULES:
                raise MdParamError(f"'purpose' for Gmail must be one of: {', '.join(email_catalog.MODULES)}.")
            qs = qs.filter(_module_q("email_type", email_catalog.TYPES, purpose, email_catalog.types_in))
        if q:
            qs = qs.filter(_search_q(q, ("recipient_name",)))
    return qs.order_by()


def _group_counts(channel: str, qs) -> dict[str, int]:
    counts = {g: 0 for g in STATUS_GROUPS}
    for r in qs.values("status").annotate(n=Count("id")):
        for group, statuses in _GROUPS[channel].items():
            if r["status"] in statuses:
                counts[group] += r["n"]
    return counts


def _wall(dt: datetime | None) -> str | None:
    return timezone.localtime(dt, FACTORY_TZ).replace(tzinfo=None).isoformat(timespec="seconds") if dt else None


def _group_of(channel: str, status: str) -> str:
    for group in ("delivered", "sent", "failed", "skipped", "waiting"):  # delivered before sent: it is the finer word
        if status in _GROUPS[channel][group]:
            return group
    return "waiting"


def _person(emp) -> tuple[str, str | None]:
    if emp is None:
        return "", None
    return f"{emp.first_name} {emp.last_name}".strip(), emp.employee_code


def _wa_rows(ids: list[int], s: WhatsAppSettings) -> dict[int, dict]:
    rows = list(
        WhatsAppMessageLog.objects.filter(pk__in=ids)
        .select_related("employee")
        .only(
            "id",
            "created_at",
            "status",
            "document_type",
            "related_module",
            "phone_number",
            "recipient_label",
            "error_message",
            "template_name",
            "pricing_category",
            "billable",
            "employee__first_name",
            "employee__last_name",
            "employee__employee_code",
        )
    )
    names = {r.template_name for r in rows if r.template_name}
    template_categories = (
        dict(WhatsAppTemplate.objects.filter(name__in=names).values_list("name", "category")) if names else {}
    )
    price = wa_usage.rates(s)
    out = {}
    for m in rows:
        category = wa_usage.category_of(m.document_type, m.pricing_category, m.template_name, template_categories)
        # whatsapp_usage._tally's rule: Meta's billable flag when the webhook gave one, else every message Meta accepted
        # that went through Meta (a template or Meta's pricing) and is not a free service message
        if m.billable is not None:
            billable = bool(m.billable)
        else:
            billable = m.status in wa_usage.ACCEPTED and bool(m.template_name or m.pricing_category)
            billable = billable and category != "service"
        name, code = _person(m.employee)
        module = wa_catalog.module_of(m.document_type)
        out[m.id] = {
            "id": f"whatsapp-{m.id}",
            "channel": "whatsapp",
            "at": _wall(m.created_at),
            "recipient": name or m.recipient_label or "Not an employee",
            "recipientCode": code,
            "contact": sms_service.mask_phone(m.phone_number or ""),
            "typeLabel": wa_catalog.label(m.document_type),
            "purposeKey": module,
            "purposeLabel": wa_catalog.MODULES.get(module, "Other"),
            "status": m.status,
            "statusLabel": STATUS_LABELS["whatsapp"].get(m.status, m.status.title()),
            "group": _group_of("whatsapp", m.status),
            "error": (m.error_message or "")[:ERROR_MAX],
            "pricingCategory": category,
            "estimatedCost": float(price[category]) if billable else 0.0,
        }
    return out


def _sms_rows(ids: list[int], s: SmsSettings) -> dict[int, dict]:
    price = float(sms_service.price_per_sms(s))
    out = {}
    for m in SmsMessageLog.objects.filter(pk__in=ids).select_related("employee"):
        name, code = _person(m.employee)
        if not name:
            name = "Test message" if m.purpose == SmsMessageLog.PURPOSE_TEST else "Not an employee"
        out[m.id] = {
            "id": f"sms-{m.id}",
            "channel": "sms",
            "at": _wall(m.created_at),
            "recipient": name,
            "recipientCode": code,
            "contact": m.phone_masked,  # the log never holds the full number
            "typeLabel": SMS_PURPOSE_LABELS.get(m.purpose, m.purpose),
            "purposeKey": m.purpose,
            "purposeLabel": SMS_PURPOSE_LABELS.get(m.purpose, m.purpose),
            "status": m.status,
            "statusLabel": STATUS_LABELS["sms"].get(m.status, m.status.title()),
            "group": _group_of("sms", m.status),
            "error": (m.error or "")[:ERROR_MAX],
            "pricingCategory": None,
            "estimatedCost": price if m.status == SmsMessageLog.STATUS_SENT else 0.0,
        }
    return out


def _email_rows(ids: list[int]) -> dict[int, dict]:
    out = {}
    rows = (
        EmailMessageLog.objects.filter(pk__in=ids)
        .select_related("employee")
        .only(
            "id",
            "created_at",
            "status",
            "email_type",
            "recipient_name",
            "recipient_email",
            "error_message",
            "employee__first_name",
            "employee__last_name",
            "employee__employee_code",
        )
    )
    for m in rows:
        name, code = _person(m.employee)
        module = email_catalog.module_of(m.email_type)
        out[m.id] = {
            "id": f"email-{m.id}",
            "channel": "email",
            "at": _wall(m.created_at),
            "recipient": m.recipient_name or name or "Not an employee",
            "recipientCode": code,
            "contact": mask_email(m.recipient_email or ""),
            "typeLabel": email_catalog.label(m.email_type),
            "purposeKey": module,
            "purposeLabel": email_catalog.MODULES.get(module, "Other"),
            "status": m.status,
            "statusLabel": STATUS_LABELS["email"].get(m.status, m.status.title()),
            "group": _group_of("email", m.status),
            "error": (m.error_message or "")[:ERROR_MAX],
            "pricingCategory": None,
            "estimatedCost": 0.0,
        }
    return out


def history(
    period: Period,
    *,
    channel: str = "all",
    status: str | None = None,
    q: str = "",
    purpose: str | None = None,
    page: int = 1,
    page_size: int = PAGE_SIZE_DEFAULT,
) -> dict:
    """The message list of a period (newest first, paged) with the count of each status group under the other
    filters. Contacts are masked (••••••1234, ab•••@gmail.com); no message text, subject or code is returned."""
    channel = resolve_channel(channel)
    if status in (None, "", "all"):
        status = None
    elif status not in STATUS_GROUPS:
        raise MdParamError(f"'status' must be one of: {', '.join(STATUS_GROUPS)}.")
    if purpose in ("", "all"):
        purpose = None
    if purpose and channel == "all":
        raise MdParamError("Choose a channel before filtering by purpose.")
    page = max(1, int(page))
    page_size = max(1, min(PAGE_SIZE_MAX, int(page_size)))
    q = (q or "").strip()[:100]
    wanted = CHANNELS if channel == "all" else (channel,)
    start, end = _midnight(period.start), _midnight(period.end + timedelta(days=1))

    querysets = {c: _channel_qs(c, start, end, q, purpose) for c in wanted}
    per_channel = {c: _group_counts(c, qs) for c, qs in querysets.items()}
    counts = {g: sum(per_channel[c][g] for c in wanted) for g in STATUS_GROUPS}
    counts["total"] = counts["sent"] + counts["failed"] + counts["skipped"] + counts["waiting"]
    no_receipt = all(c != "whatsapp" for c in wanted)
    if no_receipt:
        counts["delivered"] = None
        counts["waiting"] = 0

    if status:
        querysets = {c: qs.filter(status__in=_GROUPS[c][status]) for c, qs in querysets.items() if _GROUPS[c][status]}
        total = counts[status] or 0
    else:
        total = counts["total"]

    offset = (page - 1) * page_size
    order = {c: i for i, c in enumerate(CHANNELS)}
    picked: list[tuple[str, int]] = []
    if len(querysets) == 1:
        (c, qs), *_ = querysets.items()
        ids = qs.order_by("-created_at", "-id").values_list("id", flat=True)[offset : offset + page_size]
        picked = [(c, i) for i in ids]
    elif querysets:
        # newest first across the channels: the first offset + page_size of each, merged
        heads = []
        for c, qs in querysets.items():
            for at, pk in qs.order_by("-created_at", "-id").values_list("created_at", "id")[: offset + page_size]:
                heads.append((at, -order[c], pk, c))
        heads.sort(reverse=True)
        picked = [(c, pk) for _at, _o, pk, c in heads[offset : offset + page_size]]

    details: dict[str, dict] = {}
    for c in wanted:
        ids = [pk for ch, pk in picked if ch == c]
        if not ids:
            continue
        if c == "whatsapp":
            details[c] = _wa_rows(ids, _wa_settings())
        elif c == "sms":
            details[c] = _sms_rows(ids, _sms_settings())
        else:
            details[c] = _email_rows(ids)
    items = [details[c][pk] for c, pk in picked if pk in details.get(c, {})]

    return envelope(
        {
            "channel": channel,
            "status": status,
            "purpose": purpose,
            "q": q,
            "items": items,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "pages": max(1, -(-total // page_size)),
            "statusCounts": counts,
            "channelCounts": {c: per_channel[c] for c in wanted},
        },
        period=period,
        provenance=[
            prov(
                "history",
                "Message history",
                dataset="WhatsApp, SMS and email logs (the Control pages' histories)",
                definition="Every message the HRMS tried to send in the period, newest first. Sent = accepted by the "
                "provider; delivered = WhatsApp's delivery or read tick; skipped = not sent on purpose (a limit, a "
                "switch, too late); waiting = still in the WhatsApp queue.",
                rows=total,
                filters=["Phone numbers and email addresses are masked; message text is not shown"],
                caveats=[
                    "The estimated cost of a WhatsApp message uses its pricing category's rate (WhatsApp Control); an "
                    "SMS uses the price per SMS (SMS Control); email has no charge."
                ],
            )
        ],
    )


# ── the assistant's tools (registered by the integrator through assistant/registry.TOOL_MODULES) ───────────────

_MONTH_PARAM = {"month": string_param("Month as YYYY-MM; blank = this month.")}


def _tool_overview(month: str | None = None) -> dict:
    return overview(month or None, MONTHS_DEFAULT)


def _tool_month(month: str | None = None, channel: str = "all") -> dict:
    return month_detail(month or None, channel or "all")


TOOLS = [
    tool(
        "comms_usage_overview",
        "WhatsApp, SMS and Gmail usage and cost for one month: messages sent per channel, failed, estimated cost (rupees "
        "before GST, from the rates set in WhatsApp Control and SMS Control; Gmail has no charge), the projection for "
        "the current month, budgets, the change against the month before and a 12-month series. Use for 'how much do "
        "we spend on WhatsApp/SMS', 'communication cost this month', 'how many messages did we send'.",
        _tool_overview,
        page="communications",
        scope=False,
        extra=_MONTH_PARAM,
        example={"month": ""},
    ),
    tool(
        "comms_month_breakdown",
        "One month's communication breakdown: messages and cost per day, per purpose (the HRMS module that sent them) "
        "and per message type, WhatsApp's pricing categories and Meta's own cost figure when available. Use for "
        "'which messages cost the most', 'what was sent most', 'why did SMS cost rise'.",
        _tool_month,
        page="communications",
        scope=False,
        extra={
            **_MONTH_PARAM,
            "channel": string_param("Channel.", enum=list(CHANNEL_CHOICES)),
        },
        defaults={"channel": "all"},
        example={"month": "", "channel": "all"},
    ),
]
