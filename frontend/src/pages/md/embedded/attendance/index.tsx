import AttendanceInsights from "./AttendanceInsights";
import AttendanceStrip from "./AttendanceStrip";

// Staff Attendance (page id "attendance"): the Insights tab and the strip above the page. Production Attendance shares the
// same module with the kind fixed to production (../attendance-production/index.tsx).

export default function StaffAttendanceInsights() {
  return <AttendanceInsights kind="staff" />;
}

export function Strip() {
  return <AttendanceStrip kind="staff" />;
}
