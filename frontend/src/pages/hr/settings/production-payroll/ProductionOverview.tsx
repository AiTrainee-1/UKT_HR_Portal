import type { ReactNode } from "react";
import { Factory } from "lucide-react";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { SettingsSection } from "../kit/SettingBlock";
import { ProductionPfOrder } from "../payroll/ProductionPfOrder";
import { TextLink } from "../payroll/ui";
import { CYCLE_INFO, CYCLES, cycleAnchor, describeCycleRule } from "./cycles";
import { cycleLateRules, savedProduction } from "./sections";

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5 rounded-xl bg-white/70 p-3 ring-1 ring-slate-100">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-black text-amber-800">
        {n}
      </span>
      <div className="min-w-0 space-y-1 text-[12px] leading-snug text-gray-700">
        <p className="text-[13px] font-bold text-gray-900">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** A list of links inside a sentence: "Weekly, BiWeekly and Monthly". */
function CycleLinks({ to }: { to: (cycle: (typeof CYCLES)[number]) => string }) {
  return (
    <>
      {CYCLES.map((cycle, i) => (
        <span key={cycle}>
          {i === 0 ? "" : i === CYCLES.length - 1 ? " and " : ", "}
          <TextLink to={to(cycle)}>{CYCLE_INFO[cycle].label}</TextLink>
        </span>
      ))}
    </>
  );
}

/**
 * How a production payslip is put together, and where each part is set. Production pay is configured in five places
 * (Manage Shifts, the employee, the employee's pay cycle, the Payroll tab and this tab), so the tab opens with the
 * whole chain, from the SAVED settings, and with each cycle's rule in one line.
 */
export function ProductionOverview({ settings }: { settings: PayrollSettingsItem }) {
  const forms = savedProduction(settings).cycles;
  const cycles = CYCLES.map((cycle) => {
    const rule = forms[cycle];
    const late = cycleLateRules(settings, cycle);
    return {
      cycle,
      ...CYCLE_INFO[cycle],
      rule: describeCycleRule(cycle, rule),
      blocked: "error" in cycleAnchor(cycle, rule),
      late: `${late.allowance} free, ${late.slabs.length} slab${late.slabs.length === 1 ? "" : "s"}${late.own ? "" : " (shared)"}`,
    };
  });

  return (
    <SettingsSection
      icon={Factory}
      title="How a production payslip is worked out"
      purpose={
        <>
          Production pay is set in five places. This tab holds each pay cycle's period and late deductions; the rest is
          linked here. Staff lateness is a different setting, on the{" "}
          <TextLink to="/hr/settings?tab=late_detection">Late Detection</TextLink> tab.
        </>
      }
      testId="production-pay-overview"
    >
      <ol className="mt-3 grid gap-2 md:grid-cols-2">
        <Step n={1} title="Shifts earned each day">
          Each day's punches are matched against the production punch times and shift segments: that decides how many
          shifts (0.25, 0.5, 1, 1.5 ...) the day earns. <TextLink to="/hr/shifts">Manage Shifts - Production</TextLink>
        </Step>
        <Step n={2} title="Pay = shifts earned x the worker's own rate">
          Each employee's Salary Per Shift (on the employee). New production employees start from the suggestion on the{" "}
          <TextLink to="/hr/settings?tab=payroll#default-salary-per-shift">Payroll tab</TextLink>.
        </Step>
        <Step n={3} title="PF and ESI">
          <ProductionPfOrder
            bandsOn={settings.prodPfEfEnabled ?? false}
            bandCount={(settings.prodPfEfRules ?? []).length}
            flatOn={settings.prodPayrollRulesEnabled ?? false}
            pfRate={settings.prodPfRate ?? 0}
            esiRate={settings.prodEsiRate ?? 0}
          />
        </Step>
        <Step n={4} title="The pay cycle and late deductions">
          Pay is worked out weekly, every two weeks or every four weeks depending on the employee's pay cycle (set on{" "}
          <TextLink to="/hr/employees/productionEmployee">Employees - Production Employees</TextLink>); each cycle's
          period and late deductions are on its sub-tab:{" "}
          <CycleLinks to={(cycle) => `/hr/settings?tab=production_payroll#${cycle}-week-start`} />. Late deductions are{" "}
          {settings.prodLateDetectionEnabled ? "ON" : "OFF"} for every cycle (
          <TextLink to="/hr/settings?tab=production_payroll#prod-late-switch">Late Detection</TextLink>). HR then
          generates each period on that cycle's Production Payroll page once it has ended:{" "}
          <CycleLinks to={(cycle) => CYCLE_INFO[cycle].path} />.
        </Step>
      </ol>
      <ul className="mt-2 grid gap-2 md:grid-cols-3" data-testid="production-cycle-summary">
        {cycles.map((c) => (
          <li
            key={c.cycle}
            className={cn(
              "rounded-xl px-3 py-2 text-[12px] leading-snug ring-1",
              c.blocked ? "bg-red-50/80 text-red-900 ring-red-100" : "bg-white/70 text-gray-700 ring-slate-100",
            )}
            data-testid={`production-cycle-summary-${c.cycle}`}
          >
            <p className="font-bold text-gray-900">
              {c.label} <span className="font-normal text-gray-400">({c.days} days)</span>
            </p>
            <p>{c.rule}</p>
            <p className="text-gray-500">Late: {c.late}</p>
            {c.blocked && <p className="font-semibold">Payroll cannot be generated until the date is set.</p>}
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
