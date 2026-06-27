# UKTextiles Employee Mobile App — Complete Build Prompt

> **Use this document as your full specification when building the React Native mobile application.**
> The backend Django API is already built and running. You are only building the mobile frontend.

---

## ⚠️ Architecture — Single Shared Backend

**The mobile app and the HR Portal share exactly the same backend and the same database.**

```
┌─────────────────────┐        ┌──────────────────────────────────┐
│  HR Portal          │        │  Employee Mobile App             │
│  (React web app)    │        │  (React Native)                  │
│  localhost:5173     │        │  Expo Go / APK                   │
└────────┬────────────┘        └──────────────┬───────────────────┘
         │                                    │
         │  HTTP requests                     │  HTTP requests
         │                                    │
         ▼                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Django REST API  —  http://192.168.0.5:8000/api                │
│  Same endpoints. Same authentication. Same responses.           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
                  ┌─────────────────────────┐
                  │  PostgreSQL Database     │
                  │  UKTex_DB               │
                  │  192.168.0.5:5432       │
                  └─────────────────────────┘
```

**What this means in practice:**

- Employee submits a leave request from the mobile app → it immediately appears in HR Portal → Leave Requests
- HR approves that leave in the web portal → employee's mobile app shows "Approved" on next refresh
- HR generates payroll for June → the June salary slip immediately appears in the employee's mobile app
- Biometric sync pulls attendance from the device → attendance is visible on both HR Portal and mobile app at the same time
- HR edits employee profile in the web portal → employee sees the updated info in their mobile app profile

**Do NOT create a separate backend, separate database, or separate API for the mobile app.**
Everything already exists. The mobile app is purely a frontend that consumes the existing API.

---

---

## 1. Project Overview

Build a **React Native mobile application** (using Expo) for **UKTextiles** employees.

- **Platform:** Android + iOS (Expo managed workflow)
- **Users:** Employees only (not HR admin)
- **Language:** TypeScript
- **Purpose:** Allow employees to view their attendance, salary slips, shifts, leaves, requests, and personal profile — all from their phone.

This app connects to an **existing Django REST API** backend. Do not build any backend — only consume the existing API.

---

## 2. Tech Stack

| Layer | Library |
|---|---|
| Framework | Expo SDK 51+ (managed workflow) |
| Navigation | `expo-router` (file-based routing) |
| HTTP client | `axios` |
| Server state | `@tanstack/react-query` |
| Auth storage | `expo-secure-store` (JWT token) |
| Animations | `react-native-reanimated` + `moti` |
| UI components | Custom components (no heavy UI lib) |
| Icons | `@expo/vector-icons` (MaterialCommunityIcons) |
| Date handling | `date-fns` |
| Forms | `react-hook-form` + `zod` |

---

## 3. Environment Variables

Create a `.env` file in the mobile project root:

```env
# Backend API base URL
# Change this to your server's LAN IP when running on a real device
# Do NOT use localhost — it will not work on a physical phone
EXPO_PUBLIC_API_URL=http://192.168.0.5:8000/api

# App display name
EXPO_PUBLIC_APP_NAME=UKTextiles
```

> **Important:** The backend server runs on `192.168.0.5` (your office server).
> The port `8000` is the Django development server port.
> Both the phone and server must be on the same Wi-Fi network.
> When deploying to production, replace with the server's actual IP or domain.

---

## 4. Authentication Flow

### How login works

The employee logs in using their **Employee Code** (e.g., `30020`) as the username and a password they set themselves.

**First-time setup:**
1. HR creates the employee record and gives them their Employee Code
2. Employee opens the app → taps "Set Password" (first time only)
3. They enter their Employee Code + new password (min 8 characters)
4. On success, they are redirected to the login screen

**Regular login:**
1. Employee enters Employee Code + password
2. App calls `POST /api/auth/employee-login`
3. On success, receives a JWT token + employeeId
4. Token is stored securely using `expo-secure-store`
5. All subsequent API calls include `Authorization: Bearer <token>` header
6. Employee is redirected to the Home/Dashboard screen

