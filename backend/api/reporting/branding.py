"""Company letterhead data for report headers (Excel + PDF)."""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass


@dataclass
class Company:
    name: str
    tagline: str
    address: str
    contact: str  # phone / email / website, joined
    gstin: str
    logo_png: bytes | None  # small PNG, or None


def _logo_png(data_url: str | None, max_px: int = 240) -> bytes | None:
    """Decode the stored data-URL logo into a size-capped PNG (None if absent or unreadable)."""
    if not data_url:
        return None
    try:
        from PIL import Image

        raw = base64.b64decode(data_url.split(",")[-1])
        img = Image.open(io.BytesIO(raw))
        img.load()
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        img.thumbnail((max_px, max_px), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="PNG", optimize=True)
        return out.getvalue()
    except Exception:
        return None


def company() -> Company:
    from api.models import PayrollSettings

    # Read-only: PayrollSettings.get() would INSERT the singleton on a database that has none, and a report
    # export is a GET (it must never write). Without a row the letterhead falls back to a plain name.
    ps = PayrollSettings.objects.filter(pk=1).first()
    if ps is None:
        return Company(name="UKTextiles", tagline="", address="", contact="", gstin="", logo_png=None)
    bits = [b for b in (ps.company_phone, ps.company_email, ps.company_website) if b]
    return Company(
        name=(ps.company_name or "UKTextiles").strip(),
        tagline=(ps.company_tagline or "").strip(),
        address=(ps.company_address or "").strip(),
        contact="  |  ".join(bits),
        gstin=(ps.company_gstin or "").strip(),
        logo_png=_logo_png(ps.company_logo),
    )
