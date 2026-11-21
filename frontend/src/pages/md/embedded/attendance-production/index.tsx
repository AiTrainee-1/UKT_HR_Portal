import AttendanceInsights from "../attendance/AttendanceInsights";
import AttendanceStrip from "../attendance/AttendanceStrip";

// Production Attendance (page id "attendance-production"): the Staff Attendance Insights with the kind fixed to production
// (production Sundays are a weekly off, the shift-table rules judge the days, a day can earn up to 1.5 shifts).

export default function ProductionAttendanceInsights() {
  return <AttendanceInsights kind="production" />;
}

export function Strip() {
  return <AttendanceStrip kind="production" />;
}