**Token persistence:**
- On app launch, check if a token exists in secure storage
- If token exists → call `GET /api/auth/me` to verify it is still valid
- If valid → go to Home screen (skip login)
- If expired/invalid → clear storage and go to Login screen

### API Endpoints for Auth

```
POST /api/auth/employee-login
Body: { "identifier": "30020", "password": "mypassword" }
Response: { "token": "...", "role": "employee", "employeeId": 1, "name": "Surya M" }

POST /api/auth/set-password
Body: { "identifier": "30020", "password": "newpassword123" }
Response: { "message": "Password set successfully" }

GET /api/auth/me
Headers: Authorization: Bearer <token>
Response: { "role": "employee", "employeeId": 1, "name": "Surya M" }
```

---

## 5. App Screens & Navigation Structure

```
(app)
├── index.tsx                  → Splash / auth check (redirects to login or home)
├── (auth)/
│   ├── login.tsx              → Login screen
│   └── set-password.tsx       → First-time password setup screen
└── (tabs)/                    → Bottom tab navigator (shown after login)
    ├── home.tsx               → Dashboard / home screen
    ├── attendance.tsx         → Attendance history
    ├── leave.tsx              → Leave management
    └── profile.tsx            → Profile screen
        (nested screens — push navigation)
├── salary/
│   ├── index.tsx              → Salary slip list
│   └── [id].tsx               → Single salary slip detail
├── shift/
│   └── index.tsx              → Shift details
├── requests/
│   └── index.tsx              → Permission requests list + new request
├── settlement/
│   └── index.tsx              → Advances / loans
├── holidays/
│   └── index.tsx              → Holiday calendar
```

---

## 6. Screen-by-Screen Specification

---

### Screen 1 — Login

**File:** `(auth)/login.tsx`

**UI elements:**
- App logo / company name at top (UKTextiles)
- "Employee Login" heading
- Input: Employee Code (numeric keyboard)
- Input: Password (secure text, show/hide toggle)
- "Login" button (orange gradient)
- "First time? Set your password" link → navigates to set-password screen

**Behavior:**
- On submit → call `POST /api/auth/employee-login`
- On success → store token + employeeId in SecureStore → navigate to `/(tabs)/home`
- On error → show error message below the form (e.g., "Invalid credentials")
- Show loading spinner on the button while request is in progress

---

### Screen 2 — Set Password (First Time)

**File:** `(auth)/set-password.tsx`

**UI elements:**
- "Set Your Password" heading
- Input: Employee Code
- Input: New Password (min 8 characters)
- Input: Confirm Password
- "Set Password" button
- Back to Login link

**Behavior:**
- Validate passwords match before submitting
- Call `POST /api/auth/set-password`
- On success → show success message → redirect to login

---

### Screen 3 — Home / Dashboard

**File:** `(tabs)/home.tsx`

**API:** `GET /api/dashboard/employee-summary`

**UI elements:**
- Welcome banner: "Good morning, [Name]" with current date
- Summary cards (2 per row):
  - Present Days This Month
  - Absent Days This Month
  - Leave Balance (days remaining)
  - Pending Requests
- Quick action buttons (icon + label, 2×2 grid):
  - My Attendance → navigates to attendance tab
  - Salary Slips → navigates to salary screen
  - Apply Leave → navigates to leave tab
  - My Shift → navigates to shift screen
- Upcoming holidays section (next 3 holidays)
- Recent attendance (last 5 days as small status dots)

---

### Screen 4 — Attendance

**File:** `(tabs)/attendance.tsx`

**API:** `GET /api/attendance/employee/{employeeId}?month=6&year=2026`

**UI elements:**
- Month/Year selector (prev/next arrows)
- Summary row: Present | Absent | Late | On Leave
- Calendar grid view:
  - Each day is a colored square:
    - Green = Present
    - Red = Absent
    - Yellow = Late
    - Blue = On Leave
    - Grey = Weekend/Holiday
    - White = Future date
- Tap on a day → shows a bottom sheet with:
  - Date
  - Status (Present/Absent/Late)
  - First In time
  - Last Out time
  - Punch count
  - Source (Biometric / Manual)

---

