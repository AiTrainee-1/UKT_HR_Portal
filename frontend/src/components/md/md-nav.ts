// The Managing Director portal's pages, in sidebar order. The backend keeps the same list in api/md_portal/pages.py
// (that is the one the assistant may suggest pages from, and /api/md/me serves): keep ids, titles and paths in step.
// md-nav.test.ts reads that file and fails when the two drift apart.

import {
  Activity,
  BarChart3,
  Coffee,
  DoorOpen,
  IndianRupee,
  LayoutDashboard,
  UserCheck,
  UserPlus,
  Users,
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

const item = (id: string, title: string, icon: LucideIcon, navLabel?: string): MdNavItem => ({
  id,
  title,
  navLabel,
  path: `/md/${id}`,
  icon,
});

export const MD_NAV_GROUPS: MdNavGroup[] = [
  { heading: "Overview", items: [item("dashboard", "Dashboard", LayoutDashboard)] },
  {
    heading: "Workforce",
    items: [
      item("attendance", "Attendance Analytics", UserCheck, "Attendance"),
      item("employees", "Employees", Users),
      item("visitors", "Outpass & Visitors", DoorOpen),
      item("tea-break", "Tea Break", Coffee),
    ],
  },
  {
    heading: "Money & reports",
    items: [item("payroll", "Payroll Analysis", IndianRupee, "Payroll"), item("reports", "Reports", BarChart3)],
  },
  {
    heading: "People & oversight",
    items: [item("recruitment", "Recruitment", UserPlus), item("activity", "Activity Logs", Activity)],
  },
];

export const MD_NAV: MdNavItem[] = MD_NAV_GROUPS.flatMap((g) => g.items);

export const MD_NAV_BY_ID: Record<string, MdNavItem> = Object.fromEntries(MD_NAV.map((p) => [p.id, p]));

/** The page for a location ("/md/payroll" -> payroll), or undefined outside the portal. */
export function mdPageForPath(path: string): MdNavItem | undefined {
  const clean = path.split("?")[0].replace(/\/+$/, "");
  return MD_NAV.find((p) => clean === p.path || clean.startsWith(`${p.path}/`));
}
