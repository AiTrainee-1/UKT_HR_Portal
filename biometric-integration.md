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
| Server port and HTTPS | **443 with HTTPS ON** (HO has no port override) | 81 on four of them, 8000 on 192.168.0.20 |
| DNS server (Ethernet) | a working resolver, for example `8.8.8.8` or the router | `0.0.0.0`, so the device cannot turn the name into an address |
| Gateway (Ethernet) | the router, for example `192.168.0.254` | `0.0.0.0` on 192.168.0.20 |

### The path from a device to the server (checked from the factory LAN, 2026-10-06)

`api.uktextiles.in` is behind **Cloudflare** (it resolved to 104.21.x.x and 172.67.x.x; Cloudflare's addresses change, so never allow it by fixed IP). From a computer on the factory network:

| Request | Result |
|---|---|
| `https://api.uktextiles.in/iclock/getrequest` (port 443) | `200 OK`: this is the path a device must use |
| `http://api.uktextiles.in/iclock/getrequest` (port 80) | `301` redirect to HTTPS. A device does not follow redirects, so plain HTTP does not work |
| port 81, port 8000 | no connection at all (Cloudflare does not serve them), so a device set to 81 or 8000 can never connect |
| TLS | the Cloudflare edge accepted TLS 1.0 to 1.3 when tested, so older device firmware can still negotiate |

**Firewall (outbound only).** Push needs no inbound rule and no port forward: the device dials out. The DNAT section above is for Pull only.

- Allow the device addresses (one IP host group, for example `192.168.0.20, .47, .59, .61, .107, .119`) outbound to the internet on **TCP 443** and on **DNS** (UDP and TCP 53 to `8.8.8.8`, or to the firewall's own DNS if the devices use the router as DNS).
- Allow the destination by host name (`api.uktextiles.in`) or "any WAN" on 443, not by IP address.
- Exempt the devices from HTTPS scanning / SSL-TLS inspection and from web filtering. A device cannot trust the certificate a firewall re-signs, so inspection makes the handshake fail even though 443 is open.
- If a device still does not connect, read the firewall log for its IP: allowed or denied, and which rule matched.

**Cloudflare / Railway need no change.** If a Cloudflare security rule is ever added (Bot Fight Mode, a WAF challenge, Browser Integrity Check), exempt `/iclock/*`: a device cannot answer a challenge.

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

---

## Device Control (Attendance -> Device Control)

One section for the biometric machines themselves, with three tabs: **Overview** (how many devices, how many this server can reach right now, each one's health), **Data Fetch** (pull punches by hand) and **Data Push** (see and manage the people on every device). Routes `/hr/attendance/DeviceControl`, `/fetch` and `/push`. Backend: `device_client.py` (the session with a terminal), `device_directory.py` (users, mapping, changes), `device_fetch.py` (manual fetch), `device_control_views.py` (the endpoints). It does not change how attendance is recorded or calculated.

### How it talks to a device

The same way Sync Biometric does: a direct ZK-protocol connection on TCP 4370 (pyzk). So it works wherever **this server can reach the device**: the HRMS running on a computer in the factory, or a cloud server only through a forwarded port (the firewall section above). A cloud server with a device at `192.168.x.x` does not even try; it says why and what to do. Punches still reach a cloud server by themselves through ADMS push; this section does not use that path.

One session per device at a time (a terminal serves one). Sessions in this process take a per-device lock, and a write holds the terminal disabled for its duration and always enables it again. The Attendance page's Sync Biometric button is not covered by that lock, so Device Control refuses to write users or start a fetch while a Sync Biometric run is in progress (HTTP 409, "wait for it to finish").

Every session has a deadline: two minutes for reading users, writing and the overview check, ten when reading a whole punch log. pyzk itself waits for ever on a terminal that stops answering half way through a download (one that reboots mid-transfer); the deadline drops the connection, so such a device cannot hold the terminal or the request, and the page is told it "did not finish within N seconds".

The legacy `.env` device (`BIOMETRIC_DEVICE_IP`) is not part of Device Control: only devices added in Settings -> Devices.

### What these terminals are (read from the five factory devices and HO, 2026-10-06)

Face terminals (platform `ZAM180_TFT` / `ZAM170_TFT`, firmware 6.60), not fingerprint ones: 0 fingerprints, one face per user. 3,000 users and 150,000 punches of memory each. HO-2 PROD held 140,796 of 150,000 punches (94%); the overview warns from 80%. A user record is 72 bytes: ID (the Employee Code) up to 9 characters, name up to 24 bytes, role, card, password (up to 8 digits), group.

**What the network connection can do:** read, add, change and delete user records. **What it cannot:** create or copy a face template, or put a photo on a terminal. These models report photo support, but the ZK commands pyzk has do not reach it (it goes through the device's own cloud channel). So a user added from the portal has no face until the person enrols at the device, and a photo taken in the portal is kept on the employee's HRMS profile (the same `photo_url` the Employees page edits), not on the terminal.

### Rules

- **Who is who:** a device user is linked to the employee whose Employee Code equals their device ID, exactly (no leading-zero tricks), the same rule as `biometric_sync._active_employee_lookup`. People are: *In HRMS*, *Not in HRMS* (on a device, no employee), *Not on a device* (active employee, on none), *Inactive but still on a device*, and *Another branch* (hidden detail for a branch-limited caller, who also cannot change them).
- **Edits never rebuild a record.** A user is read as the device's raw 72 bytes and only the fields being changed are overlaid before it is sent back, so every other byte is returned exactly as it was. pyzk's `set_user` is not used: it writes a zero in the byte after the card (the group), which every real terminal keeps at 1. A new user starts from a record shaped the way a terminal writes one. Every write is read back before it is reported as done.
- **Delete** removes the user from the chosen devices and, if asked, makes their employee **Inactive** (`Employee.status`, the same thing a bulk upload or an approved resignation sets). The employee is never deleted: record, history and code stay. They become Inactive only when at least one device really removed them (verified by reading the device back) or the stored list had them on a chosen device and the device now says they are not there (someone who was never on a chosen device is not made Inactive by deleting them from it), and only with Edit access to Employees, in the caller's branch; otherwise the devices are changed and the employee left as they are, and the result says so. If the connection is lost part way, the result keeps what the device acknowledged ("went through, but could not be confirmed"), the rest is "not attempted", and no employee is changed on that device's account.
- A write is refused for a device that reports no capacity (users cap 0) or no users while its own counters say it has some: a half-answering terminal is not written to. Every field asked for (name, role, card, password, group) is checked on the read-back, so a firmware that acknowledges a change and keeps the old value is reported as "did not keep the change".
- A request names the employee only together with their own user ID (`employeeId` must be the employee whose Employee Code is that ID, inside the caller's branch), so a crafted request cannot be used to read another branch's names. Boolean options (`markInactive`, `apply`) are read strictly: the text "false" is false.
- Device passwords are never stored (the snapshot keeps only "has a password") and never copied between devices.
- A new user takes the lowest free slot on the device, as a terminal itself does. On an older terminal (28-byte records, whose punch log names a person by slot number only) the next number after the highest in use is taken instead, so a freed slot never turns the old occupant's past punches into the new person's. A device with no users yet cannot show its record format, so it is assumed to use the 72-byte records every current terminal has.
- A branch-limited caller sees an employee of another branch only as "Another branch" (no name, not even the device's name for them, and not searchable by it) and cannot change or delete them.
- Data Fetch results are masked the same way: a branch-limited caller sees the counts and codes of a run, not the names of the people in it (sample punches, suspicious days, unmatched IDs).
- Limits per request: 200 users, 12 devices. Names are cut to 24 bytes without splitting a character.
- The list the page filters is a **snapshot** of each device's users (`biometric_device_users`), read on demand and after every change; each device shows when it was read.

### Data Fetch

Choose devices and a range (today, yesterday, last 7 days, this month, last month, custom, everything), then **Preview** (reads the devices and says what an update would add; changes nothing) or **Fetch and update HRMS**. A new punch is written by `biometric_sync._ingest_punches`, the path Sync Biometric uses, and matched the same way (Employee Code, active employees only; status 0/4 = In, 1/5 = Out, anything else In). Two deliberate differences: punches the HRMS already has are recognised first (by who and when, ignoring the In/Out byte, because a pull and a push describe the same punch differently) and not offered to the write again, and IDs with no employee are reported in the run, not added to the "Skipped" list (reading a range twice must not count its punches twice there). A run is a row (`biometric_fetch_runs`) filled in by a background thread, so it works whichever web worker answers the page's polling, and it stays as the history. One run at a time (the check and the insert happen under a database advisory lock, so two clicks or two web workers cannot both start one); it also waits for a running Sync Biometric. A running run beats a heartbeat every 30 seconds; one that has been quiet for five minutes (the server was restarted) is marked failed, so it never blocks the next. Measured on the six real devices: 6 to 41 seconds each (up to three in parallel), because a terminal can only send its whole log. A preview and the update that followed it agreed exactly (423 and 423 punches for 7 days).

### Testing without a terminal

`backend/fake_zk_device.py` is an independent implementation of the other end of the ZK protocol, written from pyzk's client and from records captured off the real terminals. The unit tests start it in-process; the Playwright suite starts it as a process (three devices on 14371-14373, an HTTP control port 14380 to reset it and read back what the portal wrote), so the whole stack is exercised: connect, read users and punches, write and delete users, refusals, a device that is down. It must stay free of `api/device_client.py` so the two check each other.
