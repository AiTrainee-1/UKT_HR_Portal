import { useState } from "react";
import { IndianRupee, Inbox } from "lucide-react";
import MdLayout from "@/components/md/MdLayout";
import { FilterBar, ScopeBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { Button } from "@/components/ui/button";
import { describeMdError, useMdOrg } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { inrCompact, monthText, num, pct } from "@/lib/md/format";
import { EVERYONE, describeScope, scopeParams, type ScopeChoice } from "@/lib/md/period";
import AdvancesCard from "./payroll/AdvancesCard";
import AttentionCard from "./payroll/AttentionCard";
import BridgeCard from "./payroll/BridgeCard";
import ComponentsCard from "./payroll/ComponentsCard";
import DepartmentsCard from "./payroll/DepartmentsCard";
import DistributionCard from "./payroll/DistributionCard";
import ExceptionsCard from "./payroll/ExceptionsCard";
import KpiStrip from "./payroll/KpiStrip";
import MonthPicker from "./payroll/MonthPicker";
import StatusBanner from "./payroll/StatusBanner";
import StatusStrip from "./payroll/StatusStrip";
import TrendCard from "./payroll/TrendCard";
import { EXCEPTION_PAGE, nextLimit, previousMonth } from "./payroll/logic";
import { emptyReason } from "./payroll/parts";
import { usePayrollQueries } from "./payroll/queries";

/**
 * Payroll Analysis: what the workforce costs and what changed since last month, and why. Exceptions first (status,
 * cost jump, overtime, outliers), then the trend, the cost bridge, who the money goes to, what it is made of, advances
 * and the rows to check. The figures describe ONE payroll month (the latest closed one unless the MD picks another);
 * the status banner under the filters says where that month stands, so a number is never read without it.
 */
export default function MdPayroll() {
  const [month, setMonth] = useState("");
  const [scope, setScope] = useState<ScopeChoice>(EVERYONE);
  const [kind, setKind] = useState("");
  const [limit, setLimit] = useState(EXCEPTION_PAGE);
  const org = useMdOrg();

  const q = usePayrollQueries({ month, scope: scopeParams(scope) }, { limit, kind });
  const summary = q.summary.data;
  const status = q.status.data;

  // a changed filter starts the exceptions list again from its first ten
  const pickMonth = (next: string) => {
    setMonth(next);
    setKind("");
    setLimit(EXCEPTION_PAGE);
  };
  const pickScope = (next: ScopeChoice) => {
    setScope(next);
    setKind("");
    setLimit(EXCEPTION_PAGE);
  };

  const label = summary?.monthLabel ?? "the latest closed month";
  const previousLabel = summary?.month ? monthText(previousMonth(summary.month)) : "last month";
  const totals = summary?.totals ?? null;
  const nothingProcessed = !!status && !status.hasData;
  const monthEmpty = !!summary && !summary.hasData && !nothingProcessed;

  const branchName = org.data?.branches.find((b) => String(b.id) === scope.branch)?.name;
  usePublishAssistantContext({
    page: "payroll",
    title: "Payroll Analysis",
    filters: {
      Month: summary?.monthLabel ?? "Latest closed month",
      "Payroll status": summary?.status?.stateLabel,
      Scope: describeScope(scope, branchName, scope.department || undefined),
    },
    summary: totals
      ? {
          "Gross pay": inrCompact(totals.grossPay),
          "Net pay": inrCompact(totals.netPay),
          "People paid": num(totals.headcount),
          "Cost per head": inrCompact(totals.costPerHead),
          Overtime: `${inrCompact(totals.overtimePay)} (${pct(totals.overtimeSharePct)} of gross pay)`,
          "Change in gross pay on the previous month": summary?.change?.grossPay
            ? `${inrCompact(summary.change.grossPay.abs)} (${pct(summary.change.grossPay.pct)})`
            : null,
        }
      : undefined,
  });

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-5" data-testid="md-payroll">
        <MdPageHeader
          icon={IndianRupee}
          title="Payroll Analysis"
          subtitle="What the workforce costs, what changed since last month, and why."
          updatedAt={summary?.generatedAt}
        />
        <FilterBar>
          <MonthPicker value={month} onChange={pickMonth} status={status} />
          <ScopeBar value={scope} onChange={pickScope} org={org.data} />
        </FilterBar>

        {q.summary.isError && !summary && (
          <ErrorBanner message={describeMdError(q.summary.error)} onRetry={() => void q.summary.refetch()} />
        )}

        {nothingProcessed && (
          <SectionCard title="Payroll" testId="md-payroll-empty">
            <EmptyBlock icon={Inbox} title="No payroll has been processed yet">
              There are no salary slips for this selection. The cost, trend and bridge appear here once HR generates a
              month's payroll.
            </EmptyBlock>
          </SectionCard>
        )}

        {monthEmpty && (
          <>
            <StatusBanner status={summary.status} provenance={summary.provenance} />
            <SectionCard title={`No payroll for ${label}`} testId="md-payroll-month-empty">
              <EmptyBlock icon={Inbox} title={`Nothing was paid in ${label}`}>
                {emptyReason(summary.notes, "No salary slips exist for this month in this selection.")}
              </EmptyBlock>
              <div className="flex justify-center pb-4">
                <Button variant="outline" size="sm" onClick={() => pickMonth("")} data-testid="md-payroll-go-latest">
                  Show the latest closed month
                </Button>
              </div>
            </SectionCard>
          </>
        )}

        {!nothingProcessed && !monthEmpty && (
          <>
            <StatusBanner status={summary?.status} provenance={summary?.provenance} />
            {(summary?.notes ?? [])
              .filter((n) => !n.includes("staff slip(s)"))
              .map((n) => (
                <NoteBanner key={n}>{n}</NoteBanner>
              ))}
            <KpiStrip summary={summary} trend={q.trend.data} loading={q.summary.isPending} />
            <AttentionCard query={q.attention} label={label} />
            <TrendCard query={q.trend} />
            <BridgeCard query={q.bridge} label={label} previousLabel={previousLabel} />
            <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
              <div className="min-w-0 @4xl:col-span-7">
                <DepartmentsCard query={q.departments} label={label} />
              </div>
              <div className="min-w-0 @4xl:col-span-5">
                <ComponentsCard query={q.components} label={label} />
              </div>
            </div>
            <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-12">
              <div className="min-w-0 @4xl:col-span-7">
                <DistributionCard query={q.distribution} label={label} />
              </div>
              <div className="min-w-0 @4xl:col-span-5">
                <AdvancesCard query={q.advances} label={label} />
              </div>
            </div>
            <ExceptionsCard
              query={q.exceptions}
              label={label}
              kind={kind}
              onKind={(next) => {
                setKind(next);
                setLimit(EXCEPTION_PAGE);
              }}
              onMore={() => setLimit((n) => nextLimit(n, q.exceptions.data?.matching ?? n))}
            />
          </>
        )}

        {!nothingProcessed && <StatusStrip query={q.status} selected={summary?.month} onSelect={pickMonth} />}
      </div>
    </MdLayout>
  );
}
