# Attendance Integration Guide — UKTextiles HRMS

## Overview

This system integrates with the **AiFace-Mars** biometric terminal (visible-light AI face recognition with anti-spoofing). The device handles all face detection and identification; the HRMS only receives the resulting attendance punch events via HTTP.

---

## Architecture

```
Employee Face
     ↓
AiFace-Mars Terminal
(Face Recognition + Anti-Spoofing)
     ↓  HTTP POST
POST /api/biometric/punch
     ↓
AttendanceLog table (PostgreSQL)
     ↓
Attendance Summary API
     ↓
HR Portal (React) — Attendance Page
```

---

## 1. Device Setup — AiFace-Mars

### 1.1 Network Configuration

1. Connect the device to the same network as the server (or ensure internet access if hosted remotely).
2. On the device screen: **Menu → Network → TCP/IP**
   - Set a static IP or note the DHCP-assigned IP.
   - Ensure the device can reach your server's IP/hostname on port 8000 (or whatever port Django runs on).

### 1.2 Configure HTTP Push (Webhook)

AiFace-Mars supports **Real-Time Push** of attendance events via HTTP.

On the device: **Menu → Communication → HTTP Push Settings**

| Field            | Value                                              |
|------------------|----------------------------------------------------|
| Enable Push      | Yes                                                |
| Push URL         | `http://<server-ip>:8000/api/biometric/punch`     |
| Push Method      | POST                                               |
| Content-Type     | application/json                                   |
| Custom Header    | `X-Device-Key: uktex-biometric-2024`              |
| Push Interval    | Realtime (or 1 minute)                             |
| Push on Event    | Check-In + Check-Out                               |

> **Security Note:** Change the API key `uktex-biometric-2024` to a strong random value. Update it in `backend/api/attendance_views.py` (constant `_BIOMETRIC_API_KEY`) or set `BIOMETRIC_API_KEY` in Django settings.

### 1.3 Payload Format

The device sends this JSON body on each punch:

```json
{
  "personId": "EMP001",
  "devSN": "MARS-2024-0012",
  "time": "2026-06-26T09:15:00",
  "eventType": 0
}
```

| Field       | Description                               |
|-------------|-------------------------------------------|
| `personId`  | Employee code stored on device (see §2)   |
| `devSN`     | Device serial number                      |
| `time`      | ISO-8601 datetime or Unix timestamp       |
| `eventType` | `0` = Check-In, `1` = Check-Out           |

The API also accepts these alternative field names for compatibility:
- `employeeCode` instead of `personId`
- `punchTime` instead of `time`
- `deviceId` instead of `devSN`

---

## 2. Employee Registration on the Device

Each employee must be enrolled on the AiFace-Mars terminal before it can identify them.

### 2.1 On-Device Enrollment

1. On the device: **Menu → User Management → Add User**
2. Enter:
   - **User ID / Person ID**: Use the employee's **Employee Code** (e.g. `EMP001`, `1/26`). This must match exactly the `employee_code` field in the HRMS database.
   - **Name**: Employee's full name.
   - **Face**: Follow the on-screen prompts to capture face data (3–5 angles).
3. Repeat for each employee.

### 2.2 Bulk Enrollment via SDK

For large workforces, use eSSL's management software or SDK to batch-import employees:

1. Export employee codes from HRMS (any CSV export from the Employees page).
2. Import into eSSL DeviceManager software.
3. Push to the device via the management software.

### 2.3 Keeping IDs in Sync

- The **Person ID on the device** must match `employee_code` in the HRMS.
- When a new employee is added in the HRMS, enroll them on the device using the same code.
- When an employee is deactivated in the HRMS, also delete them from the device.

---

## 3. API Endpoints

### 3.1 Biometric Punch (Device → HRMS)

```
POST /api/biometric/punch
Header: X-Device-Key: uktex-biometric-2024
Content-Type: application/json
```

**Request:**
```json
{
  "personId": "EMP001",
  "time": "2026-06-26T09:15:00",
  "eventType": 0,
  "devSN": "MARS-2024-0012"
}
```

**Response 201:**
```json
{
  "ok": true,
  "logId": 4821,
  "employee": "Rajesh Kumar",
  "punchType": "IN",
  "punchTime": "09:15:00",
  "date": "2026-06-26"
}
```

---

### 3.2 Manual Attendance (HR Portal)

Used when the device misses someone (e.g. HR verifies via CCTV and manually records the punch).

```
POST /api/attendance/manual
Authorization: Bearer <hr-jwt-token>
```

**Request:**
```json
{
  "employeeId": 42,
  "date": "2026-06-26",
  "punchTime": "09:20",
  "punchType": "IN",
  "notes": "CCTV verified – entry gate 2",
  "hoursWorked": 8
}
```

---

### 3.3 Attendance Summary (for Dashboard Cards)

```
GET /api/attendance/summary?date=2026-06-26
Authorization: Bearer <hr-jwt-token>
```

Returns: total employees, present today (biometric + manual), not punched, yesterday overview (present/absent/late/on leave).

---

### 3.4 Daily Employee List (for Table)

```
GET /api/attendance/daily?date=2026-06-26
Authorization: Bearer <hr-jwt-token>
```

Returns every active employee with their punch status for the given date: present / manual / on_leave / absent, plus first punch time and last punch time.

---

### 3.5 Monthly Trend (for Charts)

```
GET /api/attendance/monthly-trend?year=2026&month=6
Authorization: Bearer <hr-jwt-token>
```

