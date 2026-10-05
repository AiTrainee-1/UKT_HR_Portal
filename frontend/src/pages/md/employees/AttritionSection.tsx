import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import DonutChart from "@/components/md/kit/DonutChart";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import TrendChart from "@/components/md/kit/TrendChart";
import { PillTabs } from "@/components/ui/pill-tabs";
import { dayLong, num, pct } from "@/lib/md/format";
import { attritionBars, bandRows, exitTick, reasonSlices, type Asks } from "./logic";
import { PersonCell, Unavailable } from "./parts";
import type { EarlyLeaver, EmployeesAttrition } from "./types";

type Group = "department" | "unit" | "type";

const GROUPS = [
  { value: "department", label: "Department" },
  { value: "unit", label: "Unit" },
  { value: "type", label: "Staff / production" },
];

const EARLY_COLUMNS: Column<EarlyLeaver>[] = [
  {
    key: "name",
    header: "Employee",
    cell: (r) => <PersonCell name={r.name} code={r.code} sub={r.designation ?? undefined} />,
  },
  { key: "department", header: "Department", cell: (r) => r.department, className: "hidden @3xl:table-cell" },
  { key: "joined", header: "Joined", cell: (r) => dayLong(r.joined), className: "hidden @xl:table-cell" },
  {
    key: "left",
    header: "Left",
    cell: (r) => (
      <span className="whitespace-nowrap">
        {dayLong(r.left)}
        {r.approximate && <span className="ml-1 text-[10px] font-semibold text-amber-700">approx.</span>}
      </span>
    ),
  },
  {
    key: "days",
    header: "Stayed",
    align: "right",
    cell: (r) => (r.days == null ? "—" : `${num(r.days)} ${r.days === 1 ? "day" : "days"}`),
    sortValue: (r) => r.days,
  },
  { key: "reason", header: "Reason", cell: (r) => r.reason, className: "hidden @3xl:table-cell" },
];

/** Where people leave from and why: attrition by group, how long they stayed, the reasons, and who left early. */
export default function AttritionSection({
  attrition: a,
  asks,
  onSelect,
  showingAll,
  onShowAll,
  failed,
}: {
  failed?: boolean;
  attrition: EmployeesAttrition | undefined;
  asks: Asks;
  onSelect: (employeeId: number) => void;
  /** True once the department list has been asked for in full. */
  showingAll: boolean;
  onShowAll: () => void;
}) {
  const [group, setGroup] = useState<Group>("department");
  if (!a) {
    return (
      <SectionCard title="Where people are leaving" loading={!failed} testId="md-employees-attrition">
        <Unavailable />
      </SectionCard>
    );
  }
  if (a.company.leavers === 0) {
    return (
      <SectionCard title="Where people are leaving" provenance={a.provenance} testId="md-employees-attrition">
        <EmptyBlock icon={CheckCircle2} title="Nobody left in this period">
          No one with an exit date in this period matches the unit, department and type chosen.
        </EmptyBlock>
      </SectionCard>
    );
  }
  const rows = group === "department" ? a.byDepartment : group === "unit" ? a.byUnit : a.byType;
  const company = a.company;
  const hiddenDepartments = a.departmentsWithLeavers - a.byDepartment.length;
  const tenure = a.tenureAtExit.map((r) => ({ label: r.label, count: r.count }));
  return (
    <div
      className="grid grid-cols-1 items-start gap-5 @2xl:grid-cols-2 @5xl:grid-cols-12"
      data-testid="md-employees-attrition"
    >
      <SectionCard
        className="@2xl:col-span-2 @5xl:col-span-5"
        title="Attrition by group"
        subtitle={`Company: ${pct(company.attritionPct)} · ${num(company.leavers)} left of an average ${num(
          company.averageHeadcount,
          0,
        )}`}
        provenance={a.provenance}
        provenanceIds={["attrition-by-group"]}
        actions={<AskAiButton question={asks.attrition} />}
        testId="md-employees-attrition-groups"
      >
        <div className="mb-3 overflow-x-auto">
          <PillTabs size="sm" items={GROUPS} value={group} onChange={(v) => setGroup(v as Group)} />
        </div>
        <BarList
          items={attritionBars(rows)}
          emptyText="Nobody left from this group in the period."
          testId="md-employees-attrition-bars"
        />
        {group === "department" && hiddenDepartments > 0 && !showingAll && (
          <button
            type="button"
            onClick={onShowAll}
            className="mt-3 w-full rounded-lg border border-dashed border-[#006496]/25 py-1.5 text-xs font-semibold text-[#006496] hover:bg-[#006496]/[0.05]"
            data-testid="md-employees-attrition-more"
          >
            Show {num(hiddenDepartments)} more {hiddenDepartments === 1 ? "department" : "departments"}
          </button>
        )}
        {group === "department" && a.departmentsTotal > a.departmentsWithLeavers && (
          <p className="mt-3 text-[11px] text-[#006496]/55">
            {num(a.departmentsTotal - a.departmentsWithLeavers)} other{" "}
            {a.departmentsTotal - a.departmentsWithLeavers === 1 ? "department" : "departments"} had no leavers.
          </p>
        )}
      </SectionCard>

      <SectionCard
        className="@5xl:col-span-3"
        title="How long people stayed"
        subtitle="Time from joining to leaving"
        provenance={a.provenance}
        provenanceIds={["tenure-at-exit"]}
        actions={<AskAiButton question={asks.tenure} />}
        testId="md-employees-tenure-at-exit"
      >
        <TrendChart
          data={bandRows(tenure)}
          xKey="label"
          series={[{ key: "count", label: "Leavers", kind: "bar", color: CHART.sky }]}
          xFormat={exitTick}
          yFormat={(v) => num(v)}
          height={230}
          allTicks
        />
      </SectionCard>

      <SectionCard
        className="@5xl:col-span-4"
        title="Why people leave"
        subtitle="Grouped from what they wrote"
        provenance={a.provenance}
        provenanceIds={["leaving-reasons"]}
        actions={<AskAiButton question={asks.reasons} />}
        testId="md-employees-reasons"
      >
        <DonutChart
          data={reasonSlices(a.reasons)}
          center={
            <>
              <p className="text-2xl font-black text-[#1a3a4a]">{num(company.leavers)}</p>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[#006496]/55">left</p>
            </>
          }
          height={160}
        />
      </SectionCard>

      <SectionCard
        className="@2xl:col-span-2 @5xl:col-span-12"
        title="Left within 90 days of joining"
        subtitle={
          a.early.count > 0
            ? `${num(a.early.count)} ${a.early.count === 1 ? "person" : "people"} · ${pct(a.early.pctOfLeavers, 0)} of leavers`
            : undefined
        }
        provenance={a.provenance}
        provenanceIds={["early-leavers"]}
        actions={<AskAiButton question={asks.early} />}
        testId="md-employees-early"
      >
        <DataTable
          columns={EARLY_COLUMNS}
          rows={a.early.items}
          rowKey={(r) => r.id}
          pageSize={5}
          onRowClick={(r) => onSelect(r.id)}
          empty="Nobody left within 90 days of joining in this period."
          testId="md-employees-early-table"
        />
        {a.early.count > a.early.items.length && (
          <p className="mt-2 text-[11px] text-[#006496]/55">
            The {num(a.early.items.length)} most recent of {num(a.early.count)} are listed.
          </p>
        )}
      </SectionCard>
    </div>
  );
}
