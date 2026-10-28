"""Endpoint Sharing: API endpoints the super administrator creates to expose SELECTED HRMS data to other applications.

Four tables (all new, nothing existing is touched):
  SharedEndpoint            one public address /api/shared/<slug>, the dataset it serves, the exact field list, locked
                            filters and limits
  SharedEndpointOrigin      the browser origins allowed to call it
  SharedEndpointKey         its API keys: ONLY the SHA-256 of a key is stored, the key itself never is. A key carries a
                            data CATEGORY (staff | production) that every call is restricted to, and either an expiry
                            moment or none (a permanent key)
  SharedEndpointAccessLog   one row per call (90 days), the audit trail of what left the system

The behaviour lives in api/shared_endpoint_views.py (public call), api/shared_endpoint_admin_views.py (management) and
api/shared_datasets.py (the catalog of what may ever be shared).
"""

from django.db import models
from django.utils import timezone


class SharedEndpoint(models.Model):
    #: lower-case letters, digits and hyphens, 3..60; immutable after create (it is the public address)
    slug = models.CharField(max_length=60, unique=True)
    name = models.CharField(max_length=100)
    description = models.TextField(blank=True, default="")
    #: key of a dataset in shared_datasets.DATASETS; immutable after create
    dataset = models.CharField(max_length=40)
    #: ordered list of field keys of the dataset: the ONLY fields the public call returns (order = response order)
    fields = models.JSONField(default=list)
    #: {filter key: value} the caller can never override (stored as text, validated against the dataset's filters)
    locked_filters = models.JSONField(default=dict, blank=True)
    #: may a call WITHOUT an Origin header (a server, curl) be served? Calls with an Origin must be allow-listed
    allow_no_origin = models.BooleanField(default=True)
    page_size_default = models.PositiveIntegerField(default=50)
    page_size_max = models.PositiveIntegerField(default=200)
    rate_limit_per_minute = models.PositiveIntegerField(default=60)
    #: True by default: a new endpoint still exposes nothing until it has a key
    enabled = models.BooleanField(default=True)
    created_by = models.CharField(max_length=150, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "shared_endpoints"
        ordering = ["id"]


class SharedEndpointOrigin(models.Model):
    endpoint = models.ForeignKey(SharedEndpoint, on_delete=models.CASCADE, related_name="origins")
    #: lower-case scheme://host[:port], validated by shared_endpoint_admin_views.normalize_origin
    origin = models.CharField(max_length=255)

    class Meta:
        db_table = "shared_endpoint_origins"
        ordering = ["id"]
        constraints = [
            models.UniqueConstraint(fields=["endpoint", "origin"], name="uniq_shared_endpoint_origin"),
        ]


class SharedEndpointKey(models.Model):
    endpoint = models.ForeignKey(SharedEndpoint, on_delete=models.CASCADE, related_name="keys")
    label = models.CharField(max_length=100)
    #: the 8 characters after "uks_" (shown in the UI so a key can be recognised; not secret)
    prefix = models.CharField(max_length=8, db_index=True)
    #: SHA-256 hex of the FULL key. The key itself is never stored anywhere.
    key_hash = models.CharField(max_length=64, unique=True)
    created_by = models.CharField(max_length=150, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)
    #: the kind of employee this key may read: "staff" or "production" (Employee.employment_type), ENFORCED on every call
    #: (shared_datasets.apply_category). "" = a key made before categories existed: it stays unscoped (sees both) so no
    #: running integration breaks, and HR is told to revoke and recreate it. New keys always carry one of the two.
    #: db_default so the previous release (which does not know the column) can still insert a key during a rolling deploy.
    category = models.CharField(max_length=12, blank=True, default="", db_default="")
    #: NULL = a permanent key (never expires, until revoked); otherwise the moment it stops working
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    last_used_ip = models.CharField(max_length=45, blank=True, default="")

    class Meta:
        db_table = "shared_endpoint_keys"
        ordering = ["id"]


class SharedEndpointAccessLog(models.Model):
    #: SET_NULL: deleting an endpoint keeps what was served (the slug is copied below)
    endpoint = models.ForeignKey(SharedEndpoint, on_delete=models.SET_NULL, null=True, blank=True, related_name="logs")
    endpoint_slug = models.CharField(max_length=60, blank=True, default="")
    key = models.ForeignKey(SharedEndpointKey, on_delete=models.SET_NULL, null=True, blank=True, related_name="logs")
    at = models.DateTimeField(default=timezone.now)
    status = models.PositiveSmallIntegerField()
    rows = models.PositiveIntegerField(default=0)
    origin = models.CharField(max_length=255, blank=True, default="")
    ip = models.CharField(max_length=45, blank=True, default="")
    duration_ms = models.PositiveIntegerField(default=0)
    #: short machine code of the failure ("" for a 200): invalid_key, origin_not_allowed, rate_limited ...
    error = models.CharField(max_length=40, blank=True, default="")

    class Meta:
        db_table = "shared_endpoint_access_logs"
        ordering = ["-at", "-id"]
        indexes = [
            models.Index(fields=["endpoint", "at"], name="shared_log_endpoint_at"),
            models.Index(fields=["key", "at"], name="shared_log_key_at"),
            models.Index(fields=["at"], name="shared_log_at"),
        ]
