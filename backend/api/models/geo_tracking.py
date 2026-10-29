"""On-Duty Geo-Tracking: our own location tracking for employees working off-site.

Seven tables (all new; the only change to an existing table is OnDutyPunchVerification.photo2, in attendance.py):
  GeoTrackingSettings   singleton (pk=1): the thresholds of the journey pipeline, the upload cadence the apps follow,
                        retention, the day-end time, how many photos an on-duty punch takes, the privacy notice
  DutyTrack             ONE tracking session per On-Duty request (OneToOne to OnDutySession). Starts when the request is
                        submitted, ends only through geo_tracking.sessions.end_track. Carries the live snapshot (the Live
                        Map reads it) and the summary the pipeline rebuilds
  DutyTrackPoint        the raw GPS feed and the travel history (one row per recorded fix; the largest table)
  DutyTrackEvent        connectivity / integrity / lifecycle events (GPS off, network lost, app killed, fake GPS, ...)
  DutyTrackSegment      DERIVED history (travel | stop | gap), rebuilt idempotently from points + events by the pipeline.
                        The "stationary / waiting periods" are the kind='stop' rows. Kept after the raw rows are purged
  TrackingDevice        the phone an employee tracks from: model, app version, permission level, health, last seen
  TrackingConsent       a record that the employee saw and accepted the tracking notice

Every time column is a timezone-aware UTC instant. Coordinates are DecimalField(9, 6) like every other geo table here.
The behaviour lives in api/geo_tracking/ (settings, sessions, ingest, journey pipeline, live state, views, scheduler job).
"""

from datetime import time

from django.db import models
from django.db.models import Q
from django.db.models.functions import Now
from django.utils import timezone

from .accounts import HRUser
from .attendance import OnDutySession
from .core import Branch, Employee

DEFAULT_NOTICE_TEXT = (
    "While you are on On-Duty work, the UKTextiles app records your location in the background: the route you take, "
    "the places where you stop for more than a few minutes, and when your phone's location, network or battery state "
    "changes. Recording starts when you submit an On-Duty request and ends when you mark the duty Done, when your 4th "
    "On-Duty punch is captured, when the request is rejected, or automatically at the end of the day. HR can see this "
    "journey history. Nothing is recorded outside an active On-Duty request."
)


