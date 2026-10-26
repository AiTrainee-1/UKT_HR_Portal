import { Factory } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ShiftTemplate } from "@/lib/api-client/custom-hooks";
import { ManagedElsewhere, PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";
import { PRODUCTION_SECTIONS, productionText } from "../ProductionPayrollTab.meta";
import { formatPaise } from "../payroll/preview";
import { InfoBox, TextLink } from "../payroll/ui";
import { CYCLE_INFO, CYCLES } from "./cycles";
import { cyclePay } from "./preview";
import { PER_SHIFT } from "./SlabEditor";
import { pagePath } from "@/pages/hr/compensation/routes";

const block = (id: string) => ({ id, ...productionText(id) });

const clock = (value: string | null | undefined): string => (value ? value.slice(0, 5) : "-");

/** The example worker earns six shifts a week, so a period on each cycle holds 6, 12 or 24 shifts. */
const SHIFTS_A_WEEK = 6;

/**
 * Settings -> Production Payroll -> "Overview" (with the chain above it): nothing is set here. It says where production pay
 * really comes from (shifts earned from the Production Shifts tab, PF / ESI on the PF & ESI tab, scaled to a month by the
 * pay cycle) and lists the production shifts that late detection measures against, with links to each place.
 */
export function ShiftPanel({
  shifts,
  shiftsLoading,
  shiftsError,
}: {
  shifts: ShiftTemplate[] | undefined;
  shiftsLoading: boolean;
  shiftsError: boolean;
}) {
  const production = (shifts ?? []).filter((s) => s.shiftType === "production");
  const pay = (count: number, cycle: (typeof CYCLES)[number]) =>
    cyclePay({ shifts: count, ratePerShift: PER_SHIFT }, cycle);
  const samples = CYCLES.map((cycle) => {
    const count = SHIFTS_A_WEEK * CYCLE_INFO[cycle].weeks;
    return { cycle, ...CYCLE_INFO[cycle], count, pay: pay(count, cycle) };
  });
  const cyclePages = CYCLES.map((cycle) => ({
    label: `Production Payroll - ${CYCLE_INFO[cycle].label}`,
    to: CYCLE_INFO[cycle].path,
  }));

  return (
    <SettingsSection
      icon={Factory}
      title={PRODUCTION_SECTIONS.shift}
      purpose="Nothing is set in this part of the Overview. It shows where a production payslip's pay and deductions come from, whatever the pay cycle, so a wrong number can be traced to the place that owns it."
      usedBy={[
        { label: "Production Attendance", to: "/hr/attendance/production" },
        ...cyclePages,
        { label: "Manage Shifts", to: "/hr/shifts" },
      ]}
      testId="production-shift-panel"
    >
      <SettingBlock
        {...block("prod-shifts-earned")}
        affects={[
          {
            where: "Production Attendance",
            what: "shifts earned per day, and the Late / Early Out flags shown there.",
            to: "/hr/attendance/production",
          },
          {
            where: "Production Payroll - every cycle",
            what: "pay for the period = the shifts earned on its days x the worker's Salary Per Shift, whether the period is a week, two weeks or four weeks.",
            to: CYCLE_INFO.weekly.path,
          },
        ]}
        note="Strict / Simple mode, the staff late rules and the production late rules on Late Detection never change the shifts a day earns."
        preview={
          <PreviewCard scenario={`A worker whose Salary Per Shift is ${formatPaise(PER_SHIFT * 100)}.`}>
            <PreviewLine label="A day earning 1 shift" result={formatPaise(PER_SHIFT * 100)} />
            <PreviewLine
              label="A day earning 1.5 shifts (the extra segment too)"
              result={formatPaise(PER_SHIFT * 150)}
            />
            <PreviewLine
              label="A Weekly period of 6.5 shifts"
              result={`pay ${formatPaise(pay(6.5, "weekly").gross)}`}
              tone="info"
            />
          </PreviewCard>
        }
      >
        <ManagedElsewhere
          title="The shift rules: Settings - Production Shifts"
          to="/hr/settings?tab=production_shifts"
          linkLabel="Open Production Shifts"
          testId="production-shifts-elsewhere"
        >
          The default timings, the ladders of shifts earned, the unpaid breaks and the grace are edited on the
          Production Shifts tab, with a box to try a day. A day from its start date is worked out there.
        </ManagedElsewhere>
        <ManagedElsewhere
          title="The old calculation, before the rules start"
          to="/hr/settings?tab=attendance#production-attendance"
          linkLabel="Open Attendance settings"
          testId="production-attendance-elsewhere"
        >
          Days before the Production Shifts rules start keep the old punch times and segments. The Attendance tab shows
          them read-only, with two example days priced at {formatPaise(PER_SHIFT * 100)} a shift.
        </ManagedElsewhere>
      </SettingBlock>

      <SettingBlock
        {...block("prod-pf-esi-where")}
        affects={[
          {
            where: "Production Payroll - every cycle",
            what: "PF and ESI on every production payslip generated from now on follow the rules on the PF & ESI tab, for employees switched ON in Co Emp only; the payslip breakdown names the rule that matched and the monthly estimate it was tested on.",
            to: CYCLE_INFO.weekly.path,
          },
          {
            where: "Compensation - CTC Breakdown",
            what: "Employer PF and ESI for production employees follow the same rules.",
            to: pagePath("ctc"),
          },
        ]}
        note="A rule's 'Full monthly salary' basis is tested on an estimated monthly pay: the period's gross x 4 on Weekly, x 2 on BiWeekly and x 1 on Monthly (a production month is four weeks). The amount deducted is the rule's percentage of the period's first-portion pay (Basic + DA + Retaining Allowance)."
        preview={
          <PreviewCard
            scenario={`The same worker, ${formatPaise(PER_SHIFT * 100)} a shift and ${SHIFTS_A_WEEK} shifts a week, paid on each cycle: what the rules see.`}
            testId="production-pf-esi-preview"
          >
            {samples.map((s) => (
              <PreviewLine
                key={s.cycle}
                label={`${s.label}: ${s.count} shifts = ${formatPaise(s.pay.gross)}, estimate ${formatPaise(s.pay.monthlyEstimate)} (x${s.monthlyFactor})`}
                result={`rules tested on ${formatPaise(s.pay.monthlyEstimate)} a month`}
                tone="info"
              />
            ))}
          </PreviewCard>
        }
      >
        <InfoBox testId="production-pf-esi-how">
          <p className="font-semibold">How production PF and ESI are decided</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Only workers switched ON in Employees - Co Emp are subject to PF and ESI; everybody else pays none, ever.
            </li>
            <li>Each rule has a salary range, the amount the range is measured on, and a percentage.</li>
            <li>The first rule whose range holds the worker's amount applies; no matching rule means no deduction.</li>
          </ol>
        </InfoBox>
        <ManagedElsewhere
          title="Set on the PF & ESI tab"
          to="/hr/settings?tab=pf_esi#prod-pf-rules"
          linkLabel="Open PF & ESI"
          testId="production-pf-esi-elsewhere"
        >
          The production PF rules and ESI rules, their salary ranges and percentages, and the units that have rules of
          their own are on the PF & ESI tab, Production page. Only the Super Admin can change them.
        </ManagedElsewhere>
      </SettingBlock>

      <SettingBlock
        {...block("prod-assigned-shifts")}
        affects={[
          {
            where: "Production Payroll - every cycle",
            what: "while late deductions are on, each day's first (and in Strict mode last) punch is compared with the start, end and grace of the day's group on the Production Shifts tab (for days before its rules start: of the assigned shift), to the second.",
            to: CYCLE_INFO.weekly.path,
          },
        ]}
        note="Read-only here: edit them in Manage Shifts. Shifts earned and pay do not use these times; they come from the Production Shifts tab."
      >
        <div className="space-y-3">
          {shiftsLoading ? (
            <p className="text-xs text-gray-500">Loading the production shifts…</p>
          ) : shiftsError ? (
            <p className="text-xs text-gray-500">The shifts could not be loaded here: open Manage Shifts.</p>
          ) : production.length === 0 ? (
            <p
              className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-gray-500"
              data-testid="production-shifts-empty"
            >
              No production shift yet: add one in Manage Shifts. Until a worker has an assigned shift, no day of theirs
              can be late.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-100 bg-white">
              <table className="w-full text-sm" data-testid="production-shift-table">
                <thead>
                  <tr className="bg-slate-50 text-left text-xs text-slate-600">
                    <th className="px-3 py-2 font-semibold">Name</th>
                    <th className="px-3 py-2 font-semibold">Start</th>
                    <th className="px-3 py-2 font-semibold">End</th>
                    <th className="px-3 py-2 font-semibold">Grace</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {production.map((s) => (
                    <tr key={s.id}>
                      <td className="px-3 py-2 font-medium text-gray-800">
                        {s.name}
                        {s.isDefault && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            Default
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{clock(s.startTime)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{clock(s.endTime)}</td>
                      <td className="px-3 py-2 text-xs">{s.gracePeriodMinutes} min</td>
                      <td className="px-3 py-2">
                        <Badge
                          className={`text-xs ${s.isActive ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-500 border-gray-200"}`}
                        >
                          {s.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ManagedElsewhere
            title="Shifts are assigned and edited in Manage Shifts"
            to="/hr/shifts"
            linkLabel="Open Manage Shifts"
            testId="production-assigned-elsewhere"
          >
            Late detection uses whichever shift a worker is assigned on the day, whatever its type. What counts as late
            (Strict or Simple) is saved with the switch on{" "}
            <TextLink to="/hr/settings?tab=late_detection#prod-attendance-mode">Late Detection - Production</TextLink>,
            the only thing it affects.
          </ManagedElsewhere>
        </div>
      </SettingBlock>
    </SettingsSection>
  );
}