### Screen 5 — Salary Slips

**File:** `salary/index.tsx`

**API:** `GET /api/my/salary-slips`

**UI elements:**
- List of salary slips, newest first
- Each card shows:
  - Month + Year (e.g., "June 2026")
  - Net Salary (large, bold, orange)
  - Status badge (Generated / Paid)
  - Arrow to open detail
- Tap → navigates to `salary/[id].tsx`

**Salary Slip Detail** (`salary/[id].tsx`):
- **API:** `GET /api/salary-slips/{id}`
- Full breakdown:
  - Employee name, code, department
  - Month/Year
  - Working days / Present days / Absent days / Late days
  - Earnings section: Basic Salary, HRA, Allowances
  - Deductions section: PF, ESI, Advances recovered, Late deductions
  - Net Salary (highlighted)
- "Download PDF" placeholder button (show toast: "Contact HR for physical copy")

---

### Screen 6 — Leave Management

**File:** `(tabs)/leave.tsx`

**APIs used:**
- `GET /api/leave-balances?employeeId={id}` — leave balance per type
- `GET /api/leave-requests?employeeId={id}` — past requests
- `GET /api/leave-types` — available leave types
- `POST /api/leave-requests` — submit new request

**UI elements:**

**Leave Balance section (top):**
- Horizontal scroll cards showing each leave type:
  - Leave type name (e.g., "Casual Leave")
  - Used / Total (e.g., 2 / 12)
  - Progress bar

**My Leave Requests section:**
- List of past requests with:
  - Leave type
  - Date range
  - Days count
  - Status badge: Pending (yellow) / Approved (green) / Rejected (red)

**"Apply Leave" floating button (bottom right):**
- Opens a bottom sheet / modal with form:
  - Leave Type (dropdown from leave-types API)
  - From Date (date picker)
  - To Date (date picker)
  - Reason (text area)
  - Submit button
- On success → refresh leave list → show success toast

---

### Screen 7 — Shift Details

**File:** `shift/index.tsx`

**API:** `GET /api/shift-assignments?employeeId={id}`

**UI elements:**
- Current shift card:
  - Shift name
  - Start time → End time
  - Grace period (minutes)
  - Working days (Mon–Sat / Mon–Fri)
  - Saturday off: Yes / No
- "Your schedule" — simple weekly timetable showing which days are working days
- Note: This is read-only. Employees cannot change their shift.

---

### Screen 8 — Permission Requests

**File:** `requests/index.tsx`

**APIs used:**
- `GET /api/permissions?employeeId={id}` — list of permission requests
- `POST /api/permissions` — submit new request

