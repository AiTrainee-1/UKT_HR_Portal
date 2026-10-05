import { useState } from "react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { DeltaChip } from "@/components/md/kit/StatCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { PillTabs } from "@/components/ui/pill-tabs";
import { inr, inrCompact, num, pct } from "@/lib/md/format";
import { deltaView, groupRows, type GroupRow, type GroupView } from "./logic";
import { CardError, emptyReason, failed } from "./parts";
import type { PayrollQueries } from "./queries";

const VIEWS: { value: GroupView; label: string }[] = [
  { value: "department", label: "Departments" },
  { value: "unit", label: "Units" },
  { value: "type", label: "Staff vs production" },
];

const COLUMNS: Column<GroupRow>[] = [
  {
    key: "name",
    header: "Name",
    sortValue: (r) => r.name,
    cell: (r) => (
      <span className="font-semibold text-[#1a3a4a]">
        {r.name}
        {r.unit && <span className="ml-1.5 text-[11px] font-normal text-[#006496]/55">{r.unit}</span>}
      </span>
    ),
  },
  { key: "people", header: "People", align: "right", sortValue: (r) => r.headcount, cell: (r) => num(r.headcount) },
  {
    key: "gross",
    header: "Gross pay",
    align: "right",
    sortValue: (r) => r.grossPay,
    cell: (r) => <span className="font-semibold">{inrCompact(r.grossPay)}</span>,
  },
  {
    key: "perHead",
    header: "Per head",
    align: "right",
    sortValue: (r) => r.costPerHead,
    cell: (r) => (r.costPerHead != null ? inr(r.costPerHead) : "—"),
  },
  {
    key: "ot",
    header: "Overtime",
    align: "right",
    sortValue: (r) => r.overtimeSharePct,
    cell: (r) => pct(r.overtimeSharePct),
  },
  {
    key: "lop",
    header: "Loss-of-pay days",
    align: "right",
    sortValue: (r) => r.lopDays,
    cell: (r) => (r.lopDays != null ? num(r.lopDays, 1) : "—"),
  },
  {
    key: "change",
    header: "vs last month",
    align: "right",
    sortValue: (r) => r.change?.grossPay?.pct ?? null,
    cell: (r) => {
      const view = deltaView(r.change?.grossPay, "money", "down");
      return view ? <DeltaChip {...view} /> : <span className="text-xs text-muted-foreground">new</span>;
    },
  },
];

/** Who the money goes to: cost ranked by department, unit or staff vs production, with cost per head, overtime %,
 *  loss-of-pay days and the change on last month. */
export default function DepartmentsCard({ query, label }: { query: PayrollQueries["departments"]; label: string }) {
  const [view, setView] = useState<GroupView>("department");
  const data = query.data;
  const rows = groupRows(data, view);
  return (
    <SectionCard
      testId="md-payroll-departments"
      title="Where the cost sits"
      subtitle={`Gross pay in ${label} by department, unit or staff vs production`}
      loading={query.isPending}
      provenance={data?.provenance}
      provenanceIds={["departments", "loss-of-pay"]}
      actions={
        <AskAiButton
          question={`Which departments drive payroll cost in ${label}, and where did cost per head change most?`}
        />
      }
    >
      {failed(query) ? (
        <CardError query={query} />
      ) : !data?.hasData ? (
        <EmptyBlock title="No cost to rank">
          {emptyReason(data?.notes, "There is no payroll for this month in this selection.")}
        </EmptyBlock>
      ) : (
        <div className="space-y-4">
          <PillTabs size="sm" items={VIEWS} value={view} onChange={(v) => setView(v as GroupView)} />
          <BarList
            testId="md-payroll-dept-bars"
            items={rows.slice(0, 8).map((r) => ({
              key: r.key,
              label: r.name,
              value: r.grossPay,
              display: inrCompact(r.grossPay),
              // every unit has its own "Stitching": name the unit so the bars are not a list of look-alikes
              sub: `${r.unit ? `${r.unit} · ` : ""}${num(r.headcount)} ${r.headcount === 1 ? "person" : "people"} · ${
                r.costPerHead != null ? inr(r.costPerHead) : "—"
              } per head`,
            }))}
            emptyText="Nothing to rank."
          />
          <DataTable
            testId="md-payroll-dept-table"
            columns={COLUMNS}
            rows={rows}
            rowKey={(r) => r.key}
            initialSort={{ key: "gross", dir: "desc" }}
            pageSize={8}
            dense
          />
          {view === "department" && data.departmentsTotal > data.departments.length && (
            <p className="text-[11px] text-[#006496]/60">
              The {data.departments.length} highest-cost of {data.departmentsTotal} departments are shown.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
