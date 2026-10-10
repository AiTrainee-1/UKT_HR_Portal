import { Calculator, Hourglass, IndianRupee, Landmark, Receipt, Timer, Users, Wallet } from "lucide-react";
import { inrCompact, num, pct } from "@/lib/md/format";
import KpiCard from "./KpiCard";
import { deltaView } from "./logic";
import type { PayrollSummary, PayrollTrend, TrendRow } from "./types";

/**
 * The headline figures of the month, each against last month and (where it makes sense) with its twelve-month line.
 * Cost going DOWN is the good direction; headcount is neither good nor bad. With no payroll for the month every
 * card shows a dash, never a zero. A grid of four by two (two across on a phone); gross pay is the statement piece, the
 * one dark card, and "Awaiting payment" shows how much of the month is paid as a meter.
 */
export default function KpiStrip({
  summary,
  trend,
  loading,
}: {
  summary: PayrollSummary | undefined;
  trend: PayrollTrend | undefined;
  loading: boolean;
}) {
  const t = summary?.totals ?? null;
  const change = summary?.change ?? null;
  const provenance = summary?.provenance;
  const spark = (key: keyof TrendRow) => trend?.months.map((r) => r[key] as number | null);
  const dash = "—";
  const money = (v: number | null | undefined) => (t && v != null ? inrCompact(v) : dash);
  const staff = summary?.byType.staff?.headcount ?? 0;
  const production = summary?.byType.production?.headcount ?? 0;
  const payable = summary?.payable ?? null;
  const pending = !!payable && payable.slips > 0;
  const totalSlips = t?.slips ?? payable?.slips ?? 0;
  const paidShare = payable && totalSlips > 0 ? Math.max(0, Math.min(1, 1 - payable.slips / totalSlips)) : null;

  return (
    <div className="grid grid-cols-2 gap-4 @3xl:grid-cols-4" data-testid="md-payroll-kpis">
      <KpiCard
        order={0}
        dark
        testId="md-payroll-kpi-gross"
        label="Gross pay"
        value={money(t?.grossPay)}
        sub={t ? `includes ${inrCompact(t.overtimePay)} overtime` : undefined}
        icon={IndianRupee}
        delta={deltaView(change?.grossPay, "money", "down")}
        spark={spark("grossPay")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["gross-pay", "payroll-source"]}
      />
      <KpiCard
        order={1}
        testId="md-payroll-kpi-net"
        label="Net pay"
        value={money(t?.netPay)}
        sub={t ? "take-home after deductions" : undefined}
        icon={Wallet}
        tone="wine"
        delta={deltaView(change?.netPay, "money", "down")}
        spark={spark("netPay")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["net-pay"]}
      />
      <KpiCard
        order={2}
        testId="md-payroll-kpi-deductions"
        label="Deductions"
        value={money(t?.totalDeductions)}
        sub={t ? `${pct(t.grossPay ? (t.totalDeductions / t.grossPay) * 100 : null)} of gross pay` : undefined}
        icon={Receipt}
        tone="ink"
        delta={deltaView(change?.totalDeductions, "money", "neutral")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["deductions"]}
      />
      <KpiCard
        order={3}
        testId="md-payroll-kpi-employer"
        label="Employer cost (estimate)"
        value={money(t?.employerCost)}
        sub={t ? `gross pay plus ${inrCompact(t.employerStatutory)} employer PF / ESI` : undefined}
        icon={Landmark}
        tone="info"
        delta={deltaView(change?.employerCost, "money", "down")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["employer-cost"]}
      />
      <KpiCard
        order={4}
        testId="md-payroll-kpi-people"
        label="People paid"
        value={t ? num(t.headcount) : dash}
        sub={t ? `${num(staff)} staff · ${num(production)} production` : undefined}
        icon={Users}
        tone="mauve"
        delta={deltaView(change?.headcount, "count", "neutral")}
        spark={spark("headcount")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["headcount"]}
      />
      <KpiCard
        order={5}
        testId="md-payroll-kpi-per-head"
        label="Cost per head"
        value={money(t?.costPerHead)}
        sub={
          t && t.employerCostPerHead != null ? `${inrCompact(t.employerCostPerHead)} with employer PF / ESI` : undefined
        }
        icon={Calculator}
        tone="clay"
        delta={deltaView(change?.costPerHead, "money", "down")}
        spark={spark("costPerHead")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["cost-per-head"]}
      />
      <KpiCard
        order={6}
        testId="md-payroll-kpi-overtime"
        label="Overtime"
        value={money(t?.overtimePay)}
        sub={t ? `${pct(t.overtimeSharePct)} of gross pay` : undefined}
        icon={Timer}
        tone="rose"
        delta={deltaView(change?.overtimePay, "money", "down")}
        spark={spark("overtimePay")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["overtime"]}
      />
      <KpiCard
        order={7}
        testId="md-payroll-kpi-payable"
        label="Awaiting payment"
        value={payable ? inrCompact(payable.netPay) : dash}
        sub={payable ? `${payable.slips} of ${t?.slips ?? payable.slips} slips not marked paid` : undefined}
        icon={Hourglass}
        tone={pending ? "warning" : "success"}
        loading={loading}
        provenance={provenance}
        provenanceIds={["payroll-status"]}
      >
        {paidShare != null && (
          <div className="mt-auto" data-testid="md-payroll-kpi-paid-share">
            <div
              className="md-money-meter"
              role="meter"
              aria-label="Share of slips marked paid"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(paidShare * 100)}
            >
              <span style={{ width: `${Math.round(paidShare * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-[11.5px] font-semibold tabular-nums text-md-ink-soft">
              {Math.round(paidShare * 100)}% of slips are marked paid
            </p>
          </div>
        )}
      </KpiCard>
    </div>
  );
}
