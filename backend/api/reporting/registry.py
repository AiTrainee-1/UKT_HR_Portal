"""The report registry: definitions register themselves here, views read from here."""

from __future__ import annotations

import importlib
import logging
import pkgutil

from .types import ReportSpec

logger = logging.getLogger(__name__)

_REGISTRY: dict[str, ReportSpec] = {}
_LOADED = False
# module name -> error, for definition modules that failed to import (a test asserts this stays empty).
LOAD_ERRORS: dict[str, str] = {}


def register(spec: ReportSpec) -> ReportSpec:
    if spec.id in _REGISTRY:
        raise ValueError(f"duplicate report id {spec.id!r}")
    _REGISTRY[spec.id] = spec
    return spec


def ensure_loaded() -> None:
    """Import every module in ``definitions`` once (each registers its reports at import)."""
    global _LOADED
    if _LOADED:
        return
    from . import definitions

    for mod in pkgutil.iter_modules(definitions.__path__):
        name = f"{definitions.__name__}.{mod.name}"
        try:
            importlib.import_module(name)
        except Exception as exc:  # one broken definition file must not take the whole Report Center down
            logger.exception("report definitions %s failed to load", name)
            LOAD_ERRORS[name] = f"{type(exc).__name__}: {exc}"
    _LOADED = True


def all_specs() -> list[ReportSpec]:
    ensure_loaded()
    return list(_REGISTRY.values())


def get_spec(report_id: str) -> ReportSpec | None:
    ensure_loaded()
    return _REGISTRY.get(report_id)
