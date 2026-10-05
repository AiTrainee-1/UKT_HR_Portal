import { Calculator, Hourglass, IndianRupee, Landmark, Receipt, Timer, Users, Wallet } from "lucide-react";
import StatCard from "@/components/md/kit/StatCard";
import { inrCompact, num, pct } from "@/lib/md/format";
import { deltaView } from "./logic";
import type { PayrollSummary, PayrollTrend, TrendRow } from "./types";

/**
 * The headline figures of the month, each against last month and (where it makes sense) with its twelve-month line.
 * Cost going DOWN is the good direction; headcount is neither good nor bad. With no payroll for the month every
 * card shows a dash, never a zero.
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

  return (
    <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4" data-testid="md-payroll-kpis">
      <StatCard
        testId="md-payroll-kpi-gross"
        label="Gross pay"
        value={money(t?.grossPay)}
        sub={t ? `includes ${inrCompact(t.overtimePay)} overtime` : undefined}
        icon={IndianRupee}
        tone="blue"
        delta={deltaView(change?.grossPay, "money", "down")}
        spark={spark("grossPay")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["gross-pay", "payroll-source"]}
      />
      <StatCard
        testId="md-payroll-kpi-net"
        label="Net pay"
        value={money(t?.netPay)}
        sub={t ? "take-home after deductions" : undefined}
        icon={Wallet}
        tone="teal"
        delta={deltaView(change?.netPay, "money", "down")}
        spark={spark("netPay")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["net-pay"]}
      />
      <StatCard
        testId="md-payroll-kpi-deductions"
        label="Deductions"
        value={money(t?.totalDeductions)}
        sub={t ? `${pct(t.grossPay ? (t.totalDeductions / t.grossPay) * 100 : null)} of gross pay` : undefined}
        icon={Receipt}
        tone="slate"
        delta={deltaView(change?.totalDeductions, "money", "neutral")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["deductions"]}
      />
      <StatCard
        testId="md-payroll-kpi-employer"
        label="Employer cost (estimate)"
        value={money(t?.employerCost)}
        sub={t ? `gross pay plus ${inrCompact(t.employerStatutory)} employer PF / ESI` : undefined}
        icon={Landmark}
        tone="indigo"
        delta={deltaView(change?.employerCost, "money", "down")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["employer-cost"]}
      />
      <StatCard
        testId="md-payroll-kpi-people"
        label="People paid"
        value={t ? num(t.headcount) : dash}
        sub={t ? `${num(staff)} staff · ${num(production)} production` : undefined}
        icon={Users}
        tone="green"
        delta={deltaView(change?.headcount, "count", "neutral")}
        spark={spark("headcount")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["headcount"]}
      />
      <StatCard
        testId="md-payroll-kpi-per-head"
        label="Cost per head"
        value={money(t?.costPerHead)}
        sub={
          t && t.employerCostPerHead != null ? `${inrCompact(t.employerCostPerHead)} with employer PF / ESI` : undefined
        }
        icon={Calculator}
        tone="amber"
        delta={deltaView(change?.costPerHead, "money", "down")}
        spark={spark("costPerHead")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["cost-per-head"]}
      />
      <StatCard
        testId="md-payroll-kpi-overtime"
        label="Overtime"
        value={money(t?.overtimePay)}
        sub={t ? `${pct(t.overtimeSharePct)} of gross pay` : undefined}
        icon={Timer}
        tone="purple"
        delta={deltaView(change?.overtimePay, "money", "down")}
        spark={spark("overtimePay")}
        loading={loading}
        provenance={provenance}
        provenanceIds={["overtime"]}
      />
      <StatCard
        testId="md-payroll-kpi-payable"
        label="Awaiting payment"
        value={payable ? inrCompact(payable.netPay) : dash}
        sub={payable ? `${payable.slips} of ${t?.slips ?? payable.slips} slips not marked paid` : undefined}
        icon={Hourglass}
        tone={payable && payable.slips > 0 ? "red" : "green"}
        loading={loading}
        provenance={provenance}
        provenanceIds={["payroll-status"]}
      />
    </div>
  );
}
