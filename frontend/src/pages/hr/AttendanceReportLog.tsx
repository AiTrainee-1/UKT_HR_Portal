import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { AlarmClock, CalendarDays, CalendarX2, ClipboardList } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { PillTabs } from "@/components/ui/pill-tabs";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { moduleForPath } from "@/lib/permission-modules";
import { ViewOnlyTabNote, pickVisible, useLevel, useViewOnlyLock, visibleItems } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { AttendanceSheetContent } from "./AttendanceSheet";
import { ALL } from "./leave/logic";
import type { DailyFilters } from "./report-log/DailyFilters";
import LatePenaltyCard from "./report-log/LatePenaltyCard";
import LateTab from "./report-log/LateTab";
import LeaveTab from "./report-log/LeaveTab";
import { TAB_LABELS, localToday, parseTab, searchWithTab, type TabKey } from "./report-log/logic";

/** The sub-tab the address names (`?tab=monthly|leave|late`; the old `daily` is the leave report). */
const readTab = (): TabKey => {
  try {
    return parseTab(new URLSearchParams(window.location.search).get("tab"));
  } catch {
    return "monthly";
  }
};

/** Puts the tab in the address (replacing the entry, so Back leaves the page) and keeps every other query key. */
const writeTab = (tab: TabKey) => {
  try {
    const url = new URL(window.location.href);
    url.search = searchWithTab(url.search, tab);
    window.history.replaceState(window.history.state, "", url);
  } catch {
    /* the address just is not updated */
  }
};

const TAB_ITEMS: { value: TabKey; label: string; icon: ReactNode }[] = [
  { value: "monthly", label: TAB_LABELS.monthly, icon: <CalendarDays size={14} /> },
  { value: "leave", label: TAB_LABELS.leave, icon: <CalendarX2 size={14} /> },
  { value: "late", label: TAB_LABELS.late, icon: <AlarmClock size={14} /> },
];

/** Each sub-tab's own permission key (Account Management -> Roles & Permissions); one without a setting follows the page. */
const TAB_KEY: Record<TabKey, string> = {
  monthly: "attendance.report_log.monthly",
  leave: "attendance.report_log.leave",
  late: "attendance.report_log.late",
};

/**
 * Report Log: three sub-tabs.
 *   Monthly Report: the Attendance Sheet grid (AttendanceSheetContent, shared with what used to be its own sheet page) plus
 *     the payroll-adjacent Late-Penalty Breakdown, which the sheet does not cover.
 *   Daily Leave Report (was Daily Report): the absent staff of one date, the Informed / Not informed call for each, and the
 *     Excel / PDF / Image of the paper "STAFF LEAVE LIST".
 *   Daily Late Report: the staff who arrived late on one date, per unit, with their first punch, and the same three downloads.
 * The tab is in the address (`?tab=`), so a refresh or a shared link opens the same one.
 */
export default function AttendanceReportLog() {
  const [asked, setTab] = useState<TabKey>(readTab);
  // the two daily lists share their date, department and search: switching between them keeps what was picked
  const [daily, setDaily] = useState<DailyFilters>(() => ({ date: localToday(), department: ALL, search: "" }));

  const { data: settings } = usePayrollSettings();
  const simpleMode = settings?.attendanceMode === "simple";

  // Only the sub-tabs this role may see are offered; a hidden one asked for (by the address too) opens the first it may see.
  const { user } = useAuth();
  const [location] = useLocation();
  const level = useLevel();
  const items = visibleItems(TAB_ITEMS, (t) => TAB_KEY[t.value], level);
  const tab = pickVisible(
    asked,
    items.map((t) => t.value),
  );
  const tabViewOnly =
    items.length > 0 && !isRouteViewOnly(user, location, moduleForPath(location)) && level(TAB_KEY[tab]) === "view";
  useViewOnlyLock(tabViewOnly, tab);
  useEffect(() => {
    if (tab !== asked) writeTab(tab);
  }, [tab, asked]);

  const selectTab = (next: string) => {
    const key = parseTab(next);
    setTab(key);
    writeTab(key);
  };

  return (
    <HrLayout>
      <div className="space-y-5" data-testid="report-log-page">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <ClipboardList size={22} className="text-indigo-600" />
              Report Log
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The colored attendance register, the late-penalty breakdown behind payroll&apos;s deductions, and the
              daily leave and late lists
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide",
              simpleMode ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700",
            )}
            title="Attendance calculation mode: change it in Settings → Attendance"
            data-testid="mode-badge"
          >
            {simpleMode ? "Simple Mode" : "Strict Mode"}
          </span>
        </div>

        {items.length === 0 ? (
          <p
            className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground"
            data-testid="nothing-open"
          >
            Nothing on this page is open to your role.
          </p>
        ) : (
          <>
            <div className="max-w-full overflow-x-auto pb-1" data-testid="report-log-tabs">
              <PillTabs items={items} value={tab} onChange={selectTab} baseColor="#4f46e5" size="sm" />
            </div>

            <ViewOnlyTabNote show={tabViewOnly} />

            {tab === "monthly" && (
              <div className="space-y-5" data-testid="monthly-tab">
                <AttendanceSheetContent />
                <LatePenaltyCard />
              </div>
            )}
            {tab === "leave" && <LeaveTab filters={daily} onFilters={setDaily} />}
            {tab === "late" && <LateTab filters={daily} onFilters={setDaily} />}
          </>
        )}
      </div>
    </HrLayout>
  );
}
