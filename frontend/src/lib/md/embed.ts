// The Managing Director's copies of the HR pages.
//
// The MD portal serves the HR pages themselves (the same components, so the same features and functionality), inside the MD
// shell, at /md/... instead of /hr/... . Those components know only HR addresses: they navigate to "/hr/employees/5" and
// match "/hr/attendance/staff". So the MD copies run in a nested router whose location is translated both ways:
//
//   browser /md/employees/5      <->   the pages see  /hr/employees/5
//   a page navigates /hr/leave   <->   the browser goes /md/leave
//
// A link to an HR page the MD portal does not copy goes to the nearest MD page (Payroll -> Payroll Analysis), so the MD
// never lands in the HR portal by clicking inside their own. md-portal.md section 10 has the whole design.

import { createContext, useCallback, useContext } from "react";
import { useBrowserLocation } from "wouter/use-browser-location";
import { toast } from "@/hooks/use-toast";

/** The HR pages (and everything under them) that the MD portal serves itself, as HR addresses. */
export const EMBEDDED_HR_PREFIXES: readonly string[] = [
  "/hr/dashboard",
  "/hr/employees",
  "/hr/branches",
  "/hr/attendance",
  "/hr/geo-attendance",
  "/hr/outpass-visitors",
  "/hr/shifts",
  "/hr/leave",
  "/hr/requests",
  // the Device Status page: the Attendance page has a button to it
  "/hr/Biometric-Connectors",
];

/** HR pages with no copy here but a nearby MD page: the HR address (and anything under it) -> that MD page. */
export const HR_TO_MD_PAGES: Readonly<Record<string, string>> = {
  "/hr/payroll": "/md/payroll",
  "/hr/production-payroll": "/md/payroll",
  "/hr/recruitment": "/md/recruitment",
  "/hr/activity-logs": "/md/activity",
  "/hr/settlement": "/md/requests",
  "/hr/missing-punch": "/md/requests",
  "/hr/casual-leave": "/md/leave",
  "/hr/reports": "/md/reports",
};

/** HR pages only the Admin may open, by what the MD sees them called. A link to one of these (or to any HR page that is
 *  neither copied nor mapped above) shows a notice instead of taking the MD anywhere. Checked before HR_TO_MD_PAGES, so a
 *  page under a mapped one (Recruitment -> Documents) can still be Admin-only. */
export const ADMIN_ONLY_HR_PAGES: Readonly<Record<string, string>> = {
  "/hr/user-management": "User Management",
  "/hr/settings": "Settings",
  "/hr/account-management": "Account Management",
  "/hr/recruitment/documents": "Employee Documents",
  "/hr/login-devices": "Login Devices",
  "/hr/mobile-app-login": "Mobile App Login",
  "/hr/whatsapp-control": "WhatsApp Control",
  "/hr/gmail-control": "Gmail Control",
  "/hr/compensation": "Compensation",
  "/hr/promotion": "Promotion",
  "/hr/increment": "Increment",
  "/hr/bonus": "Bonus",
  "/hr/id-cards": "ID Cards",
  "/hr/chat": "Chat",
  "/hr/notifications": "Notifications",
};

const startsWithSegment = (path: string, prefix: string) => {
  const p = path.toLowerCase();
  const x = prefix.toLowerCase();
  return p === x || p.startsWith(`${x}/`);
};

/** Splits "/hr/a?b=1#c" into the path and the rest ("?b=1#c"), which an address change must keep. */
function splitAddress(address: string): [string, string] {
  const at = address.search(/[?#]/);
  return at < 0 ? [address, ""] : [address.slice(0, at), address.slice(at)];
}

/** The name of the Admin-only HR page an address is (or points into), or null when it is not an Admin-only page. */
export function adminOnlyPageName(address: string): string | null {
  const [path] = splitAddress(address);
  if (!startsWithSegment(path, "/hr")) return null;
  let named: string | null = null;
  let best = -1;
  for (const [prefix, name] of Object.entries(ADMIN_ONLY_HR_PAGES)) {
    if (startsWithSegment(path, prefix) && prefix.length > best) {
      named = name;
      best = prefix.length;
    }
  }
  if (named) return named;
  // any other /hr/ page the portal neither copies nor maps is the HR portal's own
  const known =
    EMBEDDED_HR_PREFIXES.some((prefix) => startsWithSegment(path, prefix)) ||
    Object.keys(HR_TO_MD_PAGES).some((prefix) => startsWithSegment(path, prefix));
  return known || path === "/hr" ? null : "That page";
}

/** What the browser shows for an address an HR page asked for. Anything that is not an HR address is left alone. */
export function hrToMd(address: string): string {
  const [path, rest] = splitAddress(address);
  if (adminOnlyPageName(address)) return address;
  for (const prefix of EMBEDDED_HR_PREFIXES) {
    if (startsWithSegment(path, prefix)) return `/md${path.slice("/hr".length)}${rest}`;
  }
  for (const [prefix, target] of Object.entries(HR_TO_MD_PAGES)) {
    if (startsWithSegment(path, prefix)) return `${target}${rest}`;
  }
  return address;
}

/** What the pages see for the address in the browser's bar ("/md/employees/5" -> "/hr/employees/5"). */
export function mdToHr(address: string): string {
  const [path, rest] = splitAddress(address);
  if (!startsWithSegment(path, "/md")) return address;
  return `/hr${path.slice("/md".length)}${rest}`;
}

/** True when an HR address is one the MD portal copies (so its page, not the HR portal's, is what opens). */
export const isEmbeddedHrPath = (address: string): boolean => {
  const [path] = splitAddress(address);
  return EMBEDDED_HR_PREFIXES.some((prefix) => startsWithSegment(path, prefix));
};

// ── the router hook ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Navigate = (to: string, options?: { replace?: boolean; state?: unknown }) => void;

/** A wouter location hook for the nested router the MD copies run in: reads the browser's /md/... address as /hr/..., and
 *  turns the HR addresses the pages navigate to back into /md/... ones. */
export function useMdHrLocation(): [string, Navigate] {
  const [real, navigate] = useBrowserLocation();
  const go = useCallback<Navigate>(
    (to, options) => {
      const adminOnly = adminOnlyPageName(to);
      if (adminOnly) {
        // not somewhere the MD can go: say so, and stay (a link inside a copied page, say to User Management)
        toast({
          title: "Available only to the Admin",
          description: `${adminOnly === "That page" ? "That page" : adminOnly} can only be opened by the Admin.`,
        });
        return;
      }
      navigate(hrToMd(to), options);
    },
    [navigate],
  );
  return [mdToHr(real), go];
}

// ── "am I a copy?" ─────────────────────────────────────────────────────────────────────────────────────────────────────

const MdEmbedContext = createContext(false);

/** Wraps the nested router: every HrLayout below it renders the MD shell instead of the HR one. */
export const MdEmbedProvider = MdEmbedContext.Provider;

/** True inside an MD copy of an HR page. */
export const useMdEmbedded = (): boolean => useContext(MdEmbedContext);
