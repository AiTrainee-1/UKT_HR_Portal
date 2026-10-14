import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Factory, Loader2, RefreshCw, Settings as SettingsIcon, Users } from "lucide-react";
import { Link } from "wouter";
import HrLayout from "@/components/HrLayout";
import { EmptyNote, PayrollLoader } from "@/components/payroll/kit/parts";
import { useIsRefreshingPayroll, useRefreshPayroll } from "@/components/payroll/kit/use-payroll-actions";
import { periodParam, useUrlParams } from "@/components/payroll/kit/url-state";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Separator } from "@/components/ui/separator";
import {
  PAY_CYCLE_INFO,
  useProductionCycles,
  useProductionPeriods,
  type CyclePeriod,
  type PayCycle,
} from "@/lib/api-client/custom-hooks";
import { SetupNeeded, UnassignedNotice, cycleSettingsHref, errorText } from "./CycleNotices";
import { EmployeesTab } from "./EmployeesTab";
import {
  PRODUCTION_TABS,
  PRODUCTION_URL_DEFAULTS,
  cycleBlurb,
  defaultPeriod,
  isProductionTab,
  periodFromUrl,
  resolveSlipMonth,
  samePeriod,
  type ProductionTab,
} from "./logic";
import { PayrollTab } from "./PayrollTab";
import { PayslipTab } from "./PayslipTab";
import { PeriodPicker } from "./PeriodPicker";
import { SalaryTab } from "./SalaryTab";

const TAB_LABEL: Record<ProductionTab, string> = {
  payroll: "Payroll",
  employees: "Employees",
  salary: "Salary",
  payslip: "Payslip",
};

/**
 * One Production Payroll page: Weekly, BiWeekly or Monthly (four weeks). Everything on it is about the production
 * employees assigned to that cycle only. The page's state (tab, pay period, view, filters) lives in the address, so a
 * reload, a shared link and Back from a payroll's details page all land on the same screen; the pay period is chosen once,
 * here, for the Payroll, Employees and Salary tabs.
 */
