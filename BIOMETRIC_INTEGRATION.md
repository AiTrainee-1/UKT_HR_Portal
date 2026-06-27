# Biometric Device Integration Guide
**UKTextiles HR Portal — eSSL e2008 Face Recognition Terminal**

---

## Device Information (Your Device)

| Field | Value |
|---|---|
| **Brand** | eSSL (Security at Fingertips) |
| **Model** | e2008 |
| **Serial Number** | CQIK22560204 |
| **MAC Address** | 00:17:61:12:bc:b4 |
| **Face Algorithm** | Face VX3.9 |
| **Platform** | ZAM180_TFT |
| **Capacity** | 3,000 faces / 150,000 attendance records |
| **Currently enrolled** | 266 employees, 55,908 records |
| **Protocol** | ZKTeco/ICLOCK over TCP port 4370 |

---

## How the Integration Works

The eSSL e2008 does **not** send attendance records in real-time over HTTP. Instead, it stores every punch in its internal memory. Your Django server **connects to the device** and pulls those records on a schedule.

```
┌────────────────┐   ZK Protocol / TCP 4370   ┌──────────────────────────┐
│  eSSL e2008    │ ◀──────────────────────────  │  Django Server           │
│  192.168.0.X   │   "give me attendance logs" │  sync_biometric command  │
│                │ ──────────────────────────▶  │                          │
│  55,908 records│   returns punch records      │  writes to attendance_   │
│  stored on     │                              │  logs + attendance tables│
│  device memory │                              │                          │
└────────────────┘                              └──────────────────────────┘

Both on the same LAN — no internet, no HTTPS needed.
```

This is called the **Pull approach**. Your server asks the device for records every few minutes. The result is near-real-time attendance (15-minute delay at most).

---

## About the HTTPS Issue

**Stop trying to enable HTTPS on the device. You do not need it.**

The eSSL e2008 firmware has a bug where enabling HTTPS causes infinite restart loops. This does not matter because:

- The device and server are on the **same private LAN**
- Nobody outside your factory can see this traffic
- The pull protocol (ZK/ICLOCK over port 4370) does not use HTTP at all — it is a direct TCP connection
- HTTP is perfectly safe on a private internal network

Simply leave HTTPS disabled and continue.

---

## Real-Time Push vs Scheduled Pull

The eSSL e2008 does support an HTTP push feature (called ADMS or Cloud Server) but it uses a proprietary ICLOCK/ADMS protocol — not a simple JSON POST. Setting it up requires implementing a different server-side protocol.

The **pull approach using `pyzk`** is much simpler, works immediately, and gives you attendance data with a delay of whatever interval you choose:

| Approach | Delay | Complexity | Recommended? |
|---|---|---|---|
| Pull every 5 min | ~5 min | Simple | ✅ Yes |
| Pull every 15 min | ~15 min | Simple | ✅ Yes |
| Pull twice a day (8am + 6pm) | up to 10 hours | Simple | ⚠️ Attendance dashboard will be empty until pull |
| Real-time ADMS push | ~0 sec | Complex (different protocol) | ❌ Not recommended for now |

**Recommendation: Pull every 10–15 minutes.** This gives near-real-time data (good enough for the live dashboard) and is completely reliable.

---

## Step-by-Step Setup

### Step 1 — Find the Device's IP Address

On the eSSL device:

1. Tap **Main Menu** (the three-dot or hamburger button, or hold the screen)
2. Tap **COMM.**
3. Tap **Ethernet**
4. You will see: **IP Address**, Subnet Mask, Gateway

Write down the IP address. Example: `192.168.0.101`

