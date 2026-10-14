import { Link } from "wouter";
import { ChevronRight, History } from "lucide-react";
import { Chip, EmptyNote, PayStatusChip, SectionCard } from "@/components/payroll/kit/parts";
import { inr, inr2, plural } from "@/components/payroll/kit/format";
import { payrollDetailsPath } from "@/components/payroll/kit/url-state";
import type { PayrollDetails, PayrollKind } from "@/lib/api-client/custom-hooks";
import type { Accent } from "./accent";
import { Sparkline } from "./parts";
import { sectionDomId } from "./logic";

/** This employee's earlier payrolls of the same kind, newest first, each a link to its own details page. */
export function HistoryCard({ details, kind, accent }: { details: PayrollDetails; kind: PayrollKind; accent: Accent }) {
  const { history, money } = details;
  // oldest -> newest, ending with this payroll (the dot on the sparkline)
  const trend = [...history].reverse().map((h) => h.net);
  trend.push(money.net);

  return (
    <SectionCard
      id={sectionDomId("history")}
      testId="pd-section-history"
      className="scroll-mt-16"
      icon={History}
      title="Earlier payrolls"
      description="This employee's previous payrolls of the same kind. Open one to see how it was worked out."
      actions={
        history.length > 0 && (
          <div
            className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-1.5"
            title="Net payable, oldest to this payroll"
          >
            <span className="text-[11px] font-semibold text-muted-foreground">Net trend</span>
            <Sparkline
              values={trend}
              label={`Net payable over the last ${trend.length} payrolls: ${trend.map((n) => inr(n)).join(", ")}`}
              dot={kind === "production" ? "#d97706" : "#4f46e5"}
              testId="pd-history-spark"
            />
          </div>
        )
      }
    >
      {history.length === 0 ? (
        <EmptyNote
          icon={History}
          title="No earlier payrolls for this employee"
          hint="Once payroll has run for them before, the previous ones are listed here."
          testId="pd-history-empty"
        />
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100">
          {history.map((h) => (
            <li key={h.payrollId} data-testid={`pd-history-${h.payrollId}`}>
              <Link
                href={payrollDetailsPath(kind, h.payrollId)}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-800">{h.label}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <PayStatusChip status={h.status} />
                    {h.issues > 0 ? (
                      <Chip tone="warning">{plural(h.issues, "issue")}</Chip>
                    ) : (
                      <Chip tone="success">Clean</Chip>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-black tabular-nums text-slate-900">{inr2(h.net)}</span>
                  <span className="block text-[11px] text-muted-foreground">net payable</span>
                </span>
                <ChevronRight size={16} className={`shrink-0 ${accent.text}`} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
