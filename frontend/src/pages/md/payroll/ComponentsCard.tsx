import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { inr, inrCompact } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { deltaView } from "./logic";
import { CardError, Delta, Metric, cardNotes, emptyReason, failed } from "./parts";
import type { PayrollQueries } from "./queries";
import type { ComponentLine } from "./types";

/** A table of heads: this month, last month, the change. `strong` makes the total row bold. */
function Lines({
  title,
  lines,
  total,
  previousLabel,
  testId,
}: {
  title: string;
  lines: ComponentLine[];
  total?: ComponentLine;
  previousLabel?: string | null;
  testId: string;
}) {
  const row = (l: ComponentLine, strong = false) => {
    const view = deltaView(l.change, "money", "neutral");
    return (
      <tr key={l.id} className={cn(strong && "md-money-total")} data-testid={`${testId}-${l.id}`}>
        <td className="text-[13px] text-md-ink">{l.label}</td>
        <td className="text-right text-[13px] text-md-ink">{inr(l.amount)}</td>
        <td className="hidden text-right text-[12.5px] text-md-ink-soft sm:table-cell">
          {l.previous != null ? inr(l.previous) : "—"}
        </td>
        <td className="text-right">{view ? <Delta {...view} /> : null}</td>
      </tr>
    );
  };
  return (
    <div className="md-panel overflow-hidden">
      <table className="md-money-table w-full" data-testid={testId}>
        <thead>
          <tr>
            <th className="text-left">{title}</th>
            <th className="text-right">This month</th>
            <th className="hidden text-right sm:table-cell">{previousLabel ?? "Last month"}</th>
            <th className="text-right">Change</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => row(l))}
          {total && row(total, true)}
        </tbody>
      </table>
    </div>
  );
}

/** What the money is made of: earnings and deductions by head with last month beside them, the employer's share and
 *  statutory dues (estimates), what is still to be paid, and the statutory bonus (which is not on the slips). */
export default function ComponentsCard({ query, label }: { query: PayrollQueries["components"]; label: string }) {
  const data = query.data;
  const bonus = data?.statutoryBonus;
  return (
    <SectionCard
      testId="md-payroll-components"
      title="What the money is made of"
      subtitle={`Earnings and deductions in ${label}, with the month before`}
      loading={query.isPending}
      provenance={data?.provenance}
      provenanceIds={["components", "deductions", "employer-cost", "statutory-due", "statutory-bonus"]}
      actions={
        <AskAiButton
          question={`What are the biggest earnings and deductions in ${label}, and what changed since the month before?`}
        />
      }
    >
      {failed(query) ? (
        <CardError query={query} />
      ) : !data?.hasData ? (
        <EmptyBlock title="No payroll to break down">
          {emptyReason(data?.notes, "There is no payroll for this month in this selection.")}
        </EmptyBlock>
      ) : (
        <div className="space-y-5">
          <Lines
            title="Earnings"
            lines={data.earnings}
            total={data.grossPay}
            previousLabel={data.previousLabel}
            testId="md-payroll-components-earnings"
          />
          <Lines
            title="Deductions"
            lines={data.deductions}
            total={data.totalDeductions}
            previousLabel={data.previousLabel}
            testId="md-payroll-components-deductions"
          />
          {data.netPay && (
            <div
              className="md-panel-wine flex items-baseline justify-between gap-3 px-4 py-3"
              data-testid="md-payroll-components-net"
            >
              <span className="text-[13px] font-extrabold text-md-ink">Net pay (take-home)</span>
              <span className="text-lg font-black tracking-tight tabular-nums text-md-wine">
                {inr(data.netPay.amount)}
              </span>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2" data-testid="md-payroll-components-extras">
            <Metric
              label="Employer cost (estimate)"
              value={data.employerCost ? inrCompact(data.employerCost.amount) : "—"}
              sub={
                data.employer.length
                  ? data.employer.map((e) => `${e.label.replace(" (estimate)", "")} ${inr(e.amount)}`).join(" · ")
                  : undefined
              }
            />
            <Metric
              label="Statutory dues (estimate)"
              value={data.statutoryDue != null ? inrCompact(data.statutoryDue) : "—"}
              sub="PF and ESI: employees' deductions plus the employer's share"
            />
            <Metric
              label="Net pay still to be marked paid"
              value={data.payable ? inrCompact(data.payable.netPay) : "—"}
              sub={data.payable ? `${data.payable.slips} slip(s)` : undefined}
              testId="md-payroll-components-payable"
            />
            {bonus && (
              <Metric
                label={`Statutory bonus FY ${bonus.financialYear}`}
                value={inrCompact(bonus.total)}
                sub={`${inrCompact(bonus.notPaid)} not yet marked paid · paid outside the monthly slips`}
                testId="md-payroll-components-bonus"
              />
            )}
          </div>
          {cardNotes(data.notes).map((n) => (
            <NoteBanner key={n}>{n}</NoteBanner>
          ))}
          <p className="text-[11.5px] leading-snug text-md-ink-soft">
            Income tax (TDS) and arrears are not recorded in this system, so they are not shown.
          </p>
        </div>
      )}
    </SectionCard>
  );
}
