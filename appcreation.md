# UKTextiles — Employee Mobile App Architecture & Integration Plan

> **Purpose:** This document provides the complete blueprint for building the UKTextiles Employee Mobile Application that integrates seamlessly with the HR Web Portal.
> **Target Developer:** Use this document as the sole source of truth when building the mobile app.

---

## 1. App Overview

| Property | Value |
|---|---|
| **App Name** | UKTextiles Employee |
| **Platform** | React Native (Expo) — Android + iOS |
| **Target Users** | All employees (production + staff) |
| **Backend** | Django REST Framework (same HR Portal backend) |
| **Auth** | JWT Token-based (same JWT system) |
| **State Management** | Zustand + TanStack Query |
| **Offline Support** | React Query cache + AsyncStorage |

---

## 2. Authentication Flow

### 2.1 Login Sequence
```
Employee opens app
    → Enter Employee ID + Password
    → POST /api/auth/employee-login
    → Backend returns: { token, employeeId, name, role }
    → Store token in SecureStore (Expo)
    → Navigate to Home Dashboard
```

### 2.2 Token Management
- Token stored in `expo-secure-store` (never AsyncStorage for tokens)
- Token attached to every API request as `Authorization: Bearer <token>`
- On 401 response → clear token → redirect to login
- Auto-refresh not needed initially; token validity: 24 hours

### 2.3 API Endpoint
```
POST /api/auth/employee-login
Body: { employeeId: string, password: string }
Response: { token: string, employeeId: number, name: string, role: "employee" }
```

---

## 3. App Screen Flow

```
Splash Screen (2s)
    ├── Not logged in → Login Screen
    └── Logged in → Home (Dashboard)

Login Screen
    └── Successful login → Home

Bottom Navigation (5 tabs):
    1. Home (Dashboard)
    2. Attendance
    3. Leave
    4. Salary
    5. Profile

Home Dashboard
    ├── Welcome card (name, employee code)
    ├── Today's attendance status
    ├── Leave balance summary
    ├── Recent salary slip link
    ├── Pending requests count
    └── Quick action buttons

Attendance Screen
    ├── Monthly attendance calendar
    ├── Today's in/out time
    ├── Working hours this month
    ├── Shift details
    └── Attendance correction request button

Leave Screen
    ├── Leave balance by type (CL, SL, EL)
    ├── Apply Leave form
    ├── Leave history list
    └── Pending leave status

Salary Screen
    ├── Latest salary slip card
    ├── Month-wise salary history
    ├── Salary slip detail view
    └── Download PDF button

Profile Screen
    ├── Personal info (photo, name, ID, dept)
    ├── Contact details
    ├── Bank details (masked)
    ├── Shift information
    └── Reporting manager

Requests Screen (accessible from Home)
    ├── Submit new request (all types)
    ├── My request history
    └── Status tracking
```

---

## 4. Feature Screens Detail

### 4.1 Home Dashboard
```
Components:
- ProfileCard: employee photo, name, code, designation
- AttendanceWidget: Today's status (Present/Absent/Leave), punch in/out time
- LeaveBalanceWidget: CL: X, SL: X, EL: X
- SalaryWidget: Last month net pay, "View Slip" button
- QuickActions: [Apply Leave] [Raise Request] [View Shift]
- Alerts: Pending requests, leave approvals
```

### 4.2 Attendance Screen
```
Calendar View:
- Color coded: Green=Present, Red=Absent, Yellow=Leave, Blue=Holiday
- Tap a day → see punch IN/OUT times + hours worked

List below calendar:
- Shift start/end time
- Total hours this month
- Overtime hours

Attendance Correction:
- Tap "Correct Attendance" → form
- Select date, describe issue → POST /api/employee-requests
```

### 4.3 Leave Application
```
Leave Application Form:
- Leave Type selector (fetched from /api/leave-types)
- Start Date picker
- End Date picker
- Auto-calculate days (excluding weekends/holidays)
- Reason text field
- Submit → POST /api/leave-requests

Balance display:
- GET /api/leave-balances?employeeId=X&year=YYYY
- Show each type: allocated, used, remaining
```

### 4.4 Salary Slip
```
Slip card shows:
- Month, Year
- Gross Salary
- Total Deductions
- Net Salary (highlighted)
- Working Days vs Present Days

Detail view:
- Earnings breakdown (Basic, HRA, Allowances, Bonus)
- Deductions breakdown (PF, ESI, Advance)
- Net Pay

Download: GET /api/salary-slips?employeeId=X
```

### 4.5 Request Submission
```
Request Types:
1. Leave Request (redirects to Leave screen)
2. Salary Enquiry (text form)
3. Shift Correction (date + description)
4. Advance Request (amount + purpose)
5. Permission Request (date + duration + reason)
6. General Query (subject + message)

Submit: POST /api/employee-requests
Track: GET /api/employee-requests?employeeId=X
```

---

## 5. API Integration Map