class GeoTrackingSettings(models.Model):
    """The one settings row (pk=1; GeoTrackingSettings.get() creates it). The numbers are the journey pipeline's
    parameters (geo_tracking/journey.py), the cadence the apps follow (sent to them in /tracking/state and /tracking/batch),
    and the policy switches. Ranges are enforced on write by geo_tracking/settings.py, not by the database."""

    REVERSE_GEOCODE_OFF = "off"
    REVERSE_GEOCODE_NOMINATIM = "nominatim"
    REVERSE_GEOCODE_CHOICES = ((REVERSE_GEOCODE_OFF, "Off"), (REVERSE_GEOCODE_NOMINATIM, "OpenStreetMap Nominatim"))

    enabled = models.BooleanField(default=True, db_default=True)
    #: a stop = the phone stays within the stop radius for at least this long
    stop_seconds = models.PositiveIntegerField(default=180, db_default=180)
    stop_radius_m = models.PositiveIntegerField(default=50, db_default=50)
    #: the stop radius is max(stop_radius_m, factor x the run's median GPS accuracy)
    stop_accuracy_factor = models.FloatField(default=2.0, db_default=2.0)
    #: two stops at the same place closer in time than this are one stop
    merge_stop_gap_seconds = models.PositiveIntegerField(default=120, db_default=120)
    #: no point for longer than this (and not inside a stop) = a gap
    gap_seconds = models.PositiveIntegerField(default=300, db_default=300)
    #: an ACTIVE track with no data for this long is "offline" (a SIGNAL_LOST event)
    signal_lost_seconds = models.PositiveIntegerField(default=600, db_default=600)
    #: a fix less accurate than this is dropped by the pipeline (it is kept as a raw row)
    max_accuracy_m = models.PositiveIntegerField(default=100, db_default=100)
    #: a jump faster than this between two fixes is a GPS glitch (teleport) and is dropped
    max_speed_kmh = models.PositiveIntegerField(default=200, db_default=200)
    #: a fix every 3 s while moving: at 40 km/h that is about one every 35 m, so the drawn route follows the corners of the
    #: road (every 10 s left 80-130 m between fixes and the line cut across the blocks)
    sample_moving_seconds = models.PositiveIntegerField(default=3, db_default=3)
    #: a fix at least this often while the phone is still (a heartbeat when it has not moved): 60 s gives a 3-minute stop
    #: three fixes, and the phone notices a departure within a minute (every 300 s left a stop one or two fixes and the
    #: start of the next ride up to five minutes late)
    sample_still_seconds = models.PositiveIntegerField(default=60, db_default=60)
    distance_filter_m = models.PositiveIntegerField(default=10, db_default=10)
    upload_batch_points = models.PositiveIntegerField(default=30, db_default=30)
    upload_interval_seconds = models.PositiveIntegerField(default=60, db_default=60)
    #: raw points and events older than this are purged; segments and the summary are kept
    retention_days = models.PositiveIntegerField(default=365, db_default=365)
    #: the automatic close of On-Duty sessions (and so of their tracks), IST
    day_end_time = models.TimeField(default=time(23, 50), db_default=time(23, 50))
    #: how many photos an On-Duty punch takes (1 until the new app is out; HR then flips it to 2)
    onduty_punch_photos = models.PositiveSmallIntegerField(default=1, db_default=1)
    notice_version = models.PositiveIntegerField(default=1, db_default=1)
    notice_text = models.TextField(default=DEFAULT_NOTICE_TEXT, db_default=DEFAULT_NOTICE_TEXT)
    reverse_geocode_provider = models.CharField(
        max_length=12, choices=REVERSE_GEOCODE_CHOICES, default=REVERSE_GEOCODE_OFF, db_default=REVERSE_GEOCODE_OFF
    )
    updated_by = models.ForeignKey(HRUser, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    updated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "geo_tracking_settings"

    @classmethod
    def get(cls) -> "GeoTrackingSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class DutyTrack(models.Model):
    STATUS_ACTIVE = "active"
    STATUS_ENDED = "ended"
    STATUS_CHOICES = ((STATUS_ACTIVE, "Active"), (STATUS_ENDED, "Ended"))

    END_MANUAL = "manual"
    END_AUTO_4TH_PUNCH = "auto_4th_punch"
    END_AUTO_DAY_END = "auto_day_end"
    END_REJECTED = "rejected"
    END_ADMIN = "admin"
    END_REASON_CHOICES = (
        (END_MANUAL, "Employee marked Done"),
        (END_AUTO_4TH_PUNCH, "4th punch captured"),
        (END_AUTO_DAY_END, "Day ended automatically"),
        (END_REJECTED, "Request rejected"),
        (END_ADMIN, "Ended by an administrator"),
    )

    STATE_WAITING = "waiting_first_fix"
    STATE_MOVING = "moving"
    STATE_STATIONARY = "stationary"
    STATE_OFFLINE = "offline"
    STATE_LOCATION_OFF = "location_off"
    STATE_ENDED = "ended"
    STATE_CHOICES = (
        (STATE_WAITING, "Waiting for the first fix"),
        (STATE_MOVING, "Moving"),
        (STATE_STATIONARY, "Stationary"),
        (STATE_OFFLINE, "Offline"),
        (STATE_LOCATION_OFF, "Location off"),
        (STATE_ENDED, "Ended"),
    )

    session = models.OneToOneField(OnDutySession, on_delete=models.CASCADE, related_name="track")
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="duty_tracks")
    #: the employee's branch when the request was made (kept if they move later)
    branch = models.ForeignKey(Branch, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=STATUS_ACTIVE, db_default=STATUS_ACTIVE)
    started_at = models.DateTimeField(default=timezone.now, db_default=Now())
    ended_at = models.DateTimeField(null=True, blank=True)
    end_reason = models.CharField(max_length=16, choices=END_REASON_CHOICES, blank=True, default="", db_default="")

    # ── live snapshot (updated by every batch and by the scheduler's watchdog) ──
    state = models.CharField(max_length=20, choices=STATE_CHOICES, default=STATE_WAITING, db_default=STATE_WAITING)
    state_since = models.DateTimeField(null=True, blank=True)
    last_point_at = models.DateTimeField(null=True, blank=True)
    last_latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    last_longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    last_accuracy_m = models.FloatField(null=True, blank=True)
    last_battery_pct = models.SmallIntegerField(null=True, blank=True)
    last_network = models.CharField(max_length=12, blank=True, default="", db_default="")
    last_device_id = models.CharField(max_length=64, blank=True, default="", db_default="")

    # ── counters (F() updates under the row lock, never recomputed by the pipeline) ──
    points_count = models.PositiveIntegerField(default=0, db_default=0)
    events_count = models.PositiveIntegerField(default=0, db_default=0)
    mock_points = models.PositiveIntegerField(default=0, db_default=0)

    # ── summary (rebuilt by geo_tracking.journey.rebuild) ──
    distance_m = models.FloatField(default=0, db_default=0)
    travel_s = models.PositiveIntegerField(default=0, db_default=0)
    stop_s = models.PositiveIntegerField(default=0, db_default=0)
    gap_s = models.PositiveIntegerField(default=0, db_default=0)
    stop_count = models.PositiveIntegerField(default=0, db_default=0)
    longest_stop_s = models.PositiveIntegerField(default=0, db_default=0)
    max_speed_kmh = models.FloatField(default=0, db_default=0)
    first_point_at = models.DateTimeField(null=True, blank=True)
    #: the end of the last segment the pipeline summarised
    summary_through = models.DateTimeField(null=True, blank=True)
    rebuilt_at = models.DateTimeField(null=True, blank=True)
    flags = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_default=Now())

    class Meta:
        db_table = "duty_tracks"
        constraints = [
            # one live track per employee: a second request cannot start while the first still records
            models.UniqueConstraint(
                fields=["employee"], condition=Q(status="active"), name="uniq_active_duty_track_per_employee"
            ),
        ]
        indexes = [
            models.Index(fields=["employee", "-started_at"], name="duty_track_emp_started"),
            models.Index(fields=["status"], name="duty_track_status"),
            models.Index(fields=["started_at"], name="duty_track_started"),
            models.Index(fields=["branch", "started_at"], name="duty_track_branch_started"),
        ]

    def __str__(self) -> str:
        return f"track {self.pk} ({self.status})"


