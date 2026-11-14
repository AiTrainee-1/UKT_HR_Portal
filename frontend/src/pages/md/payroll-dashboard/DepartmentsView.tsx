import { useState } from "react";
import { ArrowRight, Building2, CalendarCheck2, Coins, Landmark } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DonutChart from "@/components/md/kit/DonutChart";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard from "@/components/md/kit/StatCard";
import { EmptyBlock, NoteBanner } from "@/components/md/kit/states";
import { useElementWidth } from "@/components/payroll/statement/use-element-width";
import { CHART } from "@/components/md/kit/chartTheme";
import { inr, inrCompact, num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { DEPARTMENT_LEGEND, DepartmentChart } from "./charts";
import { GLOSSARY } from "./glossary";
import {
  arrowText,
  changeBetween,
  daysText,
  deltaOf,
  departmentBars,
  departmentName,
  departmentValue,
  sortRows,
  type DepartmentMeasure,
  type DepartmentSort,
  type SortDir,
} from "./logic";
import { CardError, ChartLegend, Explain, Seg, failed } from "./parts";
import type { DashQueries } from "./queries";
import SortTable, { type Col } from "./SortTable";
import type { PayDepartmentRow, PayDepartmentsResponse } from "./types";

const MEASURES: { value: DepartmentMeasure; label: string }[] = [
  { value: "cost", label: "Company cost" },
  { value: "pay", label: "Paid vs deducted" },
  { value: "average", label: "Average pay" },
];

const MEASURE_NOTE: Record<DepartmentMeasure, string> = {
  cost: "What each department cost the company in the month.",
  pay: "Each bar: net paid + other deductions + attendance deductions.",
  average: "Earned salary and net paid per employee.",
};

/** How many bars show before "Show all": fewer on a phone, so the chart stays about a screen's height. */
const BAR_LIMIT = { narrow: 6, wide: 10 };
const DONUT_SLICES = 6;

function Totals({ data }: { data: PayDepartmentsResponse }) {
  const t = data.totals;
  const top = [...data.rows].sort((a, b) => b.companyCost - a.companyCost)[0];
  return (
    <div className="grid grid-cols-2 gap-2.5 @lg:gap-3 @3xl:grid-cols-4" data-testid="md-pay-dept-totals">
      <StatCard
        testId="md-pay-dept-count"
        label="Departments"
        icon={Building2}
        tone="slate"
        value={num(data.rows.length)}
        sub={`${num(t.employees)} employees paid`}
        provenance={GLOSSARY}
        provenanceIds={["employees"]}
      />
      <StatCard
        testId="md-pay-dept-cost"
        label="Company cost"
        icon={Landmark}
        tone="blue"
        value={inrCompact(t.companyCost)}
        sub={top ? `largest: ${departmentName(top, data.rows)} (${pct(top.sharePct)})` : undefined}
        provenance={GLOSSARY}
        provenanceIds={["company-cost", "share"]}
      />
      <StatCard
        testId="md-pay-dept-average"
        label="Average earned"
        icon={Coins}
        tone="teal"
        value={inrCompact(t.averageEarned)}
        sub={`per employee · ${inrCompact(t.averageNetPaid)} net paid`}
        provenance={GLOSSARY}
        provenanceIds={["earned-salary", "net-paid"]}
      />
      <StatCard
        testId="md-pay-dept-attendance"
        label="Attendance"
        icon={CalendarCheck2}
        tone="indigo"
        value={pct(t.attendancePct)}
        sub={`${daysText(t.paidDays)} of ${daysText(t.workingDays)} days paid`}
        provenance={GLOSSARY}
        provenanceIds={["attendance-pct", "days"]}
      />
    </div>
  );
}

function ComparisonCard({
  data,
  onOpen,
}: {
  data: PayDepartmentsResponse;
  onOpen: (row: { department: string }) => void;
}) {
  const [measure, setMeasure] = useState<DepartmentMeasure>("cost");
  const [all, setAll] = useState(false);
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 480;
  const bars = departmentBars(data.rows);
  const limit = narrow ? BAR_LIMIT.narrow : BAR_LIMIT.wide;
  const shown = all ? bars : bars.slice(0, limit);
  return (
    <SectionCard
      testId="md-pay-dept-chart-card"
      title="Departments compared"
      subtitle={`${MEASURE_NOTE[measure]} Click a department to see its employees.`}
      actions={
        <>
          <AskAiButton question={`Which departments cost the most in ${data.label}, and why?`} />
          <Explain ids={["company-cost", "net-paid", "other-deductions", "attendance-deductions"]} />
        </>
      }
      className="h-full"
    >
      <div ref={ref}>
        <Seg
          items={MEASURES}
          value={measure}
          onChange={setMeasure}
          label="What the chart shows"
          testId="md-pay-dept-measure"
        />
        <div className="mt-3">
          <DepartmentChart bars={shown} measure={measure} onPick={onOpen} narrow={narrow} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ChartLegend items={DEPARTMENT_LEGEND[measure]} testId="md-pay-dept-legend" />
          {bars.length > limit && (
            <button
              type="button"
              className="md-btn md-btn-soft md-btn-sm mt-2"
              onClick={() => setAll((v) => !v)}
              data-testid="md-pay-dept-all"
            >
              {all ? `Show the top ${limit}` : `Show all ${bars.length}`}
            </button>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function ShareCard({ data }: { data: PayDepartmentsResponse }) {
  const bars = departmentBars(data.rows);
  const top = bars.slice(0, DONUT_SLICES);
  const rest = bars.slice(DONUT_SLICES);
  const slices = [
    ...top.map((b, i) => ({ name: b.name, value: b.companyCost, color: CHART.series[i % CHART.series.length] })),
    ...(rest.length
      ? [{ name: `${rest.length} more`, value: rest.reduce((a, b) => a + b.companyCost, 0), color: CHART.slate }]
      : []),
  ];
  return (
    <SectionCard
      testId="md-pay-dept-share"
      title="Share of company cost"
      subtitle={`Where ${inrCompact(data.totals.companyCost)} went in ${data.label}`}
      actions={<Explain ids={["share"]} />}
      className="h-full"
    >
      <DonutChart
        data={slices}
        format={(n) => inrCompact(n)}
        height={176}
        center={
          <>
            <span className="text-[11px] font-semibold text-md-ink-soft">Total</span>
            <span className="text-base font-black tabular-nums">{inrCompact(data.totals.companyCost)}</span>
          </>
        }
      />
    </SectionCard>
  );
}

function DepartmentTable({
  data,
  chosen,
  onOpen,
}: {
  data: PayDepartmentsResponse;
  chosen: string;
  onOpen: (row: PayDepartmentRow) => void;
}) {
  const [sort, setSort] = useState<{ key: DepartmentSort; dir: SortDir }>({ key: "companyCost", dir: "desc" });
  const rows = sortRows(data.rows, (r) => departmentValue(r, sort.key), sort.dir);
  const t = data.totals;
  const previousTotal = data.rows.reduce<number | null>(
    (a, r) => (r.previousCompanyCost == null ? a : (a ?? 0) + r.previousCompanyCost),
    null,
  );
  const money = (
    key: Exclude<DepartmentSort, "department" | "employees" | "attendancePct" | "clDays" | "sharePct" | "change">,
    header: string,
    total: number | null,
    title?: string,
  ) =>
    ({
      key,
      header,
      sortKey: key,
      align: "right",
      title,
      cell: (r: PayDepartmentRow) => inr(departmentValue(r, key) as number | null),
      total: inr(total),
    }) satisfies Col<PayDepartmentRow>;
  const columns: Col<PayDepartmentRow>[] = [
    {
      key: "department",
      header: "Department",
      sortKey: "department",
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-bold text-md-ink">{r.department}</span>
          <span className="text-[11px] font-medium text-md-ink-soft">{r.unit ?? "—"}</span>
        </span>
      ),
      total: <span className="font-extrabold">All departments</span>,
    },
    {
      key: "employees",
      header: "Employees",
      sortKey: "employees",
      align: "right",
      cell: (r) => num(r.employees),
      total: num(t.employees),
    },
    money("actualSalary", "Actual", t.actualSalary, "Full monthly salary of the staff"),
    money("earnedSalary", "Earned", t.earnedSalary),
    money("attendanceDeduction", "Attendance ded.", t.attendanceDeduction, "Loss of pay + late / early-out penalties"),
    money("deductions", "Deductions", t.deductions.total, "Every line taken off the slips"),
    money("netPaid", "Net paid", t.netPaid),
    money("companyCost", "Company cost", t.companyCost),
    money("averageEarned", "Avg earned", t.averageEarned, "Earned salary per employee"),
    money("averageNetPaid", "Avg net paid", t.averageNetPaid, "Net paid per employee"),
    {
      key: "attendancePct",
      header: "Attendance",
      sortKey: "attendancePct",
      align: "right",
      title: "Paid days / working days",
      cell: (r) => pct(r.attendancePct),
      total: pct(t.attendancePct),
    },
    {
      key: "clDays",
      header: "CL days",
      sortKey: "clDays",
      align: "right",
      cell: (r) => daysText(r.clDays),
      total: daysText(t.clDays),
    },
    money("clAmount", "CL amount", t.clAmount),
    {
      key: "sharePct",
      header: "Share",
      sortKey: "sharePct",
      align: "right",
      title: "Share of the company cost",
      cell: (r) => (
        <span className="inline-flex items-center justify-end gap-2">
          <span className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-md-ink/10 @3xl:inline-block" aria-hidden>
            <span className="block h-full rounded-full bg-md-wine" style={{ width: `${Math.min(100, r.sharePct)}%` }} />
          </span>
          {pct(r.sharePct)}
        </span>
      ),
      total: "100%",
    },
    {
      key: "change",
      header: "vs last month",
      sortKey: "change",
      align: "right",
      title: "Company cost against the month before",
      cell: (r) => {
        const d = deltaOf(r.change, "money", "neutral");
        return d ? (
          <span className="font-semibold tabular-nums" data-direction={d.direction}>
            {arrowText(d)}
          </span>
        ) : (
          <span className="text-md-ink-soft">new</span>
        );
      },
      total: (() => {
        const d = deltaOf(changeBetween(t.companyCost, previousTotal), "money");
        return d ? arrowText(d) : "";
      })(),
    },
    {
      key: "open",
      header: <span className="sr-only">Open</span>,
      align: "right",
      cell: () => <ArrowRight size={14} className="inline text-md-ink-soft" aria-hidden />,
    },
  ];
  return (
    <SectionCard
      testId="md-pay-dept-table"
      title="Every department"
      subtitle="Sort by any column. Click a department to see its employees."
      actions={
        <Explain
          ids={["actual-salary", "earned-salary", "attendance-deductions", "deductions", "cl", "attendance-pct"]}
        />
      }
    >
      <SortTable
        caption="Payroll by department"
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.department}|${r.unit ?? ""}`}
        sort={sort}
        onSort={(key) =>
          setSort((s) =>
            s.key === key
              ? { key: s.key, dir: s.dir === "asc" ? "desc" : "asc" }
              : { key: key as DepartmentSort, dir: key === "department" ? "asc" : "desc" },
          )
        }
        onRowClick={onOpen}
        rowLabel={(r) => `See the employees of ${r.department}`}
        highlight={chosen ? (r) => r.department === chosen : undefined}
        totals
        minWidth="64rem"
      />
    </SectionCard>
  );
}

/**
 * Departments: how the month's salary cost spreads over the departments: a comparison chart, the share of the total, and a
 * table with every figure, sortable. A department opens its employees on the Employees tab.
 */
export default function DepartmentsView({
  query,
  chosen,
  onOpen,
}: {
  query: DashQueries["departments"];
  /** the department filter: highlighted, not filtered (this tab compares them all) */
  chosen: string;
  onOpen: (department: string) => void;
}) {
  const data = query.data;
  if (failed(query)) return <CardError query={query} />;
  if (query.isPending || !data) {
    return (
      <div className="space-y-4 @lg:space-y-5" data-testid="md-pay-departments" aria-busy="true">
        <SectionCard title="Departments compared" loading />
      </div>
    );
  }
  if (data.rows.length === 0) {
    return (
      <SectionCard title="Departments" testId="md-pay-dept-empty">
        <EmptyBlock icon={Building2} title={`No department was paid in ${data.label ?? "this month"}`}>
          There are no salary slips for this unit and type in the month.
        </EmptyBlock>
      </SectionCard>
    );
  }
  return (
    <div
      className={cn("space-y-4 @lg:space-y-5", query.isPlaceholderData && "opacity-70")}
      data-testid="md-pay-departments"
    >
      {data.notes.map((n) => (
        <NoteBanner key={n}>{n}</NoteBanner>
      ))}
      {chosen && (
        <p className="px-1 text-[12px] font-medium text-md-ink-soft" data-testid="md-pay-dept-chosen">
          Every department is shown to compare; {chosen} is highlighted.
        </p>
      )}
      <Totals data={data} />
      <div className="grid grid-cols-1 items-stretch gap-4 @lg:gap-5 @5xl:grid-cols-12">
        <div className="min-w-0 @5xl:col-span-8">
          <ComparisonCard data={data} onOpen={(r) => onOpen(r.department)} />
        </div>
        {/* not on a phone: the ring's legend has no room for the names there, and the chart above and the table's Share
            column already say the same */}
        <div className="hidden min-w-0 @2xl:block @5xl:col-span-4">
          <ShareCard data={data} />
        </div>
      </div>
      <DepartmentTable data={data} chosen={chosen} onOpen={(r) => onOpen(r.department)} />
    </div>
  );
}