export default function ProductionCyclePage({ cycle }: { cycle: PayCycle }) {
  const info = PAY_CYCLE_INFO[cycle];
  const [url, setUrl] = useUrlParams(PRODUCTION_URL_DEFAULTS);
  const tab: ProductionTab = isProductionTab(url.tab) ? url.tab : "payroll";
  const slipMonth = useMemo(() => resolveSlipMonth({ month: url.month, year: url.year }), [url.month, url.year]);
  const refresh = useRefreshPayroll();
  const refreshing = useIsRefreshingPayroll();

  // An older period is opened by a date inside it: the list is asked for it, then the page moves onto it.
  const [around, setAround] = useState<string | null>(null);
  const [wanted, setWanted] = useState<string | null>(null);
  const cycles = useProductionCycles();
  const periods = useProductionPeriods(cycle, around);
  const summary = cycles.data?.cycles.find((c) => c.cycle === cycle);
  const needsSetup = !!summary && !summary.configured;

  // The period in the address, else the one the cycle is due to pay next (the page follows it until one is chosen).
  const urlPeriod = useMemo(() => periodFromUrl(url.period), [url.period]);
  const periodRows = periods.data?.periods;
  const period = useMemo(() => urlPeriod ?? defaultPeriod(periodRows ?? []), [urlPeriod, periodRows]);

  useEffect(() => {
    if (!wanted || !periods.data || periods.isFetching) return;
    const holding = periods.data.periods.find((p) => p.periodStart <= wanted && wanted <= p.periodEnd);
    if (holding) setUrl({ period: periodParam(holding) });
    setWanted(null);
  }, [wanted, periods.data, periods.isFetching, setUrl]);

  // A period in the address that the list does not offer (an old one, after a reload or Back) is added to the list.
  useEffect(() => {
    if (!urlPeriod || around || wanted || !periods.data || periods.isFetching) return;
    if (!periods.data.periods.some((p) => samePeriod(p, urlPeriod))) setAround(urlPeriod.periodStart);
  }, [urlPeriod, around, wanted, periods.data, periods.isFetching]);

  const pickDate = (date: string) => {
    setAround(date);
    setWanted(date);
  };
  const changePeriod = useCallback((next: CyclePeriod) => setUrl({ period: periodParam(next) }), [setUrl]);
  const changeSlipMonth = (month: number, year: number) => setUrl({ month: String(month), year: String(year) });
  // Every tab keeps its own filters under its own keys, so switching tabs never mixes them (and the filters of a tab
  // that was left are still there when it is opened again).
  const changeTab = (next: string) => setUrl({ tab: next });

  const showPeriodBar = tab !== "payslip" && !cycles.isLoading && !needsSetup;

  let body: ReactNode;
  if (tab === "payslip") {
    body = <PayslipTab cycle={cycle} month={slipMonth.month} year={slipMonth.year} onPeriodChange={changeSlipMonth} />;
  } else if (cycles.isLoading) {
    body = <PayrollLoader label="Loading the pay cycle" />;
  } else if (needsSetup) {
    body = <SetupNeeded cycle={cycle} problem={summary?.configError ?? "The period of this cycle is not set up."} />;
  } else if (!period) {
    body = periods.isError ? (
      <EmptyNote
        icon={AlertTriangle}
        title="The pay periods could not be loaded"
        hint={errorText(periods.error, "The server did not answer.")}
        testId="pcp-periods-error"
        action={
          <Button variant="outline" className="mt-2" onClick={() => void periods.refetch()}>
            Try again
          </Button>
        }
      />
    ) : periods.isLoading ? (
      <PayrollLoader label="Loading the pay periods" />
    ) : (
      <EmptyNote
        icon={AlertTriangle}
        title={`No pay period is available for the ${info.label} cycle`}
        hint="Check the period rule of this cycle in Settings."
        testId="pcp-no-period"
      />
    );
  } else if (tab === "payroll") {
    body = <PayrollTab cycle={cycle} period={period} url={url} setUrl={setUrl} onPeriodChange={changePeriod} />;
  } else if (tab === "employees") {
    body = <EmployeesTab cycle={cycle} period={period} url={url} setUrl={setUrl} onPeriodChange={changePeriod} />;
  } else {
    body = <SalaryTab cycle={cycle} period={period} url={url} setUrl={setUrl} />;
  }

  return (
    <HrLayout>
      <div className="space-y-6" data-testid={`production-payroll-${cycle}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex flex-wrap items-center gap-2 text-2xl font-black text-gray-900">
              <Factory size={22} className="text-amber-600" /> Production Payroll
              <span
                className="rounded-full bg-amber-100 px-3 py-0.5 text-sm font-bold text-amber-800"
                data-testid="pcp-cycle-badge"
              >
                {info.label}
              </span>
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{cycleBlurb(cycle)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm" className="h-9 gap-2">
              <Link href="/hr/employees/productionEmployee">
                <Users size={14} /> Production Employees
                {summary ? <span className="text-muted-foreground">({summary.assigned})</span> : null}
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="h-9 gap-2">
              <Link href={cycleSettingsHref(cycle)}>
                <SettingsIcon size={14} /> {info.label} settings
              </Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9 rounded-xl"
              aria-label="Reload the payroll figures"
              title="Reload the payroll figures"
              onClick={() => void refresh()}
              disabled={refreshing}
              data-testid="pcp-refresh"
            >
              {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </Button>
          </div>
        </div>

        <UnassignedNotice unassigned={cycles.data?.unassigned ?? 0} />

        <PillTabs
          items={PRODUCTION_TABS.map((t) => ({
            value: t,
            label: TAB_LABEL[t],
            ...(t === "employees" && summary ? { count: summary.assigned } : {}),
          }))}
          value={tab}
          onChange={changeTab}
          baseColor="#d97706"
        />

        <Separator />

        {showPeriodBar && (
          <PeriodPicker
            periods={periods.data}
            period={period}
            onChange={changePeriod}
            onPickDate={pickDate}
            loading={periods.isLoading}
          />
        )}

        {body}
      </div>
    </HrLayout>
  );
}