**What is a "permission"?**
A short absence during working hours (e.g., leaving early for a doctor's appointment, arriving late due to personal reason). Not the same as a full leave day.

**UI elements:**
- List of past permission requests:
  - Date
  - Type (Early Out / Late In / Short Leave)
  - Time / Duration
  - Reason
  - Status badge
- "New Request" button → bottom sheet form:
  - Type (dropdown: Early Out / Late In / Short Leave)
  - Date
  - Time
  - Reason
  - Submit

---

### Screen 9 — Settlement / Advances

**File:** `settlement/index.tsx`

**API:** `GET /api/advances?employeeId={id}`

**UI elements:**
- If no advances → empty state with illustration: "No advances or loans on record"
- If advances exist → list of cards:
  - Advance amount
  - Purpose / reason
  - Date taken
  - Total repaid so far
  - Remaining balance (highlighted in orange if > 0)
  - Repayment history (expandable)
- Read-only — employees cannot request advances from the app

---

### Screen 10 — Holidays

**File:** `holidays/index.tsx`

**API:** `GET /api/holidays`

**UI elements:**
- Year selector
- List of holidays grouped by month:
  - Holiday name
  - Date (formatted as "Monday, 15 August")
  - Type badge (National / Regional / Company)
- Upcoming holiday highlighted at the top
- Past holidays shown in lighter color

---

### Screen 11 — Profile

**File:** `(tabs)/profile.tsx`

**API:** `GET /api/employees/{employeeId}`

**UI elements:**
- Profile photo placeholder (initials avatar if no photo)
- Employee name + code + department + designation
- Status badge (Active)

**Information sections:**

*Personal Information:*
- Full Name
- Date of Birth
- Gender
- Email
- Phone

*Family Information:*
- Father's Name
- Mother's Name

*Employment Details:*
- Employee Code
- Employment Type (Staff / Production)
- Join Date
- Department
- Designation

*Bank Details:*
- Bank Name
- Account Number (last 4 digits shown, rest masked)
- IFSC Code

*Compliance:*
- PF Number
- ESI Number
- UAN Number

*Address:*
- Full address

**Change Password button** at the bottom:
- Opens a bottom sheet:
  - Current Password
  - New Password
  - Confirm New Password
  - Uses `POST /api/auth/set-password` (re-uses same endpoint)

**Logout button** — clears SecureStore → navigates to login

---

## 7. API Client Setup

Create `src/lib/api.ts`:

```typescript
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const api = axios.create({
  baseURL: process.env.EXPO_PUBLIC_API_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT token to every request
api.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 — token expired
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      await SecureStore.deleteItemAsync('auth_token');
      await SecureStore.deleteItemAsync('employee_id');
      // Navigate to login — use router.replace('/(auth)/login')
    }
    return Promise.reject(error);
  }
);

export default api;
```

---

## 8. What Employees CAN and CANNOT Do

### ✅ Allowed (Read)
- View own profile and personal information
- View own attendance history (any month/year)
- View own salary slips (all months)
- View own shift assignment
- View own leave balance
- View own leave requests (all statuses)
- View own permission requests
- View own advances / loan details
- View holiday list
- View own notifications

### ✅ Allowed (Write)
- Set / change own password
- Submit leave requests
- Submit permission requests

### ❌ Not allowed (never expose these)
- View or modify other employees' data
- Approve / reject leave requests
- Generate payroll
- Edit employee records
- View HR dashboard or reports
- Access any `/hr/` endpoints
- Manage shifts, departments, designations
- View audit logs
- Manage HR users or roles

> **Backend enforcement:** All restricted actions already require an `HR` role JWT token on the backend. Even if an employee guesses the URL, the API will return `403 Forbidden`. The mobile app should simply not show these options.

---

## 9. UI & Design Specification

Match the existing UKTextiles web application design exactly.

### Color Palette

```
Primary Orange:     #f97316
Orange Light:       #fb923c
Orange Dark:        #ea580c

Background Dark:    #0f172a
Background Card:    #1e293b
Background Input:   #0f172a

Text Primary:       #f8fafc
Text Secondary:     #94a3b8
Text Muted:         #64748b

Border Color:       #334155

Status Green:       #22c55e   (Present / Active / Approved)
Status Red:         #ef4444   (Absent / Rejected)
Status Yellow:      #f59e0b   (Pending / Late)
Status Blue:        #3b82f6   (On Leave)
Status Grey:        #475569   (Weekend / Holiday)

Gradient Primary:   linear from #f97316 to #fb923c
```

### Typography

- Font family: System default (San Francisco on iOS, Roboto on Android)
- Heading large: 28px, weight 800
- Heading medium: 20px, weight 700
- Card title: 16px, weight 600
- Body: 14px, weight 400
- Caption / label: 12px, weight 400, color Text Muted

### Card Style

```
backgroundColor: '#1e293b'
borderRadius: 16
padding: 16
shadowColor: '#000'
shadowOffset: { width: 0, height: 4 }
shadowOpacity: 0.3
shadowRadius: 8
elevation: 6   (Android)
```

### Button Style (Primary)

```
background: gradient from #f97316 to #fb923c (left to right)
borderRadius: 12
paddingVertical: 14
paddingHorizontal: 24
text: white, 16px, weight 700
```

### Input Style

```
backgroundColor: '#0f172a'
borderWidth: 1
borderColor: '#334155'
borderRadius: 10
paddingHorizontal: 16
paddingVertical: 12
color: '#f8fafc'
fontSize: 15
```

On focus:
```
borderColor: '#f97316'
```

### Animations

- Screen transitions: slide from right (default expo-router behavior)
- Card entry: fade in + translate Y from 20px to 0 using `moti`
- Loading skeleton: pulse animation using `moti`
- Bottom sheets: slide up from bottom using `react-native-reanimated`
- Button press: scale down to 0.97 on press using `Animated.spring`
- Status badges: appear with a small scale bounce

### Status Badges

```
Present:   background #dcfce7, text #16a34a
Absent:    background #fee2e2, text #dc2626
Late:      background #fef9c3, text #ca8a04
Pending:   background #fef3c7, text #d97706
Approved:  background #dcfce7, text #16a34a
Rejected:  background #fee2e2, text #dc2626
On Leave:  background #dbeafe, text #2563eb
```

### Loading State

Use skeleton placeholders (grey pulsing blocks) instead of spinners for all list and card loading states. Only use a spinner for button loading states (login, submit).

### Empty States

Every list screen must have a friendly empty state:
- Icon (MaterialCommunityIcons)
- Title: e.g., "No salary slips yet"
- Subtitle: e.g., "Your salary slips will appear here once HR generates payroll"

---

## 10. Folder Structure

```
uktextiles-employee-app/
├── app/
│   ├── _layout.tsx              → Root layout + QueryClientProvider + auth check
│   ├── index.tsx                → Splash screen → redirects based on auth
│   ├── (auth)/
│   │   ├── _layout.tsx
│   │   ├── login.tsx
│   │   └── set-password.tsx
│   └── (tabs)/
│       ├── _layout.tsx          → Bottom tab bar
│       ├── home.tsx
│       ├── attendance.tsx
│       ├── leave.tsx
│       └── profile.tsx
├── src/
│   ├── lib/
│   │   ├── api.ts               → Axios instance
│   │   └── auth.ts              → SecureStore helpers (getToken, setToken, clearToken)
│   ├── hooks/
│   │   ├── useAuth.ts           → Auth context + login/logout
│   │   ├── useEmployee.ts       → GET /employees/{id}
│   │   ├── useAttendance.ts     → GET /attendance/employee/{id}
│   │   ├── useSalarySlips.ts    → GET /my/salary-slips
│   │   ├── useLeave.ts          → Leave balance + requests
│   │   ├── useShift.ts          → Shift assignment
│   │   ├── useRequests.ts       → Permission requests
│   │   ├── useAdvances.ts       → Advances
│   │   └── useHolidays.ts       → Holidays
│   ├── components/
│   │   ├── ui/
│   │   │   ├── Card.tsx
│   │   │   ├── Button.tsx
│   │   │   ├── Input.tsx
│   │   │   ├── Badge.tsx
│   │   │   ├── Skeleton.tsx
│   │   │   ├── BottomSheet.tsx
│   │   │   └── EmptyState.tsx
│   │   ├── AttendanceCalendar.tsx
│   │   ├── SalarySlipCard.tsx
│   │   ├── LeaveCard.tsx
│   │   └── ProfileSection.tsx
│   └── constants/
│       ├── colors.ts            → All color values
│       └── theme.ts             → Spacing, border radius, shadow presets
├── assets/
│   ├── icon.png
│   └── splash.png
├── .env
├── app.json
├── package.json
└── tsconfig.json
```

---

## 11. package.json Dependencies

```json
{
  "dependencies": {
    "expo": "~51.0.0",
    "expo-router": "~3.5.0",
    "expo-secure-store": "~13.0.0",
    "expo-status-bar": "~1.12.0",
    "expo-font": "~12.0.0",
    "react": "18.2.0",
    "react-native": "0.74.0",
    "axios": "^1.7.0",
    "@tanstack/react-query": "^5.40.0",
    "react-native-reanimated": "~3.10.0",
    "moti": "^0.29.0",
    "@expo/vector-icons": "^14.0.0",
    "react-hook-form": "^7.51.0",
    "zod": "^3.23.0",
    "@hookform/resolvers": "^3.4.0",
    "date-fns": "^3.6.0",
    "react-native-safe-area-context": "4.10.0",
    "react-native-screens": "3.31.0",
    "@react-native-async-storage/async-storage": "1.23.1"
  }
}
```

---

## 12. Backend API Reference (Complete)

Base URL: `http://192.168.0.5:8000/api`

All authenticated requests require header:
```
Authorization: Bearer <jwt_token>
```

| Screen | Method | Endpoint | Notes |
|---|---|---|---|
| Login | POST | `/auth/employee-login` | body: `{identifier, password}` |
| Set Password | POST | `/auth/set-password` | body: `{identifier, password}` |
| Auth Check | GET | `/auth/me` | verify token |
| Dashboard | GET | `/dashboard/employee-summary` | pass `?employeeId=` |
| Profile | GET | `/employees/{id}` | get own profile |
| Attendance | GET | `/attendance/employee/{id}` | pass `?month=&year=` |
| Salary Slips | GET | `/my/salary-slips` | returns own slips only |
| Salary Slip Detail | GET | `/salary-slips/{id}` | single slip |
| Shift | GET | `/shift-assignments` | pass `?employeeId=` |
| Leave Balance | GET | `/leave-balances` | pass `?employeeId=` |
| Leave Types | GET | `/leave-types` | for dropdown |
| Leave Requests | GET | `/leave-requests` | pass `?employeeId=` |
| Apply Leave | POST | `/leave-requests` | body: `{employeeId, type, startDate, endDate, reason}` |
| Holidays | GET | `/holidays` | pass `?year=` |
| Permissions | GET | `/permissions` | pass `?employeeId=` |
| New Permission | POST | `/permissions` | body: `{employeeId, type, date, time, reason}` |
| Advances | GET | `/advances` | pass `?employeeId=` |
| Notifications | GET | `/notifications` | pass `?employeeId=` |

---

## 13. First-Time Employee Flow (Complete)

```
HR adds employee in portal
  → Employee receives their Employee Code (e.g., 30020)
  → Employee opens mobile app
  → Taps "First time? Set your password"
  → Enters Employee Code + new password (min 8 characters)
  → Password saved → redirected to Login
  → Logs in with Employee Code + password
  → Home screen shown
```

---

## 14. Init Commands

```bash
# Create the project
npx create-expo-app uktextiles-employee-app --template blank-typescript
cd uktextiles-employee-app

# Install all dependencies
npx expo install expo-router expo-secure-store react-native-reanimated \
  react-native-safe-area-context react-native-screens @react-native-async-storage/async-storage

npm install axios @tanstack/react-query moti react-hook-form zod @hookform/resolvers date-fns @expo/vector-icons

# Start development server
npx expo start

# Scan QR code with Expo Go app on your Android/iOS phone
# Phone must be on the same Wi-Fi network as the server
```

---

## 15. Important Notes for Development

1. **Test on a real device**, not an emulator, because the biometric device and Django server are on your office LAN (`192.168.0.x`). The phone must be on the same network.

2. **The JWT token does not expire immediately** but should be refreshed periodically. If a 401 error is received, clear the token and redirect to login.

3. **Employees can only see their own data.** The backend filters by the `employeeId` embedded in the JWT token for sensitive endpoints. Still, always pass `employeeId` explicitly in query params.

4. **`/my/salary-slips` is a special endpoint** that automatically returns only the logged-in employee's slips based on the JWT token — no `employeeId` param needed.

5. **Do not store sensitive data in AsyncStorage.** Always use `expo-secure-store` for the JWT token and employee ID.

6. **The backend is HTTP only** (no HTTPS on LAN). Expo Go and production builds both work with HTTP on local networks. On Android, add `android.usesCleartextTraffic: true` in `app.json` if needed.

```json
// app.json
{
  "expo": {
    "android": {
      "usesCleartextTraffic": true
    }
  }
}
```

7. **Match the web app colors exactly.** The primary orange is `#f97316`. The dark background is `#0f172a`. The card background is `#1e293b`.

---

*Backend: Django 5.1 + DRF · Database: PostgreSQL · Protocol: HTTP · Auth: JWT (HS256)*
*Device: eSSL e2008 biometric terminal · LAN: 192.168.0.x*
*Last updated: 2026-06-27*