class DutyTrackPoint(models.Model):
    """One recorded GPS fix. The unique (employee, device_id, seq) is the idempotency key: the app numbers every point
    and event with one device-wide counter, re-sends what the server has not acknowledged, and the duplicates are dropped
    by ``bulk_create(ignore_conflicts=True)``."""

    ACTIVITIES = ("still", "walking", "running", "vehicle", "bicycle", "unknown")
    NETWORKS = ("wifi", "cell", "none", "unknown")
    PROVIDERS = ("gps", "fused", "network", "passive", "unknown")

    id = models.BigAutoField(primary_key=True)
    track = models.ForeignKey(DutyTrack, on_delete=models.CASCADE, related_name="points")
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="+")
    device_id = models.CharField(max_length=64)
    seq = models.BigIntegerField()
    #: when the device recorded it (UTC)
    recorded_at = models.DateTimeField()
    received_at = models.DateTimeField(default=timezone.now, db_default=Now())
    latitude = models.DecimalField(max_digits=9, decimal_places=6)
    longitude = models.DecimalField(max_digits=9, decimal_places=6)
    accuracy_m = models.FloatField(default=0, db_default=0)
    speed_mps = models.FloatField(null=True, blank=True)
    bearing_deg = models.FloatField(null=True, blank=True)
    altitude_m = models.FloatField(null=True, blank=True)
    activity = models.CharField(max_length=12, default="unknown", db_default="unknown")
    battery_pct = models.SmallIntegerField(null=True, blank=True)
    charging = models.BooleanField(null=True, blank=True)
    network = models.CharField(max_length=12, default="unknown", db_default="unknown")
    provider = models.CharField(max_length=12, default="unknown", db_default="unknown")
    is_mock = models.BooleanField(default=False, db_default=False)
    #: the device clock was far from the server's when this was sent
    time_suspect = models.BooleanField(default=False, db_default=False)

    class Meta:
        db_table = "duty_track_points"
        constraints = [
            models.UniqueConstraint(fields=["employee", "device_id", "seq"], name="uniq_track_point_device_seq"),
        ]
        indexes = [
            models.Index(fields=["track", "recorded_at"], name="track_point_track_rec"),
            models.Index(fields=["employee", "recorded_at"], name="track_point_emp_rec"),
        ]


