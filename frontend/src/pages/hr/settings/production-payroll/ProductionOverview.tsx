import type { ReactNode } from "react";
import { ArrowRight, Factory } from "lucide-react";
import { useProductionCycles, type PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { SettingsSection } from "../kit/SettingBlock";
import { TextLink } from "../payroll/ui";
import { cycleLateRules } from "../late_detection/production";
import { formatPercent, formatRupees, MONTHS } from "../payroll/preview";
import {
  CYCLE_INFO,
  CYCLES,
  cycleAnchor,
  formatDayLong,
  formatPeriodLong,
  LENGTH_WORDS,
  parseIsoDay,
  resolveCyclePeriod,
  weekRunsArrow,
  type Day,
  type PayCycle,
} from "./cycles";
import { savedProduction } from "./sections";

/** One step of how a production payslip is worked out: a number, a title, a line, and where it is set. */
function Step({ n, title, children, last }: { n: number; title: string; children: ReactNode; last?: boolean }) {
  return (
    <li className="relative flex min-w-0 gap-2.5 rounded-xl border border-slate-200 bg-white p-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#eff6fb] text-xs font-bold text-[#006496]">
        {n}
      </span>
      <div className="min-w-0 space-y-1 text-[12px] leading-snug text-slate-600">
        <p className="text-[13px] font-semibold text-slate-900">{title}</p>
        {children}
      </div>
      {!last && (
        <ArrowRight
          size={14}
          className="absolute -right-3 top-1/2 hidden -translate-y-1/2 text-slate-300 xl:block"
          aria-hidden
        />
      )}
    </li>
  );
}

/** One "label: value" line of a cycle's card. */
function Line({ label, children, tone }: { label: string; children: ReactNode; tone?: "bad" }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-slate-100 py-1.5 first:border-t-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={cn("text-[13px] font-medium tabular-nums", tone === "bad" ? "text-red-800" : "text-slate-800")}>
        {children}
      </dd>
    </div>
  );
}

const isoPeriod = (start: string, end: string) => {
  const s = parseIsoDay(start);
  const e = parseIsoDay(end);
  return s && e ? formatPeriodLong({ start: s, end: e }) : `${start} – ${end}`;
};

/**
 * How a production payslip is put together, in four steps, each linked to where it is set; then each pay cycle as a card
 * from the SAVED settings (its week, length, first period, current period, the next period the server would generate,
 * the PF / ESI factor and its late rules) and the production bonus in a line.
 */
export function ProductionOverview({ settings, today }: { settings: PayrollSettingsItem; today: Day }) {
  const saved = savedProduction(settings);
  const summary = useProductionCycles();
  const perShift = Number(saved.payBonus.defaultSalaryPerShift) || 0;
  const fyStart = settings.bonusFyStartMonth ?? 4;

  return (
    <SettingsSection
      icon={Factory}
      title="How a production payslip is worked out"
      purpose="Four steps, each set in one place. This tab holds the pay cycles' periods, the rate for new production employees and the production bonus."
      testId="production-pay-overview"
    >
      <ol className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="production-pay-steps">
        <Step n={1} title="Shifts earned each day">
          <p>A day's punches become shifts (0.25, 0.5, 1, 1.5 ...) by the shift groups, ladders and breaks.</p>
          <TextLink to="/hr/settings?tab=production_shifts">Production Shifts</TextLink>
        </Step>
        <Step n={2} title="× the worker's Salary Per Shift">
          <p>
            Each worker's own rate.{" "}
            {perShift > 0
              ? `New production employees start from ${formatRupees(perShift)} a shift.`
              : "No rate is suggested for new employees."}
          </p>
          <TextLink to="/hr/settings?tab=production_payroll#default-salary-per-shift">Pay &amp; Bonus</TextLink>
        </Step>
        <Step n={3} title="Paid per pay cycle">
          <p>Weekly, BiWeekly or Monthly (four weeks), depending on the employee's pay cycle.</p>
          <TextLink to="/hr/employees/productionEmployee">Production Employees</TextLink>
        </Step>
        <Step n={4} title="Less PF, ESI and late days" last>
          <p>
            PF and ESI for Co Emp workers only. Late deductions are{" "}
            <strong className={settings.prodLateDetectionEnabled ? "text-emerald-700" : "text-slate-700"}>
              {settings.prodLateDetectionEnabled ? "ON" : "OFF"}
            </strong>
            .
          </p>
          <p className="flex flex-wrap gap-x-3">
            <TextLink to="/hr/settings?tab=pf_esi#prod-pf-rules">PF &amp; ESI</TextLink>
            <TextLink to="/hr/settings?tab=late_detection#prod-late-switch">Late Detection</TextLink>
          </p>
        </Step>
      </ol>

      <h4 className="mb-2 mt-5 text-sm font-semibold text-slate-900">The three pay cycles</h4>
      <ul className="grid gap-3 md:grid-cols-3" data-testid="production-cycle-summary">
        {CYCLES.map((cycle) => (
          <CycleSummaryCard
            key={cycle}
            cycle={cycle}
            settings={settings}
            today={today}
            server={summary.data?.cycles.find((c) => c.cycle === cycle)}
            serverFailed={summary.isError}
          />
        ))}
      </ul>

      <div
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-[13px] text-slate-700"
        data-testid="production-bonus-summary"
      >
        <span className="font-semibold text-slate-900">Statutory bonus</span>
        <span>{formatPercent(Number(saved.payBonus.prodBonusPercent))} of the bonus wage</span>
        <span>wage counted up to {formatRupees(Number(saved.payBonus.prodBonusWageCeiling))} a payslip</span>
        <span>workers up to {formatRupees(Number(saved.payBonus.prodBonusEligibilityCeiling))}</span>
        <span className="flex flex-wrap gap-x-3">
          <TextLink to="/hr/settings?tab=production_payroll#prod-bonus-percent">Pay &amp; Bonus</TextLink>
          <TextLink to="/hr/settings?tab=payroll#fy-start-month">
            Year from {MONTHS[fyStart - 1] ?? fyStart} (Staff Payroll)
          </TextLink>
        </span>
      </div>
    </SettingsSection>
  );
}

