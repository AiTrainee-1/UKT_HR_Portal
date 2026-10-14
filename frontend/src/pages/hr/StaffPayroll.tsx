import { useEffect, useMemo } from "react";
import { CreditCard, Eye } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { PayslipsPanel } from "@/components/payroll/panels/payslips";
import { useIsRefreshingPayroll, useRefreshPayroll } from "@/components/payroll/kit/use-payroll-actions";
import { STAFF_PAYROLL_PATH, useUrlParams } from "@/components/payroll/kit/url-state";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Separator } from "@/components/ui/separator";
import { isRouteViewOnly, permissionLevel, useAuth } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { PayrollTab } from "./staff-payroll/PayrollTab";
import { PeriodControls } from "./staff-payroll/PeriodControls";
import { SalaryTab } from "./staff-payroll/SalaryTab";
import { STAFF_TABS, STAFF_URL_DEFAULTS, isStaffTab, resolvePeriod, type StaffTab } from "./staff-payroll/logic";

// Staff Payroll's 3 sub-tabs map to 3 independently-permissioned module keys (unchanged from before this page consolidated
// them into one shell) - mirrors Settings.tsx's SETTINGS_TAB_MODULE pattern for merging several independently-gated
// experiences into one tabbed page.
const STAFF_PAYROLL_TAB_MODULE: Record<StaffTab, string> = {
  payroll: "payroll",
  salary: "salary",
  payslip: "salary_slip",
};

const TAB_LABEL: Record<StaffTab, string> = { payroll: "Payroll", salary: "Salary", payslip: "Payslip" };

/**
 * Monthly payroll for staff employees - Payroll, Salary and Payslip in one place. The page's state (tab, month, view, filters)
 * lives in the address, so a reload, a shared link and Back from a payroll's details page all land on the same screen.
 */
export default function StaffPayroll() {
  const { user } = useAuth();
  const [url, setUrl] = useUrlParams(STAFF_URL_DEFAULTS);
  const { month, year } = useMemo(() => resolvePeriod({ month: url.month, year: url.year }), [url.month, url.year]);
  const refresh = useRefreshPayroll();
  const refreshing = useIsRefreshingPayroll();

  const tabLevel = (t: StaffTab) => permissionLevel(user, STAFF_PAYROLL_TAB_MODULE[t] ?? "payroll");
  const visibleTabs = STAFF_TABS.filter((t) => tabLevel(t) !== "hidden");
  // Land on the first sub-tab this role can actually see if the one in the address (or the default, "payroll") is hidden.
  const requested: StaffTab = isStaffTab(url.tab) ? url.tab : "payroll";
  const tab: StaffTab = tabLevel(requested) === "hidden" ? (visibleTabs[0] ?? requested) : requested;
  const isTabViewOnly = tabLevel(tab) === "view";
  // When no tab of the role grants edit, HrLayout already shows its View Only banner (and locks the page): this page's own
  // notice is for a mixed role (edit on one tab, view on another), so it is not shown twice.
  const layoutShowsBanner = isRouteViewOnly(user, STAFF_PAYROLL_PATH, moduleForPath(STAFF_PAYROLL_PATH));

  // Only the active tab is mounted (conditional render below, same as Settings.tsx's Radix Tabs), so locking document.body
  // whenever the active tab is view-only only ever touches that one tab's controls.
  useEffect(() => {
    if (!isTabViewOnly) return;
    const relock = () => lockMutatingControls(document.body);
    relock();
    const observer = new MutationObserver(relock);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isTabViewOnly, tab]);

  const changePeriod = (m: number, y: number) => setUrl({ month: String(m), year: String(y) });
  // each tab has its own filters: a tab change keeps only the month, never the old tab's view or filters
  const changeTab = (next: string) => setUrl({ tab: next });

  return (
    <HrLayout>
      <div className="space-y-6" data-testid="staff-payroll-page">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <CreditCard size={22} className="text-indigo-600" /> Payroll
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              Monthly payroll for staff employees - generate it, check every rule and issue behind it, and read the
              salary statement and payslips in one place.
            </p>
          </div>
          <PeriodControls
            month={month}
            year={year}
            onChange={changePeriod}
            onRefresh={() => void refresh()}
            refreshing={refreshing}
            showPeriod={tab !== "payslip"}
          />
        </div>

        <PillTabs
          items={visibleTabs.map((t) => ({ value: t, label: TAB_LABEL[t] }))}
          value={tab}
          onChange={changeTab}
          baseColor="#4f46e5"
        />

        {isTabViewOnly && !layoutShowsBanner && (
          <div
            className="flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold"
            style={{
              background: "rgba(245,158,11,0.08)",
              color: "#b45309",
              boxShadow: "inset 3px 3px 8px rgba(245,158,11,0.06), inset -3px -3px 8px rgba(255,255,255,0.9)",
            }}
          >
            <Eye size={15} strokeWidth={2} />
            View only - browse and inspect freely, changes can't be saved.
          </div>
        )}

        <Separator />

        {tab === "payroll" && (
          <PayrollTab month={month} year={year} url={url} setUrl={setUrl} onPeriodChange={changePeriod} />
        )}
        {tab === "salary" && <SalaryTab month={month} year={year} url={url} setUrl={setUrl} />}
        {tab === "payslip" && (
          <PayslipsPanel kind="staff" accent="indigo" month={month} year={year} onPeriodChange={changePeriod} />
        )}
      </div>
    </HrLayout>
  );
}
