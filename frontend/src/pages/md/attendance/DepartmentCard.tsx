import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import Sparkline from "@/components/md/kit/Sparkline";
import { DeltaChip } from "@/components/md/kit/StatCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import CardBody from "./CardBody";
import TabStrip from "./TabStrip";
import { ask, pointsDelta, type AskContext } from "./logic";
import type { AttendanceDepartments, GroupRow } from "./types";

type View = "departments" | "units" | "types";

const NOUN: Record<View, string> = { departments: "Department", units: "Unit", types: "Group" };

function Change({ row }: { row: GroupRow }) {
  const d = pointsDelta(row.delta.attendancePct, true);
  if (!d) return <span className="text-xs text-muted-foreground">—</span>;
  return <DeltaChip {...d} />;
}

function columns(view: View, baseline: number | null | undefined): Column<GroupRow>[] {
  return [
    {
      key: "name",
      header: NOUN[view],
      sortValue: (r) => r.name,
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-[#1a3a4a]">{r.name}</p>
          <p className="text-[11px] text-[#006496]/55">
            {num(r.headcount)} {r.headcount === 1 ? "person" : "people"}
            {r.belowBaseline && <span className="ml-1.5 font-bold text-red-600">· below the company</span>}
          </p>
        </div>
      ),
    },
    {
      key: "attendance",
      header: "Attendance",
      align: "right",
      sortValue: (r) => r.attendancePct,
      cell: (r) => (
        <span
          className="font-bold tabular-nums"
          style={{
            color: r.attendancePct != null && baseline != null && r.attendancePct < baseline ? CHART.bad : undefined,
          }}
        >
          {pct(r.attendancePct)}
        </span>
      ),
    },
    {
      key: "absent",
      header: "Absent",
      align: "right",
      sortValue: (r) => r.absenteeismPct,
      cell: (r) => pct(r.absenteeismPct),
    },
    { key: "late", header: "Late", align: "right", sortValue: (r) => r.latePct, cell: (r) => pct(r.latePct) },
    {
      key: "overtime",
      header: "Overtime",
      align: "right",
      sortValue: (r) => r.overtimeHours,
      cell: (r) => (r.overtimeHours ? `${num(r.overtimeHours, 1)} h` : "—"),
    },
    {
      key: "change",
      header: "vs before",
      align: "right",
      sortValue: (r) => r.delta.attendancePct,
      cell: (r) => <Change row={r} />,
    },
    {
      key: "spark",
      header: "8 weeks",
      align: "right",
      cell: (r) => (
        <div className="flex justify-end">
          <Sparkline values={r.spark} color={CHART.brand} width={68} height={22} />
        </div>
      ),
    },
  ];
}

/**
 * Departments ranked by attendance (lowest first), and the same by unit and for staff against production. A row narrows
 * the whole page to it: the filters above show what is selected and clear it again.
 */
export default function DepartmentCard({
  query,
  context,
  onDepartment,
  onUnit,
  onType,
  className,
}: {
  query: UseQueryResult<AttendanceDepartments>;
  context: AskContext;
  onDepartment: (name: string) => void;
  onUnit: (id: number) => void;
  onType: (key: string) => void;
  className?: string;
}) {
  const [view, setView] = useState<View>("departments");
  const data = query.data;
  const items = [
    { value: "departments", label: "Departments", count: data?.departments.length },
    { value: "units", label: "Units", count: data?.units.length },
    { value: "types", label: "Staff and production" },
  ];
  const cols = useMemo(() => columns(view, data?.baseline?.attendancePct), [view, data?.baseline?.attendancePct]);
  const rows = data ? data[view] : [];
  const select = (row: GroupRow) => {
    if (view === "departments") onDepartment(row.name);
    else if (view === "units" && row.id != null) onUnit(row.id);
    else if (view === "types") onType(String(row.key));
  };
  return (
    <SectionCard
      testId="md-attendance-departments"
      className={className}
      title="Where attendance is weakest"
      subtitle={
        data?.baseline?.attendancePct != null
          ? `Company average ${pct(data.baseline.attendancePct)} · lowest first · click a row to look only at it`
          : "Lowest first · click a row to look only at it"
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask.departments(context)} />}
    >
      <TabStrip items={items} value={view} onChange={(v) => setView(v as View)} />
      <CardBody query={query}>
        {(d) =>
          rows.length === 0 ? (
            <EmptyBlock title="No departments to rank" testId="md-attendance-departments-empty">
              Nobody in this selection has an attendance record for the period.
            </EmptyBlock>
          ) : (
            <>
              <DataTable
                columns={cols}
                rows={rows}
                rowKey={(r) => r.key}
                onRowClick={select}
                pageSize={10}
                dense
                testId="md-attendance-department-table"
              />
              {d.total > d.departments.length && view === "departments" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the {d.departments.length} lowest of {d.total} departments.
                </p>
              )}
            </>
          )
        }
      </CardBody>
    </SectionCard>
  );
}