/** One cycle's card on the Overview, from the saved settings and the server's next period. */
function CycleSummaryCard({
  cycle,
  settings,
  today,
  server,
  serverFailed,
}: {
  cycle: PayCycle;
  settings: PayrollSettingsItem;
  today: Day;
  server:
    | {
        next: { periodStart: string; periodEnd: string; periodEnded: boolean } | null;
        configError: string | null;
        assigned: number;
      }
    | undefined;
  serverFailed: boolean;
}) {
  const info = CYCLE_INFO[cycle];
  const rule = savedProduction(settings).cycles[cycle];
  const anchored = cycleAnchor(cycle, rule);
  const blocked = "error" in anchored;
  const current = resolveCyclePeriod(today, cycle, rule);
  const late = cycleLateRules(settings, cycle);
  const typed = parseIsoDay(rule.anchorDate);

  return (
    <li
      className={cn(
        "flex min-w-0 flex-col rounded-xl border p-3.5",
        blocked ? "border-red-200 bg-red-50/60" : "border-slate-200 bg-white",
      )}
      data-testid={`production-cycle-summary-${cycle}`}
    >
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2">
        <p className="text-[15px] font-semibold text-slate-900">{info.label}</p>
        <p className="text-xs text-slate-500">
          {LENGTH_WORDS[cycle].days}, paid {info.every}
          {server ? ` · ${server.assigned} ${server.assigned === 1 ? "worker" : "workers"}` : ""}
        </p>
      </div>
      <dl>
        <Line label="Week runs">{weekRunsArrow(rule.weekStart)}</Line>
        <Line label="First period" tone={blocked ? "bad" : undefined}>
          {"anchor" in anchored && typed ? formatDayLong(anchored.anchor) : blocked ? "Not set" : "Not needed"}
        </Line>
        <Line label="Current period">{"period" in current ? formatPeriodLong(current.period) : "Not known"}</Line>
        <Line label="Next to generate" tone={server?.configError ? "bad" : undefined}>
          {server?.next
            ? `${isoPeriod(server.next.periodStart, server.next.periodEnd)}${
                // a newer server says when the period is generated and still open (it stays next until Payroll Done)
                (server.next as { state?: string }).state === "generated"
                  ? " (generated, still open)"
                  : server.next.periodEnded
                    ? " (ended)"
                    : ""
              }`
            : server?.configError
              ? "Not known"
              : serverFailed
                ? "Could not be read"
                : "..."}
        </Line>
        <Line label="PF / ESI estimate">× {info.monthlyFactor} a period's pay</Line>
        <Line label="Late days">
          {late.allowance} free, {late.slabs.length} slab{late.slabs.length === 1 ? "" : "s"}
          {late.own ? "" : " (shared)"}{" "}
          <TextLink to={`/hr/settings?tab=late_detection#${cycle}-late-allowance`}>Change</TextLink>
        </Line>
      </dl>
      {blocked && (
        <p className="mt-1.5 text-[12px] font-semibold text-red-800">
          Payroll cannot be generated until the date is set.
        </p>
      )}
      <p className="mt-auto flex flex-wrap gap-x-4 pt-2 text-[12px]">
        <TextLink to={`/hr/settings?tab=production_payroll#${cycle}-week-start`}>{info.label} settings</TextLink>
        <TextLink to={info.path}>{info.label} payroll</TextLink>
      </p>
    </li>
  );
}
