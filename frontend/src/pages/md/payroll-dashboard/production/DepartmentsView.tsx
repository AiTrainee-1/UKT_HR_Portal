import { useState } from "react";
import { Building2 } from "lucide-react";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { inr, inrCompact, num, pct } from "@/lib/md/format";
import { arrowText, deltaOf, sortRows, type SortDir } from "../logic";
import { CardError, ChartLegend, Explain, Figure, failed } from "../parts";
import SortTable, { type Col } from "../SortTable";
import type { ProdDepartmentRow } from "../types";
import { DEPT_LEGEND, DeptChart } from "./charts";
import { prodDepartmentBars, prodDepartmentName } from "./logic";
import type { ProdQueries } from "./queries";

type DeptSort =
  | "department"
  | "employees"
  | "shifts"
  | "averageRatePerShift"
  | "grossPay"
  | "bonus"
  | "deductions"
  | "netPaid"
  | "companyCost"
  | "sharePct"
  | "change";

const valueOf = (r: ProdDepartmentRow, key: DeptSort): string | number | null => {
  if (key === "deductions") return r.deductions.total;
  if (key === "change") return r.change?.abs ?? null;
  return r[key];
};

/**
 * Departments: the chosen period split by department (the worker's department now), against the cycle's period before.
 * A department opens its workers on the Workers tab; the department filter highlights one instead of hiding the rest.
 */
export default function DepartmentsView({
  query,
  chosen,
  onOpen,
}: {
  query: ProdQueries["departments"];
  chosen: string;
  onOpen: (department: string) => void;
}) {
  const [sort, setSort] = useState<{ key: DeptSort; dir: SortDir }>({ key: "companyCost", dir: "desc" });
  const data = query.data;
  if (failed(query)) return <CardError query={query} />;
  if (query.isPending) return <SectionCard title="Departments" loading testId="md-prod-departments" />;
  if (!data || data.rows.length === 0) {
    return (
      <SectionCard title="Departments" testId="md-prod-departments-empty">
        <EmptyBlock icon={Building2} title="No department was paid in this period">
          {data?.notes[data.notes.length - 1] ?? "There are no payslips for this period in this selection."}
        </EmptyBlock>
      </SectionCard>
    );
  }
  const rows = sortRows(data.rows, (r) => valueOf(r, sort.key), sort.dir);
  const money = (
    key: Exclude<DeptSort, "department" | "employees" | "shifts" | "sharePct" | "change">,
    header: string,
  ) =>
    ({
      key,
      header,
      sortKey: key,
      align: "right",
      cell: (r: ProdDepartmentRow) => inr(valueOf(r, key) as number | null),
      total: inr(key === "deductions" ? data.totals.deductions.total : (data.totals[key] as number | null)),
    }) satisfies Col<ProdDepartmentRow>;
  const columns: Col<ProdDepartmentRow>[] = [
    {
      key: "department",
      header: "Department",
      sortKey: "department",
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-bold">{prodDepartmentName(r, data.rows)}</span>
          {r.unit && <span className="text-[11px] text-md-ink-soft">{r.unit}</span>}
        </span>
      ),
      total: <span className="font-extrabold">{data.rows.length} departments</span>,
    },
    {
      key: "employees",
      header: "Workers",
      sortKey: "employees",
      align: "right",
      cell: (r) => num(r.employees),
      total: num(data.totals.employees),
    },
    {
      key: "shifts",
      header: "Shifts",
      sortKey: "shifts",
      align: "right",
      cell: (r) => num(r.shifts, 1),
      total: num(data.totals.shifts, 1),
    },
    money("averageRatePerShift", "Rate / shift"),
    money("grossPay", "Gross pay"),
    money("bonus", "Excess - det."),
    money("deductions", "Deductions"),
    money("netPaid", "Net paid"),
    money("companyCost", "Company cost"),
    {
      key: "sharePct",
      header: "Share",
      sortKey: "sharePct",
      align: "right",
      cell: (r) => pct(r.sharePct),
      total: "100%",
    },
    {
      key: "change",
      header: "Cost change",
      sortKey: "change",
      align: "right",
      title: "Company cost against the cycle's period before",
      cell: (r) => (
        <span className="font-semibold tabular-nums">{arrowText(deltaOf(r.change, "money", "neutral"))}</span>
      ),
    },
  ];
  const top = data.rows[0];
  return (
    <div className="space-y-4 @lg:space-y-5" data-testid="md-prod-departments">
      {data.notes.map((n) => (
        <NoteBanner key={n}>{n}</NoteBanner>
      ))}
      <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4" data-testid="md-prod-dept-figures">
        <Figure label="Departments" value={num(data.rows.length)} emphasis testId="md-prod-dept-count" />
        <Figure label="Company cost" value={inrCompact(data.totals.companyCost)} testId="md-prod-dept-cost" />
        <Figure
          label="Costliest"
          value={prodDepartmentName(top, data.rows)}
          sub={`${inrCompact(top.companyCost)} · ${pct(top.sharePct)}`}
          testId="md-prod-dept-top"
        />
        <Figure
          label="Compared with"
          value={data.previousPeriod?.label ?? "—"}
          sub={data.previousPeriod ? "the cycle's period before" : "no earlier period"}
          testId="md-prod-dept-previous"
        />
      </div>
      <SectionCard
        testId="md-prod-dept-chart-card"
        title={`${data.cycleLabel} · ${data.period?.label}`}
        subtitle="Company cost and net paid by department. Click a department to see its workers."
        actions={<Explain ids={["prod-cost", "prod-net"]} />}
      >
        <DeptChart rows={prodDepartmentBars(data.rows)} onSelect={onOpen} />
        <ChartLegend items={DEPT_LEGEND} testId="md-prod-dept-legend" />
      </SectionCard>
      <SectionCard
        testId="md-prod-dept-table"
        title="Every department"
        subtitle="Click a department to open its workers."
        actions={<Explain ids={["prod-gross", "excess", "deductions", "prod-cost"]} />}
      >
        <SortTable
          caption="Departments of the period"
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.department}|${r.unit ?? ""}`}
          sort={sort}
          onSort={(key) =>
            setSort((s) =>
              s.key === key
                ? { key: s.key, dir: s.dir === "asc" ? "desc" : "asc" }
                : { key: key as DeptSort, dir: key === "department" ? "asc" : "desc" },
            )
          }
          onRowClick={(r) => onOpen(r.department)}
          rowLabel={(r) => `Open the workers of ${r.department}`}
          highlight={(r) => !!chosen && r.department === chosen}
          totals
          minWidth="60rem"
        />
      </SectionCard>
    </div>
  );
}
