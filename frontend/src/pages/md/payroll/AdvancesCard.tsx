import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { inrCompact, num } from "@/lib/md/format";
import { signedInrCompact } from "./logic";
import { CardError, Metric, cardNotes, failed } from "./parts";
import type { PayrollQueries } from "./queries";

const people = (n: number) => `${num(n)} ${n === 1 ? "person" : "people"}`;

/** Money lent to employees and not yet recovered: what is owed today, what moved this month, how old it is, what is
 *  overdue and what sits with people who have left. */
export default function AdvancesCard({ query, label }: { query: PayrollQueries["advances"]; label: string }) {
  const data = query.data;
  return (
    <SectionCard
      testId="md-payroll-advances"
      title="Advances and loans"
      subtitle={`Outstanding today · given and recovered in ${label}`}
      loading={query.isPending}
      provenance={data?.provenance}
      provenanceIds={["advances-outstanding", "advances-month", "advances-ageing"]}
      actions={<AskAiButton question="How much do employees owe in advances and loans, and is it growing?" />}
    >
      {failed(query) ? (
        <CardError query={query} />
      ) : !data?.hasData ? (
        <EmptyBlock title="No advances outstanding">
          No salary advance or loan is outstanding or moved in this selection.
        </EmptyBlock>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2" data-testid="md-payroll-advances-metrics">
            <Metric
              testId="md-payroll-advances-outstanding"
              label="Outstanding today"
              value={inrCompact(data.outstanding.amount)}
              sub={`${num(data.outstanding.advances)} advances · ${people(data.outstanding.borrowers)}`}
            />
            <Metric
              testId="md-payroll-advances-net"
              label={`Net movement in ${label}`}
              value={signedInrCompact(data.netMovement)}
              sub={`${inrCompact(data.newThisMonth.amount)} given · ${inrCompact(data.recoveredThisMonth.amount)} recovered`}
            />
            <Metric
              testId="md-payroll-advances-overdue"
              label="Overdue instalments"
              value={inrCompact(data.overdue.amount)}
              sub={`${num(data.overdue.count)} instalments · ${people(data.overdue.people)}`}
            />
            <Metric
              testId="md-payroll-advances-left"
              label="Held by people who left"
              value={inrCompact(data.exEmployees.amount)}
              sub={
                data.exEmployees.borrowers
                  ? `${people(data.exEmployees.borrowers)}: recover in final settlement`
                  : "none"
              }
            />
          </div>
          <div>
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
              How long ago they were sanctioned
            </h4>
            <BarList
              testId="md-payroll-advances-ageing"
              color={CHART.warn}
              items={data.ageing.map((a) => ({
                key: a.label,
                label: a.label,
                value: a.amount,
                display: inrCompact(a.amount),
                sub: a.advances ? `${num(a.advances)} advance${a.advances === 1 ? "" : "s"}` : undefined,
              }))}
            />
          </div>
          {cardNotes(data.notes).map((n) => (
            <NoteBanner key={n}>{n}</NoteBanner>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
