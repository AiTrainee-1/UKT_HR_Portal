import { useEffect, useRef } from "react";

/**
 * The shared Refresh button (components/PageRefreshBar.tsx) appears at the top of every HR page
 * EXCEPT the ones listed here. To skip a new page, add its path; a page that isn't listed gets the
 * button automatically.
 */
const PAGES_WITHOUT_REFRESH: (string | RegExp)[] = [
  // Data-entry pages: there is nothing to refresh, and a refetch must never replace what someone is typing.
  "/hr/employees/new",
  /^\/hr\/employees\/[^/]+\/edit$/,
  "/hr/employees/bulk-upload",
  "/hr/attendance/manual-import",
  "/hr/settings",
  // The report builder has its own full-height layout, and chat is live already.
  "/hr/reports",
  "/hr/chat",
  // These put their own Refresh button in the title row (RefreshButton, or an older one of their own).
  "/hr/requests",
  "/hr/activity-logs",
  "/hr/login-devices",
  "/hr/mobile-app-login",
  "/hr/whatsapp-control",
  "/hr/recruitment/dashboard",
  "/hr/recruitment/new-joinees",
  "/hr/recruitment/resignations",
  "/hr/recruitment/required-roles",
  "/hr/casual-leave",
  "/hr/leave",
  "/hr/shifts",
  "/hr/outpass-visitors",
  "/hr/outpass-visitors/outpass",
  "/hr/outpass-visitors/visitors",
  "/hr/outpass-visitors/tea-break",
  "/hr/geo-attendance",
  "/hr/missing-punch",
  "/hr/attendance/search",
];

export function pageHasRefresh(pathname: string): boolean {
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return !PAGES_WITHOUT_REFRESH.some((p) => (typeof p === "string" ? p === path : p.test(path)));
}

type Refresher = () => unknown | Promise<unknown>;
const refreshers = new Set<Refresher>();

/**
 * For a page that loads its data by hand instead of through TanStack Query: `fn` is called when the
 * shared Refresh button is pressed (the latest version of `fn` is always the one used).
 * Query-based pages need nothing -the button refetches every query on screen.
 */
export function usePageRefresh(fn: Refresher): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const run: Refresher = () => latest.current();
    refreshers.add(run);
    return () => {
      refreshers.delete(run);
    };
  }, []);
}

/** Runs every registered page refresher; one failing never stops the others. */
export async function runPageRefreshers(): Promise<void> {
  // async wrapper: a loader that throws synchronously must become a rejection, not abort the loop
  await Promise.allSettled([...refreshers].map(async (run) => run()));
}