class DutyTrackEvent(models.Model):
    KIND_TRACKING_STARTED = "TRACKING_STARTED"
    KIND_TRACKING_STOPPED = "TRACKING_STOPPED"
    KIND_GPS_OFF = "GPS_OFF"
    KIND_NETWORK_LOST = "NETWORK_LOST"
    KIND_AIRPLANE_ON = "AIRPLANE_ON"
    KIND_POWER_SAVE_ON = "POWER_SAVE_ON"
    KIND_PERMISSION_CHANGED = "PERMISSION_CHANGED"
    KIND_LOW_BATTERY = "LOW_BATTERY"
    KIND_MOCK_LOCATION = "MOCK_LOCATION"
    KIND_CLOCK_CHANGED = "CLOCK_CHANGED"
    KIND_APP_RESTARTED = "APP_RESTARTED"
    KIND_APP_KILLED = "APP_KILLED"
    KIND_DEVICE_SHUTDOWN = "DEVICE_SHUTDOWN"
    KIND_DEVICE_BOOT = "DEVICE_BOOT"
    KIND_BACKGROUND_RESTRICTED = "BACKGROUND_RESTRICTED"
    KIND_SIGNAL_LOST = "SIGNAL_LOST"
    KIND_SERVER_NOTE = "SERVER_NOTE"

    #: interval kinds: stored with started_at, closed (ended_at) by the matching END kind
    INTERVAL_KINDS = (KIND_GPS_OFF, KIND_NETWORK_LOST, KIND_AIRPLANE_ON, KIND_POWER_SAVE_ON, KIND_SIGNAL_LOST)
    #: END kind -> the interval kind it closes. These are never stored as their own row.
    END_KINDS = {
        "GPS_ON": KIND_GPS_OFF,
        "NETWORK_RESTORED": KIND_NETWORK_LOST,
        "AIRPLANE_OFF": KIND_AIRPLANE_ON,
        "POWER_SAVE_OFF": KIND_POWER_SAVE_ON,
    }
    #: kinds a phone may send (SIGNAL_LOST and SERVER_NOTE are made by the server only)
    DEVICE_KINDS = (
        KIND_TRACKING_STARTED,
        KIND_TRACKING_STOPPED,
        KIND_GPS_OFF,
        KIND_NETWORK_LOST,
        KIND_AIRPLANE_ON,
        KIND_POWER_SAVE_ON,
        KIND_PERMISSION_CHANGED,
        KIND_LOW_BATTERY,
        KIND_MOCK_LOCATION,
        KIND_CLOCK_CHANGED,
        KIND_APP_RESTARTED,
        KIND_APP_KILLED,
        KIND_DEVICE_SHUTDOWN,
        KIND_DEVICE_BOOT,
        KIND_BACKGROUND_RESTRICTED,
    )
    ALL_KINDS = DEVICE_KINDS + (KIND_SIGNAL_LOST, KIND_SERVER_NOTE)
    SOURCE_DEVICE = "device"
    SOURCE_SERVER = "server"

    track = models.ForeignKey(DutyTrack, on_delete=models.CASCADE, related_name="events")
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="+")
    device_id = models.CharField(max_length=64, blank=True, default="", db_default="")
    #: the device-wide counter it shares with the points (null for events the server makes)
    seq = models.BigIntegerField(null=True, blank=True)
    kind = models.CharField(max_length=24)
    source = models.CharField(max_length=8, default=SOURCE_DEVICE, db_default=SOURCE_DEVICE)
    started_at = models.DateTimeField()
    #: interval events: null while open, set when the matching END event (or the end of the track) closes it
    ended_at = models.DateTimeField(null=True, blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    meta = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_default=Now())

    class Meta:
        db_table = "duty_track_events"
        constraints = [
            models.UniqueConstraint(
                fields=["employee", "device_id", "seq"],
                condition=Q(seq__isnull=False),
                name="uniq_track_event_device_seq",
            ),
        ]
        indexes = [
            models.Index(fields=["track", "started_at"], name="track_event_track_start"),
            models.Index(fields=["track", "kind"], name="track_event_track_kind"),
        ]