All endpoints are on the same Django backend. Base URL is configured via environment variable.

### 5.1 Authentication APIs
```
POST   /api/auth/employee-login          Login with employee ID + password
GET    /api/auth/me                      Get current user info (requires token)
```

### 5.2 Employee Profile APIs
```
GET    /api/employees/{id}               Get employee profile
```

### 5.3 Attendance APIs
```
GET    /api/attendance-logs?employeeId=X&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
GET    /api/work-sessions?employeeId=X
```

### 5.4 Leave APIs
```
GET    /api/leave-types                  All active leave types
GET    /api/leave-balances?employeeId=X&year=YYYY
GET    /api/leave-requests?employeeId=X  Employee's leave history
POST   /api/leave-requests               Submit leave application
```

### 5.5 Salary APIs
```
GET    /api/my/salary-slips              Employee's salary slip history (auth required)
GET    /api/payroll?employeeId=X         Payroll records
```

### 5.6 Request APIs
```
GET    /api/employee-requests?employeeId=X   Employee's request history
POST   /api/employee-requests                Submit new request
```

### 5.7 Notifications
```
GET    /api/notifications?employeeId=X   All notifications
PUT    /api/notifications/{id}/read      Mark as read
```

---

## 6. Database Mapping

| App Screen | Backend Model(s) | API Endpoint |
|---|---|---|
| Login | Employee (password_hash) | /api/auth/employee-login |
| Profile | Employee, Department, Designation, Branch | /api/employees/{id} |
| Attendance Calendar | AttendanceLog, WorkSession | /api/attendance-logs |
| Shift Info | ShiftTemplate, EmployeeShiftAssignment | /api/shifts, /api/shift-assignments |
| Leave Balance | LeaveBalance, LeaveType | /api/leave-balances |
| Leave Application | LeaveRequest | /api/leave-requests |
| Salary Slips | SalarySlip | /api/my/salary-slips |
| Requests | EmployeeRequest | /api/employee-requests |
| Notifications | Notification | /api/notifications |

---

## 7. Tech Stack for Mobile App

```
Framework:    React Native + Expo (SDK 52+)
Language:     TypeScript
Navigation:   Expo Router (file-based routing)
State:        Zustand (global auth state)
API:          TanStack Query v5 (same as web)
HTTP:         Axios with interceptors
Auth Storage: expo-secure-store
UI Library:   React Native Paper + custom components
Calendar:     react-native-calendars
PDF:          react-native-pdf (for salary slip viewing)
Icons:        @expo/vector-icons (MaterialIcons)
Forms:        react-hook-form + zod
Date:         date-fns
Notifications: Expo Notifications (push)
Offline:      TanStack Query cache + NetInfo
```

---

## 8. Project Structure (Mobile App)

```
uktextile-employee-app/
├── app/
│   ├── (auth)/
│   │   └── login.tsx               Login screen
│   ├── (tabs)/
│   │   ├── index.tsx               Home Dashboard
│   │   ├── attendance.tsx          Attendance
│   │   ├── leave.tsx               Leave
│   │   ├── salary.tsx              Salary
│   │   └── profile.tsx             Profile
│   ├── requests/
│   │   ├── index.tsx               My Requests
│   │   └── new.tsx                 New Request form
│   └── _layout.tsx                 Root layout
├── components/
│   ├── AttendanceCalendar.tsx
│   ├── LeaveBalanceCard.tsx
│   ├── SalarySlipCard.tsx
│   ├── RequestForm.tsx
│   └── NotificationBell.tsx
├── lib/
│   ├── api-client.ts               Axios instance + interceptors
│   ├── auth-store.ts               Zustand auth store
│   └── query-client.ts             TanStack Query setup
├── hooks/
│   ├── useAttendance.ts
│   ├── useLeave.ts
│   ├── useSalary.ts
│   └── useRequests.ts
└── constants/
    ├── api.ts                      Base URL, endpoints
    └── theme.ts                    Colors, fonts
```

---

## 9. API Client Setup (Mobile)

```typescript
// lib/api-client.ts
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://192.168.1.100:8080/api';

export const apiClient = axios.create({ baseURL: API_BASE });

// Attach token to every request
apiClient.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync('uk_textile_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle 401 globally
apiClient.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (error.response?.status === 401) {
      await SecureStore.deleteItemAsync('uk_textile_token');
      // Navigate to login (use router from expo-router)
    }
    return Promise.reject(error);
  }
);
```

---

## 10. Offline Support Strategy

```
Strategy: Cache-first for read operations, queue for writes

Read operations (attendance, salary slips, leave balance):
- TanStack Query caches data in memory
- On network error, serve stale data with a banner: "Showing cached data"
- staleTime: 5 minutes for most data, 1 minute for attendance

Write operations (leave applications, requests):
- Show optimistic UI immediately
- Retry on network restore (use NetInfo + react-query mutation retry)
- Failed submissions stored in AsyncStorage queue

Offline banner:
- Use @react-native-community/netinfo
- Show yellow banner when offline: "You're offline — showing cached data"
```

