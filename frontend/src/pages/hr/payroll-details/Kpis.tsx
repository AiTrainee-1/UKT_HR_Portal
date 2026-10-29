import { AlertTriangle, CalendarCheck, Factory, MinusCircle, ShieldCheck, TrendingUp, Wallet } from "lucide-react";
import { KpiTile } from "@/components/payroll/kit/parts";
import { inr, inr2 } from "@/components/payroll/kit/format";
import type { PayrollDetails, PayrollKind } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { netBridge, severityCounts, workTile } from "./logic";

/**
 * The dashboard of one payroll: the money (gross, deductions, net payable), the days or shifts it paid for, how many
 * issues were detected (split by severity). The Issues tile jumps to its section.
 */
export function KpiStrip({
  details,
  kind,
  accent,
  degraded,
  onJump,
}: {
  details: PayrollDetails;
  kind: PayrollKind;
  accent: Accent;
  /** No breakdown behind this payroll: there is nothing to say about its issues or rules, which is not "clean". */
  degraded: boolean;
  onJump: (sectionId: string) => void;
}) {
  const { money } = details;
  const counts = severityCounts(details.issues);
  const total = details.issues.length;
  const work = workTile(details, kind);
  const deductionShare = money.gross > 0 ? Math.round((money.deductions / money.gross) * 1000) / 10 : 0;

  const issuesTone = degraded
    ? "bg-slate-50 text-slate-600"
    : counts.critical > 0
      ? "bg-red-50 text-red-800"
      : counts.warning > 0
        ? "bg-amber-50 text-amber-800"
        : "bg-green-50 text-green-800";
  const issuesSub = degraded
    ? "No breakdown to check"
    : total === 0
      ? "Nothing to flag: this payroll is clean"
      : [
          counts.critical ? `${counts.critical} critical` : "",
          counts.warning ? `${counts.warning} ${counts.warning === 1 ? "warning" : "warnings"}` : "",
          counts.info ? `${counts.info} info` : "",
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="pd-kpis">
      <KpiTile
        label="Gross"
        value={inr(money.gross)}
        sub={
          kind === "staff" && money.monthlySalary
            ? `of a ${inr(money.monthlySalary)} monthly salary`
            : kind === "production" && details.employee.salaryPerShift
              ? `at ${inr(details.employee.salaryPerShift)} a shift`
              : undefined
        }
        icon={TrendingUp}
        tone="bg-blue-50 text-blue-800"
        testId="pd-kpi-gross"
      />
      <KpiTile
        label="Deductions"
        value={inr(money.deductions)}
        sub={money.gross > 0 ? `${deductionShare}% of gross` : undefined}
        icon={MinusCircle}
        tone="bg-red-50 text-red-800"
        testId="pd-kpi-deductions"
      />
      <KpiTile
        label="Net payable"
        value={inr(money.net)}
        sub={details.status === "paid" ? "Paid" : "To be paid"}
        icon={Wallet}
        tone={cn(accent.kpi, accent.tileRing)}
        className="order-first col-span-2 sm:order-none sm:col-span-1 [&_[data-testid=pd-kpi-net-value]]:text-3xl sm:[&_[data-testid=pd-kpi-net-value]]:text-2xl"
        testId="pd-kpi-net"
      />
      <KpiTile
        label={work.label}
        value={
          work.outOf ? (
            <>
              {work.value} <span className="text-sm font-bold opacity-60">/ {work.outOf}</span>
            </>
          ) : (
            work.value
          )
        }
        sub={work.sub || undefined}
        icon={kind === "production" ? Factory : CalendarCheck}
        tone="bg-sky-50 text-sky-800"
        testId="pd-kpi-days"
      />
      <KpiTile
        label="Issues"
        value={degraded ? "—" : total}
        sub={issuesSub}
        icon={total === 0 && !degraded ? ShieldCheck : AlertTriangle}
        tone={issuesTone}
        onClick={() => onJump("issues")}
        className="col-span-2 xl:col-span-1"
        testId="pd-kpi-issues"
      />
    </div>
  );
}

/** Gross -> Deductions -> Net as one bar: how much of the gross went on deductions, and what is left to pay. */
export function NetBridge({ details }: { details: PayrollDetails }) {
  const { money } = details;
  const bridge = netBridge(money);
  const summary = `Gross ${inr2(money.gross)}, deductions ${inr2(money.deductions)}, net payable ${inr2(money.net)}`;
  return (
    <div className="clay-card rounded-2xl border border-slate-100 px-5 py-4" data-testid="pd-net-bridge">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-bold text-gray-900">From gross to net</h3>
        <p className="text-xs text-muted-foreground">
          Gross <strong className="tabular-nums text-slate-700">{inr2(money.gross)}</strong>
          {" - deductions "}
          <strong className="tabular-nums text-red-700">{inr2(money.deductions)}</strong>
          {bridge.bonus ? (
            <>
              {" + bonus "}
              <strong className="tabular-nums text-emerald-700">{inr2(bridge.bonus)}</strong>
            </>
          ) : null}
          {bridge.other ? (
            <>
              {bridge.other > 0 ? " + " : " - "}
              {bridge.otherIsOvertime ? "overtime " : "other adjustments "}
              <strong className="tabular-nums text-slate-700">{inr2(Math.abs(bridge.other))}</strong>
            </>
          ) : null}
          {" = net "}
          <strong className="tabular-nums text-emerald-700">{inr2(money.net)}</strong>
        </p>
      </div>
      <div
        className="mt-3 flex h-4 w-full overflow-hidden rounded-full bg-slate-100"
        role="img"
        aria-label={summary}
        data-testid="pd-net-bridge-bar"
      >
        <div
          className="h-full bg-emerald-500 transition-[width]"
          style={{ width: `${bridge.netPct}%` }}
          data-testid="pd-bridge-net"
        />
        <div
          className="h-full bg-red-400 transition-[width]"
          style={{ width: `${bridge.deductionsPct}%` }}
          data-testid="pd-bridge-deductions"
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-500" /> Net payable {Math.round(bridge.netPct * 10) / 10}%
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-red-400" /> Deductions {Math.round(bridge.deductionsPct * 10) / 10}%
        </span>
      </div>
    </div>
  );
}
