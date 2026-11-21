import { Users } from "lucide-react";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { inr, inrCompact, num } from "@/lib/md/format";
import { CardError, Explain, Figure, Pager, ToneChip, failed } from "../parts";
import SortTable, { type Col } from "../SortTable";
import type { ProdWorkerRow } from "../types";
import { nextProdSort, paymentWords, type ProdSort, type ProdState } from "./logic";
import { WORKERS_PAGE_SIZE, type ProdQueries, type ProdUpdate } from "./queries";

/**
 * Workers: everyone paid in the chosen period (searched, sorted and paged on the server), the selection added up above. A
 * worker opens their pay periods inside the page.
 */
export default function WorkersView({
  query,
  state,
  update,
  onOpen,
}: {
  query: ProdQueries["people"];
  state: ProdState;
  update: ProdUpdate;
  onOpen: (id: number) => void;
}) {
  const data = query.data;
  if (failed(query)) return <CardError query={query} />;
  if (query.isPending) return <SectionCard title="Workers" loading testId="md-prod-workers" />;
  if (!data || data.total === 0) {
    return (
      <SectionCard title="Workers" testId="md-prod-workers-empty">
        <EmptyBlock icon={Users} title={state.q ? `Nobody matches "${state.q}"` : "Nobody was paid in this period"}>
          {data?.notes[data.notes.length - 1] ?? "There are no payslips for this period in this selection."}
        </EmptyBlock>
        {state.q && (
          <button type="button" className="md-btn md-btn-soft md-btn-sm mt-3" onClick={() => update({ q: "" })}>
            Clear the search
          </button>
        )}
      </SectionCard>
    );
  }
  const t = data.totals;
  const sortable = (key: ProdSort) => key;
  const columns: Col<ProdWorkerRow>[] = [
    {
      key: "name",
      header: "Worker",
      sortKey: sortable("name"),
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-bold">{r.name}</span>
          <span className="font-mono text-[11px] text-md-ink-soft">
            {r.code}
            {r.status !== "active" ? ` · ${r.status}` : ""}
          </span>
        </span>
      ),
    },
    {
      key: "department",
      header: "Department",
      sortKey: sortable("department"),
      cell: (r) => (
        <span className="flex flex-col">
          <span>{r.department ?? "—"}</span>
          {r.unit && <span className="text-[11px] text-md-ink-soft">{r.unit}</span>}
        </span>
      ),
    },
    { key: "ratePerShift", header: "Rate", sortKey: "ratePerShift", align: "right", cell: (r) => inr(r.ratePerShift) },
    {
      key: "shifts",
      header: "Shifts",
      sortKey: "shifts",
      align: "right",
      cell: (r) => (
        <span className="flex flex-col items-end">
          <span className="font-semibold">{num(r.shifts, 1)}</span>
          {r.daysPaid !== r.periodDays && (
            <span className="text-[11px] text-md-ink-soft" title="Days this payslip pays, of the period's days">
              {num(r.daysPaid)} of {num(r.periodDays)} days
            </span>
          )}
        </span>
      ),
    },
    {
      key: "daysAbsent",
      header: "Absent",
      sortKey: "daysAbsent",
      align: "right",
      cell: (r) => `${num(r.daysAbsent)} d`,
    },
    { key: "lateDays", header: "Late", sortKey: "lateDays", align: "right", cell: (r) => num(r.lateDays) },
    { key: "grossPay", header: "Gross pay", sortKey: "grossPay", align: "right", cell: (r) => inr(r.grossPay) },
    {
      key: "bonus",
      header: "Excess - det.",
      sortKey: "bonus",
      align: "right",
      cell: (r) => (r.bonus ? inr(r.bonus) : <span className="text-md-ink-soft">—</span>),
    },
    {
      key: "deductions",
      header: "Deductions",
      sortKey: "deductions",
      align: "right",
      cell: (r) => inr(r.deductions.total),
    },
    {
      key: "netPaid",
      header: "Net paid",
      sortKey: "netPaid",
      align: "right",
      cell: (r) => <span className="font-bold">{inr(r.netPaid)}</span>,
    },
    {
      key: "payment",
      header: "Payment",
      cell: (r) => {
        const w = paymentWords(r.paymentStatus, r.cleared);
        return (
          <ToneChip tone={w.tone} className="text-[11px]">
            {w.label}
          </ToneChip>
        );
      },
    },
  ];
  return (
    <div className="space-y-4 @lg:space-y-5" data-testid="md-prod-workers">
      {data.notes.map((n) => (
        <NoteBanner key={n}>{n}</NoteBanner>
      ))}
      <div
        className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-5 @max-3xl:[&>*:last-child:nth-child(odd)]:col-span-2"
        data-testid="md-prod-workers-totals"
      >
        <Figure
          label="Workers"
          value={num(data.total)}
          sub={state.q ? `matching "${state.q}"` : undefined}
          emphasis
          testId="md-prod-workers-count"
        />
        <Figure
          label="Shifts"
          value={num(t.shifts, 1)}
          sub={`${num(t.shiftsPerWorker, 1)} per worker`}
          testId="md-prod-workers-shifts"
        />
        <Figure
          label="Gross pay"
          value={inrCompact(t.grossPay)}
          sub={`avg ${inr(t.averageRatePerShift)} a shift`}
          testId="md-prod-workers-gross"
        />
        <Figure label="Deductions" value={inrCompact(t.deductions.total)} testId="md-prod-workers-deductions" />
        <Figure
          label="Net paid"
          value={inrCompact(t.netPaid)}
          sub={`${inr(t.averageNetPerWorker)} a worker`}
          testId="md-prod-workers-net"
        />
      </div>
      <SectionCard
        testId="md-prod-workers-table"
        title={`${data.cycleLabel} · ${data.period?.label}`}
        subtitle="Click a worker to open their pay periods, day by day."
        actions={<Explain ids={["prod-gross", "prod-shifts", "excess", "prod-net"]} />}
      >
        <SortTable
          caption="Workers of the period"
          columns={columns}
          rows={data.rows}
          rowKey={(r) => r.employeeId}
          sort={{ key: state.sort, dir: state.dir }}
          onSort={(key) => update(nextProdSort(state, key as ProdSort))}
          onRowClick={(r) => onOpen(r.employeeId)}
          rowLabel={(r) => `Open the pay periods of ${r.name}`}
          minWidth="62rem"
        />
        <div className="mt-3">
          <Pager
            total={data.total}
            page={data.page}
            pageSize={WORKERS_PAGE_SIZE}
            onPage={(page) => update({ page })}
            noun="workers"
          />
        </div>
      </SectionCard>
    </div>
  );
}
