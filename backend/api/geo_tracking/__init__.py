"""On-Duty Geo-Tracking (our own tracking system; the tables are in api/models/geo_tracking.py).

  settings    the GeoTrackingSettings accessor, the camelCase shape the API speaks, and the write validation
  sessions    start_track / end_track: the track's lifecycle, tied to the On-Duty session's
  ingest      POST /api/tracking/batch: validation, idempotent bulk insert, event pairing, snapshot, counters
  journey     the pipeline: raw fixes + events -> cleaned fixes -> stops, gaps, travel -> summary (pure functions) and
              rebuild(track), which persists it idempotently
  live        the live state of a track (moving / stationary / offline / location_off / ...) and the Live Map rows
  serializers the JSON shapes (camelCase) shared by the employee and HR views
  views / hr_views / export   the HTTP layer (employee, HR + settings, the Excel/CSV export)
  watchdog    the scheduler's jobs (signal lost, orphan tracks, retention purge, the reverse-geocode worker)
  geocode     the optional reverse geocoder (off by default; never called inside a request)
  background  runs a job in a thread (inline under the test runner, so tests never start threads)

The scheduler itself is api/geo_tracking_scheduler.py (same pattern as on_duty_day_end_scheduler.py).
"""