---

## 11. Push Notifications

```
Events that trigger push notifications:
1. Leave approved/rejected
2. Payroll processed (salary slip ready)
3. Advance approved/rejected
4. Request status update
5. HR alert or announcement

Setup:
- Expo Push Notifications
- Token stored in Employee model (expo_push_token field — add to backend)
- Backend sends via Expo Push API after status changes

Backend endpoint to save token:
POST /api/my/push-token
Body: { token: string }
```

---

## 12. Security Considerations

```
1. Token Storage: Always use expo-secure-store (encrypted), never AsyncStorage
2. Certificate Pinning: Enable for production (prevent MITM)
3. No sensitive data in logs
4. Biometric unlock: Optional — use expo-local-authentication
5. Auto-logout after 8 hours of inactivity
6. All API calls over HTTPS in production
7. Jailbreak/Root detection: expo-device (warn user, don't block)
```

---

## 13. Future Sync Process

When employee data changes in HR Portal, mobile app should reflect:

```
Current (polling): TanStack Query refetches every 5 minutes on app focus
Future (real-time): WebSocket or Server-Sent Events for live updates

Sync priority:
1. Attendance (real-time or 1-min polling)
2. Leave status (5-min polling)
3. Notifications (5-min polling or push)
4. Salary slips (daily or on-demand)
5. Profile (on-demand)
```

---

## 14. Complete Prompt for Building the Mobile App

Use the following prompt when starting the mobile app development session:

---

```
Build a React Native (Expo) Employee Self-Service App for UKTextiles — a garments manufacturing company.

COMPANY: UKTextiles | Website: https://uktextiles.in
APP NAME: UKTextiles Employee
PLATFORM: React Native + Expo (SDK 52+), TypeScript, Expo Router

BACKEND: Django REST Framework running at http://[SERVER_IP]:8080/api
AUTH: JWT Bearer token — stored in expo-secure-store
TOKEN KEY: "uk_textile_token"

LOGIN:
- POST /api/auth/employee-login
- Body: { employeeId: string, password: string }
- Response: { token, employeeId, name, role: "employee" }

SCREENS (5 bottom tabs):
1. Home — welcome card, today attendance, leave balance, last salary, quick actions
2. Attendance — monthly calendar (color-coded), punch times, working hours
3. Leave — balance by type, apply leave form, history list
4. Salary — salary slip history, detail view with earnings/deductions breakdown
5. Profile — personal info, contact, bank details (masked), shift info

ADDITIONAL SCREENS:
- Requests — submit leave/advance/correction/general queries, track status
- Notifications — HR alerts and announcements

KEY APIS:
- GET /api/employees/{id} — profile
- GET /api/attendance-logs?employeeId=X&dateFrom=Y&dateTo=Z — punch logs
- GET /api/leave-types — leave type list
- GET /api/leave-balances?employeeId=X&year=Y — leave balances
- POST /api/leave-requests — apply leave
- GET /api/my/salary-slips — salary slips (token auth)
- POST /api/employee-requests — submit request
- GET /api/notifications?employeeId=X — notifications

UI REQUIREMENTS:
- Clean, modern mobile UI
- UKTextiles brand colors (deep blue/cyan accent)
- Dark header, white content areas
- Glassmorphism card for dashboard widgets
- Smooth transitions and animations (React Native Reanimated)
- Proper loading states and error handling
- Offline banner when no network

TECH STACK:
- expo-router (file-based navigation)
- @tanstack/react-query (data fetching + caching)
- zustand (auth state)
- axios (HTTP client with interceptors)
- expo-secure-store (token storage)
- react-native-calendars (attendance calendar)
- react-hook-form + zod (forms)
- date-fns (date formatting)
- @expo/vector-icons (MaterialIcons)

BUILD OUTPUT:
1. Complete file structure (all screens + components + hooks + lib files)
2. API client with auth interceptor
3. All 5 tab screens fully functional
4. Request form with all request types
5. Salary slip viewer
6. Leave application with balance display
7. Expo app.json + package.json

The backend is already built and running. Do not modify the backend.
Preserve UKTextiles branding throughout the app.
```

---

## 15. Checklist Before Starting Mobile Development

- [ ] Backend HR Portal is fully deployed and accessible on local network
- [ ] All API endpoints tested via Postman/Thunder Client
- [ ] Employee test accounts created in HR Portal
- [ ] PostgreSQL database has sample data (employees, attendance logs, salary slips)
- [ ] SMTP configured for email notifications
- [ ] Push notification plan finalized (Expo or FCM)
- [ ] App signing certificates ready (Android keystore, Apple certificates)
- [ ] Company logo PNG exported (512x512 for app icon, 1024x1024 for store)

---

*Document version: 1.0 | Created: 2026-06-22 | UKTextiles Enterprise Platform*
