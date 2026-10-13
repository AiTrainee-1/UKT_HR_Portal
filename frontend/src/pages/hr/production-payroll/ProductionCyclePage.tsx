import { useEffect, useState } from "react";
import { Factory, Settings as SettingsIcon, Users } from "lucide-react";
import { Link } from "wouter";
import HrLayout from "@/components/HrLayout";
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
import { SetupNeeded, UnassignedNotice, cycleSettingsHref } from "./CycleNotices";
import { EmployeesTab } from "./EmployeesTab";
import { PayrollTab } from "./PayrollTab";
import { PayslipTab } from "./PayslipTab";
import { SalaryTab } from "./SalaryTab";
import { cycleBlurb, defaultPeriod } from "./logic";

type TabValue = "payroll" | "employees" | "salary" | "payslip";

/**
 * One Production Payroll page: Weekly, BiWeekly or Monthly (four weeks). Everything on it is about the production
 * employees assigned to that cycle only; the period shown in the Payroll and Employees tabs is chosen once, here.
 */
export default function ProductionCyclePage({ cycle }: { cycle: PayCycle }) {
  const info = PAY_CYCLE_INFO[cycle];
  const [tab, setTab] = useState<TabValue>("payroll");
  // `picked` is the period the user chose (or the one just generated); until then the page follows the next due one.
  const [picked, setPicked] = useState<CyclePeriod | null>(null);
  // An older period is opened by a date inside it: the list is asked for it, then the page moves onto it.
  const [around, setAround] = useState<string | null>(null);
  const [wanted, setWanted] = useState<string | null>(null);
  const cycles = useProductionCycles();
  const periods = useProductionPeriods(cycle, around);
  const summary = cycles.data?.cycles.find((c) => c.cycle === cycle);
  const period = picked ?? defaultPeriod(periods.data?.periods ?? []);
  const needsSetup = !!summary && !summary.configured;

  useEffect(() => {
    if (!wanted || !periods.data || periods.isFetching) return;
    const holding = periods.data.periods.find((p) => p.periodStart <= wanted && wanted <= p.periodEnd);
    if (holding) setPicked({ periodStart: holding.periodStart, periodEnd: holding.periodEnd });
    setWanted(null);
  }, [wanted, periods.data, periods.isFetching]);

  const pickDate = (date: string) => {
    setAround(date);
    setWanted(date);
  };

  return (
    <HrLayout>
      <div className="space-y-6" data-testid={`production-payroll-${cycle}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
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
          </div>
        </div>

        <UnassignedNotice unassigned={cycles.data?.unassigned ?? 0} />

        <PillTabs
          items={[
            { value: "payroll", label: "Payroll" },
            { value: "employees", label: "Employees", count: summary?.assigned },
            { value: "salary", label: "Salary" },
            { value: "payslip", label: "Payslip" },
          ]}
          value={tab}
          onChange={(v) => setTab(v as TabValue)}
          baseColor="#d97706"
        />

        <Separator />

        {(tab === "payroll" || tab === "employees") && needsSetup ? (
          <SetupNeeded cycle={cycle} problem={summary?.configError ?? "The period of this cycle is not set up."} />
        ) : tab === "payroll" ? (
          <PayrollTab
            cycle={cycle}
            period={period}
            periods={periods.data}
            periodsLoading={periods.isLoading}
            onPeriodChange={setPicked}
            onPickDate={pickDate}
          />
        ) : tab === "employees" ? (
          <EmployeesTab
            cycle={cycle}
            period={period}
            periods={periods.data}
            periodsLoading={periods.isLoading}
            onPeriodChange={setPicked}
            onPickDate={pickDate}
          />
        ) : tab === "salary" ? (
          <SalaryTab cycle={cycle} />
        ) : (
          <PayslipTab cycle={cycle} />
        )}
      </div>
    </HrLayout>
  );
}