> If the IP is `0.0.0.0` the device has no IP yet. Set a static IP:
> - IP Address: `192.168.0.101` (any free address on your LAN)
> - Subnet Mask: `255.255.255.0`
> - Gateway: `192.168.0.1` (your router's IP)
> After changing, the device will restart.

### Step 2 — Confirm the Device is Reachable

From the computer running the Django server, open a command prompt and run:

```cmd
ping 192.168.0.101
```

You should see replies like:
```
Reply from 192.168.0.101: bytes=32 time=1ms TTL=64
```

If you get "Request timed out" or "Destination host unreachable":
- Check the LAN cable on the device
- Make sure the device and computer are on the same network switch / router
- Check that no firewall is blocking the connection (Windows Defender Firewall → Allow port 4370)

### Step 3 — Set the Device IP in Your .env File

Open `backend/.env` and replace the placeholder with your actual device IP:

```ini
# Change 192.168.0.XXX to your actual device IP from Step 1
BIOMETRIC_DEVICE_IP=192.168.0.101
BIOMETRIC_DEVICE_PORT=4370
BIOMETRIC_DEVICE_PASSWORD=0
```

`BIOMETRIC_DEVICE_PASSWORD` is the communication password set on the device. The default is `0` (zero). Unless you changed it in COMM. settings, leave it as `0`.

### Step 4 — Install pyzk

`pyzk` is the Python library that speaks the ZKTeco protocol to the eSSL device.

```bash
cd backend
pip install pyzk
```

Or with the virtual environment:
```bash
cd backend
.venv\Scripts\pip install pyzk     # Windows
# OR
.venv/bin/pip install pyzk          # Linux/Mac
```

It is already added to `requirements.txt` so future installs are automatic.

### Step 5 — Do the First Full Import (All 55,908 Records)

This pulls all attendance records currently stored on the device. Run it once to populate your database with historical data.

```bash
cd backend
python manage.py sync_biometric --all
```

Expected output:
```
Connecting to eSSL e2008 at 192.168.0.101:4370 ...
  Connected. Pulling attendance records...
  Device returned 55908 total records.

  ✓ New records created : 55847
  — Skipped (duplicate or out of range) : 61

  ⚠ 3 device User ID(s) had no matching employee:
    - '0'
    - '267'
    - 'test'

  Fix: make sure the Person ID on the device matches the
  employee_code in the HR Portal (e.g. EMP042).
```

After the first import, go to **HR Portal → Attendance** — you should see historical attendance data populated.

### Step 6 — Set Up Scheduled Sync (Every 15 Minutes)

After the first full import, switch to incremental syncs (last 3 days only, fast):

```bash
# Run manually to test
python manage.py sync_biometric --days 3
```

**Automate it on Windows using Task Scheduler:**

1. Press `Win + R`, type `taskschd.msc`, press Enter
2. Click **Create Basic Task**
3. Name: `UKTextiles Biometric Sync`
4. Trigger: **Daily**
5. Click **Next**, then change the trigger to **Repeat task every: 15 minutes** for a duration of **1 day**
6. Action: **Start a program**
7. Program: `C:\path\to\backend\.venv\Scripts\python.exe`
8. Arguments: `manage.py sync_biometric --days 1`
9. Start in: `C:\path\to\backend\`
10. Click **Finish**

**Alternatively — run it in a loop while server is running:**

Create `backend/sync_loop.py`:
```python
import subprocess, time, sys

while True:
    subprocess.run([sys.executable, "manage.py", "sync_biometric", "--days", "1"])
    time.sleep(600)   # wait 10 minutes
```

Run alongside your Django server:
```bash
python sync_loop.py
```

---

## How to Add Employees and Link Them to the Device

The link between the device and HR Portal is the **employee code**. The number you enter as "User ID" on the device must match the `employee_code` in the HR Portal exactly.

### Option A — Add Employee in HR Portal First, Then Enroll on Device

This is the recommended workflow for new employees:

1. Go to **HR Portal → Employees → Add Employee**
2. Set the Employee Code (e.g., `EMP042` or `42` — your choice, keep it consistent)
3. Save the employee

4. On the eSSL device, tap **Main Menu → User Mgt. → New User**
5. Set **User ID** = `EMP042` (exactly as in HR Portal)
6. Set **Name** = Employee's name (for display on device only)
7. Tap **Face** → Follow on-screen instructions to capture face
8. Save

9. Test: Have the employee scan at the device, then run:
   ```bash
   python manage.py sync_biometric --today
   ```
   Check **HR Portal → Attendance → Today** — employee should appear.

### Option B — You Already Have 266 Employees on the Device

Since you already have 266 enrolled employees, you need to match their device User IDs to the HR Portal employee codes.

**Step 1 — Export users from the device:**

On the eSSL device:
1. Insert a USB flash drive
2. Tap **Main Menu → Data Mgt. → Export**
3. Select **User Data** → Export to USB

This creates a file (usually `USER.CSV` or similar) with columns: `User ID`, `Name`.

**Step 2 — Check what User IDs they have:**

Open the CSV. The `User ID` column is what you need to match.

Common patterns:
- If device has `1, 2, 3, 4...` → These are numeric IDs
- If device has `EMP001, EMP002...` → These are already employee codes

**Step 3 — Reconcile with HR Portal:**

Run the first sync with `--all` and read the "no matching employee" warnings:
```bash
python manage.py sync_biometric --all
```

Any User ID printed in the warning is someone enrolled on the device but not found in the HR Portal. For each one:
- Either add a new employee in HR Portal with that exact code
- Or update the employee's `employee_code` in HR Portal to match the device User ID

After reconciling, run sync again. The warnings should disappear.

---

## Database Tables Written by the Sync

### `attendance_logs` — One row per punch

| Column | Example | Description |
|---|---|---|
| `employee_id` | `42` | Links to `employees.id` |
| `date` | `2024-06-27` | Date of punch |
| `punch_time` | `09:03:00` | Time of punch |
| `punch_type` | `IN` or `OUT` | Check-in or Check-out |
| `source` | `biometric:essl:192.168.0.101` | Always `biometric:essl:<device_ip>` for device syncs |

### `attendance` — Daily summary (one row per employee per day)

| Column | Example | Description |
|---|---|---|
| `employee_id` | `42` | Links to `employees.id` |
| `date` | `2024-06-27` | Date string |
| `present` | `True` | Set to True as soon as first punch is synced |

---

## Command Reference

```bash
# Pull last 3 days (recommended for scheduled cron)
python manage.py sync_biometric

# Pull last N days
python manage.py sync_biometric --days 7

# Pull today only (fastest — good for frequent runs)
python manage.py sync_biometric --today

# Pull ALL records from device (first-time full import only)
python manage.py sync_biometric --all
```

---

## What Happens in Payroll After Sync

Once attendance records are in the database, payroll works automatically:

```
Biometric punch on device
  → sync_biometric pulls it into attendance_logs
    → payroll engine reads attendance_logs for the month
      → calculates present days / absent days / late marks
        → generates salary slips
```

- **Staff employees**: present days = number of dates with at least one `attendance_log` entry → pro-rated monthly salary
- **Production employees**: punch logs → sessions processed via `process_punch_sessions` → session count × session pay rate

---

## Troubleshooting

### `Could not connect to device` error

```
Error: [Errno 111] Connection refused
```
- Confirm device IP is correct: `Main Menu → COMM. → Ethernet → IP Address`
- Run `ping 192.168.0.101` from the server machine
- Check port 4370 is not blocked by Windows Firewall:
  ```cmd
  netsh advfirewall firewall add rule name="ZK Biometric" dir=out action=allow protocol=TCP remoteport=4370
  ```
- Make sure the device is powered on and the Ethernet cable is plugged in

### `pyzk is not installed` error

```bash
pip install pyzk
# or
.venv\Scripts\pip install pyzk
```

### Employees show as "not found" during sync

The User ID on the device does not match any `employee_code` in the HR Portal.

Find what the device is sending:
1. Run `sync_biometric --all` and read the warnings
2. The warning shows exactly which IDs are unmatched
3. Either edit the employee in HR Portal to set their `employee_code` to match, or re-enroll that employee on the device with the correct ID

### Records are being created but attendance page shows nothing

The employee's `status` in the HR Portal might be `inactive`. The sync skips inactive employees. Go to **HR Portal → Employees**, find the employee, and activate them.

### Clock on device shows wrong time, punches have wrong timestamps

On the eSSL device:
1. Main Menu → **System** → **Date Time**
2. Set the correct date and time
3. Timezone should be **+05:30** (IST)

Already-imported records with wrong timestamps need to be corrected manually or deleted and re-imported after fixing the clock:
```sql
DELETE FROM attendance_logs WHERE source LIKE 'biometric:essl%' AND date = '2024-06-27';
```
Then run `sync_biometric --today` again.

### Password error when connecting

```
Error: Invalid password
```

The device has a communication password set. On the device:
- Main Menu → **COMM.** → **PC Connection** → **Password** → note the value

Set it in `.env`:
```ini
BIOMETRIC_DEVICE_PASSWORD=12345
```

---

## Complete Workflow Summary

```
1.  Add employee in HR Portal
      → Note the employee_code (e.g. EMP042)

2.  Enroll employee on eSSL e2008
      → Main Menu → User Mgt. → New User
      → User ID = EMP042 (must match HR Portal exactly)
      → Capture face

3.  Employee punches at device each day
      → Device stores punch in internal memory

4.  sync_biometric runs every 15 minutes (scheduled)
      → Connects to device over LAN port 4370
      → Downloads new punch records
      → Writes to attendance_logs table
      → Updates attendance table (present = True)

5.  HR Portal Attendance page refreshes
      → Shows present/absent counts for today
      → Production vs Staff breakdown
      → Late marks calculated against shift timings

6.  End of pay period
      → HR verifies attendance, adds manual entries for any gaps
      → Production workers: run Process Sessions
      → Run Generate Payroll
      → Salary slips generated with correct present days

7.  Salary slips show:
      Present Days  ← from attendance_logs (biometric punches)
      Absent Days   ← inferred from shift calendar
      Net Salary    ← calculated by payroll engine
```

---

*Device: eSSL e2008 · Serial: CQIK22560204 · Protocol: ZKTeco/ICLOCK TCP:4370*
*Last updated: 2026-06-27*