Returns daily counts of present/absent employees for the entire month.

---

### 3.6 Employee History

```
GET /api/attendance/employee/<id>?month=6&year=2026
Authorization: Bearer <hr-jwt-token>
```

Returns all attendance records for a specific employee (biometric punches + manual entries), grouped by date.

---

## 4. Complete Workflow

### Normal Day Flow

```
1. Employee arrives → faces AiFace-Mars terminal
2. Terminal recognises face (< 1 second)
3. Terminal POST → /api/biometric/punch (Check-In, eventType=0)
4. HRMS creates AttendanceLog entry (source="biometric:<devSN>")
5. HRMS updates Attendance summary record (present=True)

6. Employee leaves → faces terminal again
7. Terminal POST → /api/biometric/punch (Check-Out, eventType=1)
8. HRMS creates second AttendanceLog entry

9. HR opens Attendance page → sees real-time status for all employees
10. Payroll module reads AttendanceLog to calculate working hours & shifts
```

### Missed Punch Flow (CCTV Verification)

```
1. Employee is marked "Not Punched" on the Attendance page
2. HR reviews CCTV footage to verify presence
3. HR clicks "Add Attendance" on the Attendance page
4. HR enters Employee ID, date, observed punch time, adds CCTV note
5. HRMS creates AttendanceLog (source="manual") + updates Attendance record
6. Employee now shows as "Manual" status in the table
```

### Late Detection Flow

```
1. Employee punches in → HRMS records punch time
2. HRMS compares first IN punch vs shift start time + grace period
   (from EmployeeShiftAssignment → ShiftTemplate)
3. If punch time > (shift start + grace), employee is counted as "Late"
4. Yesterday Overview card shows Late count
```

---

## 5. Shift-Attendance Integration

Attendance is linked to shifts via `EmployeeShiftAssignment`:

| Model                   | Role                                           |
|-------------------------|------------------------------------------------|
| `ShiftTemplate`         | Defines start time, end time, grace period     |
| `EmployeeShiftAssignment` | Assigns a shift to an employee for a date range |
| `AttendanceLog`         | Records actual punch IN/OUT from biometric     |
| `Attendance`            | Summary record (present/absent, hours worked)  |

For payroll:
- Sessions and shifts worked are calculated from `AttendanceLog` punch pairs (IN→OUT)
- `WorkSession` records are generated by the payroll module from these logs
- `Payroll` records use present days derived from `Attendance`

---

## 6. Salary & Payroll Impact

| Attendance Status   | Payroll Impact                               |
|---------------------|----------------------------------------------|
| Present (biometric) | Counted as present day; shifts calculated    |
| Present (manual)    | Counted as present day; shifts not auto-calc |
| Absent              | Day deducted from salary (if applicable)     |
| On Leave            | Leave deducted from leave balance; paid/unpaid per leave type |
| Late                | May trigger penalty based on HR settings     |

---

## 7. Troubleshooting

| Problem                     | Solution                                               |
|-----------------------------|--------------------------------------------------------|
| Device not pushing data     | Check network connectivity; verify push URL and API key in device settings |
| Employee not recognized     | Re-enroll employee face; ensure good lighting          |
| Person ID mismatch          | Verify device Person ID matches `employee_code` in HRMS |
| Punch shows wrong date/time | Sync device time via NTP: **Menu → System → Date/Time** |
| Duplicate punches           | Normal — system uses first IN and last OUT of the day  |
| Server not receiving pushes | Check firewall; ensure Django server is running; check `X-Device-Key` header |

---

## 8. Security Checklist

- [ ] Change `BIOMETRIC_API_KEY` from the default to a strong random value
- [ ] Set `BIOMETRIC_API_KEY` in Django settings or environment variable
- [ ] Use HTTPS in production (configure nginx/caddy + SSL certificate)
- [ ] Restrict `/api/biometric/punch` to the device's IP via firewall or nginx `allow`
- [ ] Regularly audit `AttendanceLog` for unexpected `source` values


<!-- ========================================================================================================================================================================================================================================================================================== -->



## **No, you don't always have to depend on the biometric device.** You have three ways to record attendance:

1. **Biometric (automatic)** — AiFace-Mars pushes to `/api/biometric/punch` on each punch, zero manual work
2. **Manual by HR** — the "Add Attendance" button on the Attendance page, for CCTV-verified cases
3. **Future: Employee mobile app** — can submit a punch request which HR approves

---

**Yes, data is stored permanently.** The moment a punch arrives (from device or manual entry), it is written to two PostgreSQL tables:

| Table | What it stores |
|---|---|
| `AttendanceLog` | Every individual punch event (time, IN/OUT, source) — permanent |
| `Attendance` | Daily summary record (present/absent, hours) — permanent |

PostgreSQL persists this forever until you explicitly delete it. There's no expiry or cleanup.

---

**The only risk:** if your server is down exactly when the device tries to push, that push event is lost — most AiFace-Mars devices retry a few times but don't queue indefinitely.

To protect against this, you have two practical options:

1. **Pull instead of push** — run a background job (cron) that polls the device's local log API every few minutes and imports missed punches. eSSL devices expose a local HTTP API for this.
2. **Keep the server always running** — use a process manager like `supervisord` or run Django behind `gunicorn` as a systemd service so it restarts automatically on crash.

For a garments factory with stable on-premise infrastructure, option 2 is usually enough.


