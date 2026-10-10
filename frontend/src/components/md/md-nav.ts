// The Managing Director portal's pages, in sidebar order. The backend keeps the same list in api/md_portal/pages.py
// (that is the one the assistant may suggest pages from, and /api/md/me serves): keep ids, titles and paths in step.
// md-nav.test.ts reads that file and fails when the two drift apart.
//
// Most pages are the HR portal's own page (same features, same buttons) with an Insights section added: see
// lib/md/embed.ts and components/md/embedded/. Payroll, Reports, Recruitment and Activity Logs are analytics pages.

import {
  Activity,
  BarChart3,
  Building2,
  CalendarDays,
  ClipboardList,
  Clock,
  Coffee,
  DoorOpen,
  FileClock,
  IndianRupee,
  LayoutDashboard,
  MapPinned,
  Search,
  UserCheck,
  UserPlus,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export type MdNavItem = {
  /** The page id the assistant and the backend use. */
  id: string;
  title: string;
  /** What the page is called in the sidebar when that differs from the title. */
  navLabel?: string;
  path: string;
  icon: LucideIcon;
};

export type MdNavGroup = { heading: string; items: MdNavItem[] };

const item = (id: string, title: string, icon: LucideIcon, path: string, navLabel?: string): MdNavItem => ({
  id,
  title,
  navLabel,
  path,
  icon,
});

export const MD_NAV_GROUPS: MdNavGroup[] = [
  { heading: "Overview", items: [item("dashboard", "Dashboard", LayoutDashboard, "/md/dashboard")] },
  {
    heading: "Workforce",
    items: [
      item("employees", "Employees", Users, "/md/employees"),
      item("branches", "Branches", Building2, "/md/branches"),
    ],
  },
  {
    heading: "Attendance",
    items: [
      item("attendance", "Staff Attendance", UserCheck, "/md/attendance/staff"),
      item("attendance-production", "Production Attendance", UsersRound, "/md/attendance/production"),
      item("geo-attendance", "Geo Attendance", MapPinned, "/md/geo-attendance"),
      item("attendance-search", "Attendance Search", Search, "/md/attendance/search"),
      item("report-log", "Report Log", FileClock, "/md/attendance/report-log"),
    ],
  },
  {
    heading: "Gate & visitors",
    items: [
      item("outpass", "Outpass", DoorOpen, "/md/outpass-visitors/outpass"),
      item("visitors", "Visitors", UsersRound, "/md/outpass-visitors/visitors"),
      item("tea-break", "Tea Break", Coffee, "/md/outpass-visitors/tea-break"),
    ],
  },
  {
    heading: "Time & requests",
    items: [
      item("shifts", "Manage Shift", Clock, "/md/shifts"),
      item("leave", "Leave & Holiday", CalendarDays, "/md/leave"),
      item("requests", "Requests", ClipboardList, "/md/requests"),
    ],
  },
  {
    heading: "Money & reports",
    items: [
      item("payroll", "Payroll Analysis", IndianRupee, "/md/payroll", "Payroll"),
      item("reports", "Reports", BarChart3, "/md/reports"),
    ],
  },
  {
    heading: "People & oversight",
    items: [
      item("recruitment", "Recruitment", UserPlus, "/md/recruitment"),
      item("activity", "Activity Logs", Activity, "/md/activity"),
    ],
  },
];

export const MD_NAV: MdNavItem[] = MD_NAV_GROUPS.flatMap((g) => g.items);

export const MD_NAV_BY_ID: Record<string, MdNavItem> = Object.fromEntries(MD_NAV.map((p) => [p.id, p]));

/** The page for a location ("/md/payroll" -> payroll, "/md/attendance/staff/x" -> attendance), or undefined outside the
 *  portal. The most specific path wins, and the comparison ignores case, as the router does. */
export function mdPageForPath(path: string): MdNavItem | undefined {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  let best: MdNavItem | undefined;
  for (const p of MD_NAV) {
    const own = p.path.toLowerCase();
    if ((clean === own || clean.startsWith(`${own}/`)) && (!best || own.length > best.path.length)) best = p;
  }
  return best;
}
