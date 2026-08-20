# Biometric Integration -UKTextiles HRMS

Two independent integration paths exist in the codebase today, and both can be used at once for different devices. Read the "Which path is actually running today" box first if you just need to know what's live right now.

---

## Which path is actually running today

The **Settings → Devices** page currently has an entry configured as:

```
Device Name:  HO
Type:         aiface_mars
Host/IP:      192.168.0.61
Port:         4370
Comm Pass:    ****
```

That `Host/IP` + `Port 4370` shape means this device is wired up on the **Pull** path (below), not Push -Django connects out to the device and asks for records, the same way it always has for the older eSSL terminals. The device type is labelled "AiFace-Mars" in the dropdown (that's the only device-type option in the current schema, `Employee.DEVICE_TYPE_CHOICES` in `backend/api/models.py`), but the actual wire protocol used for polling is still the ZKTeco/ICLOCK protocol via `pyzk`, over TCP port 4370 -identical to how the original eSSL e2008 devices were integrated.

So: **Pull is the live, working path for every device configured in Settings → Devices today**, including the AiFace-Mars unit. The Push endpoint (`POST /api/biometric/punch`) also exists in the code and is reachable, but nothing is currently configured to call it.

---

## Path 1 -Pull (Django connects to the device)

**Protocol:** ZKTeco/ICLOCK over TCP port 4370, via the `pyzk` Python library
**Where it lives:** `backend/api/biometric_sync.py`, `backend/api/management/commands/sync_biometric.py`

```
┌────────────────┐   ZK Protocol / TCP 4370   ┌──────────────────────────┐
│  Biometric      │ ◀──────────────────────────  │  Django Server           │
│  device (LAN)   │   "give me attendance logs" │  sync_biometric command  │
│  192.168.0.X     │ ──────────────────────────▶  │                          │
│                  │   returns punch records      │  writes to attendance_   │
└──────────────────┘                              │  logs + attendance tables│
                                                    └──────────────────────────┘

Both on the same LAN -no internet, no HTTPS needed for this path.
```

Django asks the device for records on a schedule (or on demand). This is safe and simple because the device and server are on the same private LAN -nobody outside the factory network can see this traffic, and it's a direct TCP connection, not HTTP at all.

### Device setup

1. **Find the device's IP** -on the device: `Main Menu → COMM. → Ethernet → IP Address`. If it shows `0.0.0.0`, set a static IP (e.g. `192.168.0.101`, subnet `255.255.255.0`, gateway = your router's IP).
2. **Confirm it's reachable** from the server machine: `ping 192.168.0.101`. If that fails, check the LAN cable, confirm same switch/router, and check Windows Firewall isn't blocking port 4370.
3. **Register it** in **Settings → Devices** (Host/IP, Port `4370`, Comm Password -the device's communication password, default `0` unless changed under `Main Menu → COMM. → PC Connection → Password`). Multiple devices can be registered and synced together, or individually.
4. Older/legacy setups can instead use a single device via `.env` (`BIOMETRIC_DEVICE_IP` / `BIOMETRIC_DEVICE_PORT` / `BIOMETRIC_DEVICE_PASSWORD`) -both sources are merged automatically by `get_sync_targets()`.

### Employee ↔ device linking

The link is the **employee code**. The "User ID" enrolled on the device must exactly match `employee_code` in the HR Portal.

- **New employee:** add them in HR Portal first (note the code), then enroll them on the device with **User ID = that same code**, then capture their face.
- **Already-enrolled devices:** export the device's user list (`Main Menu → Data Mgt. → Export` to USB), compare `User ID`s against HR Portal employee codes, and reconcile mismatches -either add the missing employee in HR Portal with that exact code, or edit the employee's code to match. Running `sync_biometric --all` and reading its "no matching employee" warnings is the fastest way to find every mismatch at once.

### Syncing

```bash
python manage.py sync_biometric --today     # today's records (fast, frequent use)
python manage.py sync_biometric --days 3     # last 3 days
python manage.py sync_biometric --all        # every record on the device (first-time import only)
python manage.py sync_biometric --device-id <n>   # one specific Settings device
python manage.py sync_biometric --device-id env   # only the .env-configured device
```

- **Automatic schedule:** APScheduler (started in `apps.py` on Django boot) runs a sync at **7:30 AM** and **8:30 PM IST** by default, pulling every enabled source. Additional custom schedules can be added per-device via **Auto Sync Rules** on the Attendance page.
- **Manual, on demand:** the **Auto Sync** button on the Dashboard and Attendance pages calls `POST /api/attendance/sync-biometric` and refreshes every attendance query.
- One failing device never blocks the others -sync results are reported per-device.

### What gets written

| Table | What it stores |
|---|---|
| `attendance_logs` | One row per punch (employee, date, time, IN/OUT, `source="biometric:<device>"`) -the input every downstream engine reads from |
| `attendance` | Legacy daily present-flag summary, still touched for manual one-off entries |

From there, the shared attendance engine (`attendance_final.py`) turns raw punches into the day's final status, and payroll reads that -see `backend.md` for the full engine mechanics.

### Troubleshooting (Pull)

| Symptom | Fix |
|---|---|
| `Connection refused` / can't connect | Confirm device IP (`Main Menu → COMM. → Ethernet`), `ping` it from the server, allow TCP 4370 through Windows Firewall |
| `pyzk is not installed` | `pip install pyzk` (already in `requirements.txt`, so a normal install picks it up) |
| Employees show "not found" during sync | Device User ID doesn't match any `employee_code` -see the reconciliation steps above |
| Records created but nothing shows on the Attendance page | The employee's status is `inactive` in HR Portal -activate them |
| Punches have wrong timestamps | Fix the device clock (`Main Menu → System → Date Time`, timezone `+05:30`), then re-sync that day |
| `Invalid password` | Set the device's actual Comm Password in Settings → Devices / `.env` |

---

## Path 2 -Push (the device calls Django)

**Endpoint:** `POST /api/biometric/punch`
**Where it lives:** `backend/api/attendance_views.py` (`biometric_punch`)

```
Employee Face
     ↓
Device (HTTP Push mode)
     ↓  HTTP POST
POST /api/biometric/punch
     ↓
AttendanceLog table (PostgreSQL)
```

Nothing is currently configured to send to this endpoint, but it's live and reachable if a device (or a script) is pointed at it.

### Device configuration (if enabling this path)

On the device: `Menu → Communication → HTTP Push Settings`

| Field | Value |
|---|---|
| Enable Push | Yes |
| Push URL | `http://<server-ip>:8000/api/biometric/punch` |
| Push Method | POST |
| Content-Type | `application/json` |
| Custom Header | `X-Device-Key: <your BIOMETRIC_API_KEY>` |
| Push Interval | Realtime (or 1 minute) |
| Push on Event | Check-In + Check-Out |

**Set a strong `BIOMETRIC_API_KEY` in `.env`** -this header is the only thing standing between the endpoint and an unauthenticated punch injection.

### Payload

```json
{
  "personId": "EMP001",
  "devSN": "MARS-2024-0012",
  "time": "2026-06-26T09:15:00",
  "eventType": 0
}
```

`eventType`: `0` = Check-In, `1` = Check-Out. Alternate field names accepted for compatibility: `employeeCode` (for `personId`), `punchTime` (for `time`), `deviceId` (for `devSN`).

**Response (201):**
```json
{ "ok": true, "logId": 4821, "employee": "Rajesh Kumar", "punchType": "IN", "punchTime": "09:15:00", "date": "2026-06-26" }
```

### Security checklist if this path is turned on

- [ ] Change `BIOMETRIC_API_KEY` from any default to a strong random value
- [ ] Use HTTPS in production (the reverse proxy handles this -see `deployment-guide.md`)
- [ ] Restrict `/api/biometric/punch` to the device's IP at the firewall/reverse-proxy level if possible
- [ ] Periodically audit `AttendanceLog.source` for unexpected values

---

## Manual entry (always available, either path)

For a device outage or a punch the device missed (verified via CCTV, say):

```
POST /api/attendance/manual
Authorization: Bearer <hr-jwt-token>
Body: { employeeId, date, punchTime, punchType, notes, hoursWorked }
```

Surfaced in the UI as the **Add Attendance** button on the Attendance page. Also see **Missing Punch** (employee-submitted correction requests, HOD/HR approval) and **Manual Punch Import** (bulk Excel import) for the other two manual-entry paths described in `backend.md`.

---

## Possible future enhancement -ADMS / HTTPS Push (not implemented)

The AiFace-Mars unit is capable of a third mode: **ADMS** (its cloud-server protocol), which pushes over HTTPS to a domain rather than a local IP:port. A device seen configured this way showed:

```
Server Mode:       ADMS
Enable Domain:     ON
Server Address:    hrms.uktextiles.in
Enable Proxy:      OFF
HTTPS:             ON
```

This is a **different wire protocol from Path 2 above** -ADMS/eSSL cloud-server devices POST to their own expected paths (commonly something like `/iclock/cdata`), not a plain JSON body at an arbitrary URL, and the request shape is proprietary to the ADMS spec rather than a simple REST payload. **Nothing in this codebase currently implements an ADMS-compatible endpoint** -`/api/biometric/punch` (Path 2) uses a different, simpler JSON contract that this device is not sending.

If this is worth building later, the recommended approach is:
1. Confirm `hrms.uktextiles.in` actually reaches this Django deployment (it does, once deployed per `deployment-guide.md` -Nginx/Cloudflare Tunnel already route that hostname to Django).
2. Temporarily log every incoming request path/body at the Nginx or Django level, trigger one test punch on the device, and read exactly what path and payload the specific AiFace-Mars firmware sends.
3. Implement a parser for that specific request shape as a new endpoint (not necessarily `/api/biometric/punch` -whatever path the device actually calls), reusing the same underlying punch-ingestion logic Path 2 already has.

Until that's built, **Path 1 (Pull, Settings → Devices) remains the correct, working way to configure this device** -it should not be switched to ADMS/HTTPS mode expecting it to work, since nothing on the server side understands that protocol yet.