class DutyTrackSegment(models.Model):
    KIND_TRAVEL = "travel"
    KIND_STOP = "stop"
    KIND_GAP = "gap"
    KIND_CHOICES = ((KIND_TRAVEL, "Travel"), (KIND_STOP, "Stop"), (KIND_GAP, "Gap"))
    #: why there is no data in a gap
    CAUSES = (
        "gps_off",
        "network_lost",
        "app_killed",
        "device_shutdown",
        "permission",
        "power_save",
        "signal_lost",
        "unknown",
    )

    track = models.ForeignKey(DutyTrack, on_delete=models.CASCADE, related_name="segments")
    seq_no = models.PositiveIntegerField()
    kind = models.CharField(max_length=8, choices=KIND_CHOICES)
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField()
    duration_s = models.PositiveIntegerField(default=0, db_default=0)
    #: travel only (0 otherwise): the sum of the haversine distances of consecutive cleaned fixes
    distance_m = models.FloatField(default=0, db_default=0)
    start_lat = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    start_lng = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    end_lat = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    end_lng = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    #: stop only: the median position of the stop
    center_lat = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    center_lng = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    radius_m = models.FloatField(null=True, blank=True)
    point_count = models.PositiveIntegerField(default=0, db_default=0)
    avg_speed_kmh = models.FloatField(default=0, db_default=0)
    max_speed_kmh = models.FloatField(default=0, db_default=0)
    #: travel only: Ramer-Douglas-Peucker simplified [[lat, lng], ...], at most 400 vertices
    polyline = models.JSONField(default=list, blank=True)
    #: stop only: filled by the optional reverse-geocode worker
    address = models.TextField(blank=True, default="", db_default="")
    #: gap only (a stop has '')
    cause = models.CharField(max_length=20, blank=True, default="", db_default="")
    #: partly inferred (a gap inside a stop, a stop from 'still' activity, a leading/trailing gap)
    estimated = models.BooleanField(default=False, db_default=False)
    event = models.ForeignKey(DutyTrackEvent, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    meta = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_default=Now())

    class Meta:
        db_table = "duty_track_segments"
        constraints = [
            models.UniqueConstraint(fields=["track", "seq_no"], name="uniq_track_segment_seq"),
        ]
        indexes = [
            models.Index(fields=["track", "started_at"], name="track_segment_track_start"),
        ]


class TrackingDevice(models.Model):
    PERMISSION_LEVELS = ("always", "while_using", "denied", "unknown")

    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="tracking_devices")
    device_id = models.CharField(max_length=64)
    platform = models.CharField(max_length=16, blank=True, default="", db_default="")
    os_version = models.CharField(max_length=32, blank=True, default="", db_default="")
    model = models.CharField(max_length=64, blank=True, default="", db_default="")
    app_version = models.CharField(max_length=32, blank=True, default="", db_default="")
    permission_level = models.CharField(max_length=12, default="unknown", db_default="unknown")
    location_enabled = models.BooleanField(null=True, blank=True)
    background_restricted = models.BooleanField(null=True, blank=True)
    battery_optimised = models.BooleanField(null=True, blank=True)
    power_save = models.BooleanField(null=True, blank=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)
    last_battery_pct = models.SmallIntegerField(null=True, blank=True)
    last_network = models.CharField(max_length=12, blank=True, default="", db_default="")
    last_heartbeat_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_default=Now())

    class Meta:
        db_table = "tracking_devices"
        constraints = [
            models.UniqueConstraint(fields=["employee", "device_id"], name="uniq_tracking_device_per_employee"),
        ]


class TrackingConsent(models.Model):
    """The employee saw the tracking notice (version `notice_version`) and accepted it, on `device_id`. Append-only:
    a new notice version needs a new consent, the old ones stay as the record of what was accepted when."""

    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name="tracking_consents")
    device_id = models.CharField(max_length=64, blank=True, default="", db_default="")
    notice_version = models.PositiveIntegerField()
    accepted_at = models.DateTimeField(default=timezone.now, db_default=Now())
    ip = models.CharField(max_length=45, blank=True, default="", db_default="")
    created_at = models.DateTimeField(default=timezone.now, db_default=Now())

    class Meta:
        db_table = "tracking_consents"
        indexes = [
            models.Index(fields=["employee", "notice_version"], name="tracking_consent_emp_ver"),
        ]
