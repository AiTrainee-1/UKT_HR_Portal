"""A page's brief: the headline figures and the exceptions of the analytics module behind one MD page, in one call.

Every analytics module exports ``headline(*, today=None)`` (its cards) and ``insights(*, today=None)`` (its exceptions): see
md-portal.md section 3. This puts the two together for the strip that sits above each page and for the page's Insights
section, so a page needs nothing more than its module to show them. A module that is missing or fails costs that page its
brief (and says so in ``notes``), never an error page."""

from __future__ import annotations

import importlib
import logging
from datetime import date

from ..common import MdParamError, cached, envelope
from ..pages import PAGE_BY_ID

logger = logging.getLogger(__name__)


def _call(module, name: str, today: date | None):
    fn = getattr(module, name, None)
    return fn(today=today) if callable(fn) else None


@cached()
def page_brief(page: str, today: date | None = None) -> dict:
    meta = PAGE_BY_ID.get(page)
    if meta is None:
        raise MdParamError(f"Unknown page '{page}'.")
    domain = meta.get("domain")
    base = {"page": page, "title": meta["title"], "domain": domain, "kpis": [], "insights": []}
    if not domain:
        return envelope(base)

    notes: list[str] = []
    provenance: list[dict] = []
    path = f"{__package__}.{domain}"
    try:
        module = importlib.import_module(path)
    except ModuleNotFoundError as exc:
        if exc.name != path:  # a real missing import inside the module is a bug: say so, with the traceback
            logger.exception("MD brief: analytics module %s could not be loaded", domain)
        else:  # the module is simply not written yet: a plain line, not a traceback on every page view
            logger.info("MD brief: there is no analytics module %s yet", domain)
        return envelope(base, notes=[f"The figures for {meta['title']} are not available right now."])
    except Exception:  # noqa: BLE001 -- one module that cannot load must not take the page down
        logger.exception("MD brief: analytics module %s could not be loaded", domain)
        return envelope(base, notes=[f"The figures for {meta['title']} are not available right now."])

    try:
        headline = _call(module, "headline", today) or {}
        base["kpis"] = list(headline.get("kpis") or [])
        provenance = list(headline.get("provenance") or [])
    except Exception:  # noqa: BLE001
        logger.exception("MD brief: %s.headline failed", domain)
        notes.append("The headline figures could not be worked out right now.")
    try:
        base["insights"] = list(_call(module, "insights", today) or [])
    except Exception:  # noqa: BLE001
        logger.exception("MD brief: %s.insights failed", domain)
        notes.append("The exceptions could not be worked out right now.")
    return envelope(base, provenance=provenance, notes=notes)
