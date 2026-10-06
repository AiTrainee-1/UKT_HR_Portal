# Biometric Integration -UKTextiles HRMS

Three ways exist for attendance to reach the server, and they can be used at once for different devices: **Pull** (Django connects to the device), **Push** (a script or device POSTs JSON to `/api/biometric/punch`) and **ADMS push** (the terminal's own Cloud Server mode, calling `/iclock/...`). **Attendance → Biometric Device Status** shows which devices are actually connected and, when one is not, why (see the last section). Read the "Which path is actually running today" box first if you just need to know what's live right now.

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

So: **Pull is the live, working path for every device in Settings → Devices that the server can reach over the LAN**, including the AiFace-Mars unit. A device set to **ADMS** (Cloud Server Setting) instead dials out to `api.uktextiles.in` and pushes its own attendance; that path is described under "ADMS push" below, and its health is what the Biometric Device Status page reports. The JSON Push endpoint (`POST /api/biometric/punch`) also exists, but nothing is configured to call it.

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

## Firewall setup -letting the cloud backend reach a device (Sophos XGS)

Needed only for the **Pull** path (Sync Biometric, Manual Import, Auto Sync
Rules). Push/ADMS does not need any of this -the device dials out, and an
outbound rule covers it.

The problem this solves: device IPs like `192.168.0.61` exist only inside the
factory LAN. The backend runs on Railway, in a datacentre, so it has no route
to them. A DNAT (port-forward) rule gives it one.

**Two directions, two separate rules -don't confuse them:**

```
OUTBOUND (device → internet)     needed for ADMS push
  192.168.0.61  →  WAN  →  api.uktextiles.in:443

INBOUND (internet → device)      needed for Pull / the three buttons
  Railway  →  WAN:<external port>  →  192.168.0.61:4370
```

Building the outbound rule does nothing for the inbound direction, and vice
versa.

### The one rule that makes multi-device work: unique external ports

**Every device listens on internal port 4370.** They cannot share an external
port, so each device needs its own. Pick a scheme and stick to it -e.g.
`14371, 14372, 14373 …` mapping in device order:

| Device | Internal (LAN) | External port | Portal Host/IP | Portal Port |
|---|---|---|---|---|
| HO | `192.168.0.61:4370` | 14371 | *your public IP/DDNS* | 14371 |
| Unit1 - 1 | `192.168.0.62:4370` | 14372 | *same public IP* | 14372 |
| Unit1 - 2 | `192.168.0.63:4370` | 14373 | *same public IP* | 14373 |
| Unit1 - 3 | `192.168.0.105:4370` | 14374 | *same public IP* | 14374 |
| Unit1 - 4 | `192.168.0.118:4370` | 14375 | *same public IP* | 14375 |

Only the **external** port changes per device; the internal port is always
4370.

### Procedure -repeat per device

**1. Create the device IP host**
`Hosts and services → IP host → Add`
Name `FaceMars_<name>`, IPv4, Host type IP, address = the device's LAN IP.

**2. Create the service for its external port**
`Hosts and services → Services → Add`
Type TCP, destination port = that device's **external** port (e.g. 14371).

**3. Restrict who may connect (do this before the rule, not after)**
`Hosts and services → IP host → Add` -one entry per Railway egress address,
grouped into an IP host group (e.g. `Railway_Egress`).

This step is not optional. The ZKTeco protocol on 4370 has no encryption and
only a weak numeric comm password; left open to `Any`, the device is exposed
to internet-wide scanners.

**4. Create the DNAT rule**
`Rules and policies → NAT rules → Add NAT rule → Server access assistant (DNAT)`
- Internal server: the IP host from step 1
- Internal port: **4370** (always)
- External port: this device's unique port from step 2
- External source networks: **`Railway_Egress`** -never `Any`
The assistant creates the matching firewall rule automatically.

**5. Point the portal at it**
HR Portal → **Settings → Devices** → edit the device:
- **Host/IP** → the public IP / DDNS name (not the `192.168.x.x` address)
- **Port** → that device's external port

Easy to miss: a **blank Port field defaults to 4370** (`biometric_sync.py`
line 97, `d.port or 4370`), so leaving it empty silently dials the wrong port.
`HO` currently has no port set, so it must be filled in explicitly when its
host is switched to the public address.

**6. Verify**
Click **Sync Biometric**. Success looks like the pipeline completing with a
record count. Failure now reports the real reason rather than hanging -see
the troubleshooting table under Path 1.

### Adding a new device later -short version

1. Note its LAN IP; keep its internal port at 4370.
2. Pick the next unused external port in your scheme.
3. Repeat steps 1, 2, 4 above (step 3's `Railway_Egress` group is reused).
4. Add the device in Settings → Devices with the **public** host and its new
   external port.

### Ongoing caveat -Railway egress IPs

Railway does not guarantee stable outbound IPs on all plans. If they rotate,
the step-3 allowlist silently stops matching and every Pull fails with
"could not reach device" while nothing on the firewall looks wrong. If a
static-egress option is available on the plan, it's worth having; otherwise
treat this allowlist as something to re-check when sync breaks for no
apparent reason.

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

## ADMS push -devices calling the cloud server

ZKTeco / AiFace-Mars terminals in **ADMS** mode (the device menu calls it *Cloud Server Setting*) dial out to the server over HTTP(S) and push attendance as it happens. This is implemented in `backend/api/adms_views.py`; the routes sit at the bare root (`/iclock/cdata`, `/iclock/getrequest`, `/iclock/devicecmd`), not under `/api/`, because that is where the firmware is hardcoded to call (see `api-database-reference.md` -> Biometric Device Push (ADMS)).

What the server hears from a device, and what is recorded for the status page:

| Request | When | Recorded on the device row |
|---|---|---|
| `GET /iclock/getrequest` | the heartbeat, about every 10 seconds while the device can reach the server | `last_heartbeat_at`, `last_remote_ip` |
| `GET /iclock/cdata?options=all` | the handshake after start-up | the device's own settings (`reported_config`) |
| `POST /iclock/cdata?table=options` | the device reporting its settings | `reported_config` |
| `POST /iclock/cdata?table=ATTLOG` | attendance lines | punches, `last_data_at`, newest punch time, lines that could not be read (`last_error`) |
| `POST /iclock/devicecmd` | the result of a command | heartbeat |

The server accepts attendance from **any** device that pushes; the serial number (`SN`) is used only to tell devices apart for health tracking. A device that contacts the server under a serial no configured device carries is kept in `biometric_unknown_pushers` and listed on the status page as an **unknown sender**, so a new machine or a mistyped serial is visible instead of silent. Enter each device's serial number in **Settings -> Devices**. A blank serial is filled in automatically on first contact only when exactly one enabled device has none.

### What each device must be set to

Read over the LAN from the five factory devices (HO - 1 to HO - 5 PROD) on 2026-10-06 and compared with the HO device, which does push. None of the five can reach the server today:

| Setting on the device | Must be | Found on the five PROD devices |
|---|---|---|
| ADMS / Cloud Server | ON | ON |
| Server address | `api.uktextiles.in` | `api.uktextiles.in` |
| Server port | the standard web port, as on HO (no port override) | 81 on four of them, 8000 on 192.168.0.20 |
| DNS server (Ethernet) | a working resolver, for example `8.8.8.8` or the router | `0.0.0.0`, so the device cannot turn the name into an address |
| Gateway (Ethernet) | the router, for example `192.168.0.254` | `0.0.0.0` on 192.168.0.20 |

The device's own port 4370 is for Pull only and stays as it is. A proxy should be off unless the company really routes through one. The firewall must allow the device's outbound web traffic to the server (see the outbound rule at the top of the firewall section above).

---

## Biometric Device Status page (Attendance -> Biometric Device Status)

Route `/hr/attendance/device-status`. Backend: `device_status.py` (the payload), `device_status_views.py` (3 endpoints), `device_probe.py` (the connection check), `device_diagnosis.py` (the nine-layer reasoning), `device_health.py` (the one rule for "connected"). It answers one question: is every punching machine connected to the server, and if not, why?

**Two kinds of evidence, kept apart**

- *Received*: what the server hears from the device (heartbeat, attendance pushes, the device's reported settings, recorded errors). This is the truth about "connected to the deployed API". Reading it never contacts a device.
- *Reached*: what the server can reach from where it runs (ping, the TCP port, the ZK handshake, a read of the device's own settings). It is gathered only when someone presses **Run connection check**, and a check older than 6 hours is shown but no longer used in the diagnosis. A server in the cloud cannot see `192.168.x.x`, so from Railway a LAN device is **Unreachable by design**; the page says so instead of calling the device broken. Run the check from the local app on a computer in the factory to read the device's settings.

**States**

| State | Meaning |
|---|---|
| Connected | polling the server within the last 3 minutes; or, for a device that does not poll, pushed within the last 6 hours |
| Disconnected | silent beyond that, or never heard from ("Never connected") |
| Error | something was recorded as going wrong in the last 24 hours (unreadable attendance lines, a failed sync, a failed check) and the device is not Connected |
| Disabled | switched off in Settings; excluded from the counts |
| Reachable / Unreachable / Port closed / Wrong password / Not checked | the result of the last connection check |
| Pinging... | shown on the page while a check is running |

**The nine layers.** For each device the page marks Biometric device, Local network (LAN), Firewall, Port configuration, API connection, Railway deployment, Device IP configuration, Network timeout and Authentication & configuration as OK, Warning, Problem, Unknown or Not applicable, with the exact error and what to do. When several layers have a problem the one to fix first is the headline (IP configuration, then port, authentication, firewall, API, timeout, LAN, device). A local server cannot judge a device that sends to `api.uktextiles.in`, so for such a device the Firewall and API layers read Not applicable and the headline says the device is reporting elsewhere; the Railway layer is Not applicable on a local server.

**Connection check.** `POST /api/attendance/biometric-status/check` pings, opens the TCP port, performs the ZK handshake and reads a handful of options (serial, device name, MAC, IP, mask, gateway, DNS, DHCP, server URL, web port, ADMS function, proxy), then disconnects. It never disables the terminal and never changes a setting. One check runs at a time (a second request gets 409) and the whole check is held to 24 seconds. Each result is saved to `biometric_device_probes` (the latest 30 per device are kept).

**Permissions.** The endpoints sit under `/api/attendance/`, so the existing Attendance module rule applies: viewing needs View, the connection check needs Edit. The check is written to the audit log.
