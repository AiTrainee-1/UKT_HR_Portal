import { ReportLogPage } from "./AttendanceReportLog";

/**
 * Production Report Log (/hr/attendance/production-report-log, owner 2026-11-16): the staff Report Log's tabs, filters,
 * reports and downloads for production employees only. One page component serves both (AttendanceReportLog.tsx); this
 * file only gives the route its own lazy chunk name.
 */
export default function ProductionReportLog() {
  return <ReportLogPage kind="production" />;
}
