import { savesData } from "./idle";

// Faster moves between MD pages (2026-11-21): the code of the page behind a sidebar link (or a Dashboard figure) is
// fetched when the pointer comes onto the link or the keyboard reaches it, so the click usually finds it already in.
// These are the same modules App.tsx and MdHrApp.tsx load lazily (one module, one chunk, so nothing is fetched twice);
// keep the list in step with them. Fetching a module also runs it: page modules only define components, so that is free.

type Loader = () => Promise<unknown>;

const hrApp: Loader = () => import("@/components/md/MdHrApp");

// The MD's copies of the HR pages (and its own Dashboard) run inside MdHrApp: its chunk and the page's.
const EMBEDDED: [prefix: string, load: Loader][] = [
  ["/md/dashboard", () => import("@/pages/md/home")],
  ["/md/analytics", () => import("@/pages/hr/Analytics")],
  ["/md/employees", () => import("@/pages/hr/Employees")],
  ["/md/branches", () => import("@/pages/hr/Branches")],
  ["/md/attendance/search", () => import("@/pages/hr/AttendancePunchSearch")],
  ["/md/attendance/report-log", () => import("@/pages/hr/AttendanceReportLog")],
  ["/md/attendance/punch-view", () => import("@/pages/hr/PunchView")],
  ["/md/attendance", () => import("@/pages/hr/Attendance")],
  ["/md/biometric-connectors/device-status", () => import("@/pages/hr/BiometricDeviceStatus")],
  ["/md/geo-attendance", () => import("@/pages/hr/GeoAttendance")],
  ["/md/outpass-visitors", () => import("@/pages/hr/OutpassVisitors")],
  ["/md/shifts", () => import("@/pages/hr/ManageShift")],
  ["/md/leave", () => import("@/pages/hr/LeaveHoliday")],
  ["/md/requests", () => import("@/pages/hr/ApprovedRequests")],
];

// A page that may not exist yet (built by another round) is found by glob: no file, no entry, no broken build.
const optional = import.meta.glob<unknown>("/src/pages/md/MdCommunications.tsx");

// The MD's own pages, routed by App.tsx.
const OWN: [prefix: string, load: Loader][] = [
  ["/md/payroll", () => import("@/pages/md/MdPayroll")],
  ["/md/reports", () => import("@/pages/md/MdReports")],
  ["/md/recruitment", () => import("@/pages/md/MdRecruitment")],
  ["/md/activity", () => import("@/pages/md/MdActivity")],
  ["/md/approvals", () => import("@/pages/md/MdApprovals")],
  ["/md/loan-advance", () => import("@/pages/md/MdSettlement")],
  ...Object.values(optional).map((load): [string, Loader] => ["/md/communications", load]),
];

const done = new Set<string>();

const matches = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** The loaders for an MD address (empty for anything else). */
export function loadersFor(path: string): Loader[] {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  const own = OWN.find(([prefix]) => matches(clean, prefix));
  if (own) return [own[1]];
  const embedded = EMBEDDED.find(([prefix]) => matches(clean, prefix));
  return embedded ? [hrApp, embedded[1]] : [];
}

/** Fetch the code of the MD page at `path`, once, quietly (a failure only means it is fetched again on the click). */
export function prefetchMdRoute(path: string): void {
  const key = path.split(/[?#]/)[0].toLowerCase();
  if (done.has(key) || savesData()) return;
  done.add(key);
  for (const load of loadersFor(path)) {
    load().catch(() => done.delete(key));
  }
}

/** Props for a link: fetch its page when the pointer or the keyboard comes to it. */
export const prefetchProps = (path: string) => ({
  onPointerEnter: () => prefetchMdRoute(path),
  onFocus: () => prefetchMdRoute(path),
});

/** After the first page has settled: the MD copies' router (small), which almost every other page needs. */
export function prefetchMdHrApp(): void {
  if (savesData()) return;
  hrApp().catch(() => {});
}
