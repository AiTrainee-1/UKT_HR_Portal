import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayShort, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import CardBody from "./CardBody";
import { EXCEPTION_TABS, ask, datesText, exceptionCounts, firstBusyTab, ruleText, type AskContext } from "./logic";
import TabStrip from "./TabStrip";
import type {
  AfterOffRow,
  AttendanceExceptions,
  ChronicRow,
  ExceptionKey,
  LateRow,
  LongAbsenceRow,
  PersonRow,
  PunchRow,
} from "./types";

function Who({ row }: { row: PersonRow }) {
  return (
    <div className="min-w-[9rem]">
      <p className="truncate font-semibold text-[#1a3a4a]">{row.name}</p>
      <p className="truncate text-[11px] text-[#006496]/55">
        {row.code} · {row.department} · {row.unit}
      </p>
    </div>
  );
}

const who = <T extends PersonRow>(): Column<T> => ({
  key: "who",
  header: "Employee",
  sortValue: (r) => r.name,
  cell: (r) => <Who row={r} />,
});

const dates = <T extends { dates: string[] }>(header = "Latest dates"): Column<T> => ({
  key: "dates",
  header,
  cell: (r) => <span className="text-xs text-[#1a3a4a]/80">{datesText(r.dates)}</span>,
});

const COLUMNS = {
  chronicAbsentees: [
    who<ChronicRow>(),
    {
      key: "days",
      header: "Absent days",
      align: "right",
      sortValue: (r) => r.absentDays,
      cell: (r) => `${r.absentDays} of ${r.scheduledDays}`,
    },
    { key: "pct", header: "Absent %", align: "right", sortValue: (r) => r.absentPct, cell: (r) => pct(r.absentPct) },
    {
      key: "informed",
      header: "Informed",
      align: "right",
      sortValue: (r) => r.informedDays,
      cell: (r) => r.informedDays || "—",
    },
    dates<ChronicRow>(),
  ] satisfies Column<ChronicRow>[],
  habitualLate: [
    who<LateRow>(),
    {
      key: "days",
      header: "Late days",
      align: "right",
      sortValue: (r) => r.lateDays,
      cell: (r) => `${r.lateDays} of ${r.workedDays}`,
    },
    { key: "pct", header: "Late %", align: "right", sortValue: (r) => r.latePct, cell: (r) => pct(r.latePct) },
    {
      key: "avg",
      header: "Average late",
      align: "right",
      sortValue: (r) => r.avgLateMinutes,
      cell: (r) => (r.avgLateMinutes != null ? `${Math.round(r.avgLateMinutes)} min` : "—"),
    },
    dates<LateRow>(),
  ] satisfies Column<LateRow>[],
  longAbsences: [
    who<LongAbsenceRow>(),
    { key: "days", header: "Days in a row", align: "right", sortValue: (r) => r.streakDays, cell: (r) => r.streakDays },
    { key: "span", header: "From – to", cell: (r) => `${dayShort(r.from)} – ${dayShort(r.to)}` },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => (r.ongoing ? 1 : 0),
      cell: (r) => (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-bold",
            r.ongoing ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600",
          )}
        >
          {r.ongoing ? "Still absent" : "Back at work"}
        </span>
      ),
    },
    { key: "last", header: "Last worked", cell: (r) => dayShort(r.lastWorked) },
  ] satisfies Column<LongAbsenceRow>[],
  missingPunches: [
    who<PunchRow>(),
    { key: "n", header: "Requests", align: "right", sortValue: (r) => r.requests, cell: (r) => r.requests },
    { key: "pending", header: "Waiting", align: "right", sortValue: (r) => r.pending, cell: (r) => r.pending || "—" },
    { key: "approved", header: "Approved", align: "right", cell: (r) => r.approved || "—" },
    { key: "rejected", header: "Rejected", align: "right", cell: (r) => r.rejected || "—" },
    dates<PunchRow>("Dates missed"),
  ] satisfies Column<PunchRow>[],
  afterOffAbsences: [
    who<AfterOffRow>(),
    { key: "abs", header: "Absences", align: "right", sortValue: (r) => r.absences, cell: (r) => r.absences },
    {
      key: "after",
      header: "After a day off",
      align: "right",
      sortValue: (r) => r.afterOffAbsences,
      cell: (r) => `${r.afterOffAbsences} (${pct(r.sharePct, 0)})`,
    },
    { key: "mon", header: "Mondays", align: "right", cell: (r) => r.mondayAbsences || "—" },
    dates<AfterOffRow>(),
  ] satisfies Column<AfterOffRow>[],
};

const PROVENANCE: Record<ExceptionKey, string[]> = {
  chronicAbsentees: ["exceptions-absence"],
  habitualLate: ["exceptions-late"],
  longAbsences: ["exceptions-absence"],
  missingPunches: ["exceptions-punches"],
  afterOffAbsences: ["exceptions-after-off"],
};

function Table({ tab, data }: { tab: ExceptionKey; data: AttendanceExceptions }) {
  const shown = data[tab].rows.length;
  const total = data[tab].total;
  if (total === 0) {
    return (
      <EmptyBlock title="Nobody here" testId={`md-attendance-exceptions-${tab}-empty`}>
        No one meets this rule in the period.
      </EmptyBlock>
    );
  }
  const common = { pageSize: 10, dense: true, testId: `md-attendance-exceptions-${tab}` } as const;
  const table = (() => {
    switch (tab) {
      case "chronicAbsentees":
        return (
          <DataTable
            columns={COLUMNS.chronicAbsentees}
            rows={data.chronicAbsentees.rows}
            rowKey={(r) => r.employeeId}
            {...common}
          />
        );
      case "habitualLate":
        return (
          <DataTable
            columns={COLUMNS.habitualLate}
            rows={data.habitualLate.rows}
            rowKey={(r) => r.employeeId}
            {...common}
          />
        );
      case "longAbsences":
        return (
          <DataTable
            columns={COLUMNS.longAbsences}
            rows={data.longAbsences.rows}
            rowKey={(r) => r.employeeId}
            {...common}
          />
        );
      case "missingPunches":
        return (
          <DataTable
            columns={COLUMNS.missingPunches}
            rows={data.missingPunches.rows}
            rowKey={(r) => r.employeeId}
            {...common}
          />
        );
      case "afterOffAbsences":
        return (
          <DataTable
            columns={COLUMNS.afterOffAbsences}
            rows={data.afterOffAbsences.rows}
            rowKey={(r) => r.employeeId}
            {...common}
          />
        );
    }
  })();
  return (
    <>
      {table}
      {total > shown && (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing the first {shown} of {total}: narrow the unit or department to see the rest.
        </p>
      )}
    </>
  );
}

/** The people behind the numbers: chronic absentees, late-comers, long absences, missing punches, patterns. */
export default function ExceptionsCard({
  query,
  context,
  className,
}: {
  query: UseQueryResult<AttendanceExceptions>;
  context: AskContext;
  className?: string;
}) {
  const [picked, setPicked] = useState<ExceptionKey | null>(null);
  const counts = exceptionCounts(query.data);
  const tab = picked ?? firstBusyTab(counts);
  return (
    <SectionCard
      testId="md-attendance-exceptions"
      className={className}
      title="Who needs a conversation"
      subtitle={ruleText(tab, query.data?.thresholds)}
      loading={query.isPending}
      provenance={query.data?.provenance}
      provenanceIds={PROVENANCE[tab]}
      actions={<AskAiButton question={ask.exceptions(context, tab)} />}
    >
      <TabStrip
        items={EXCEPTION_TABS.map((t) => ({ value: t.key, label: t.label, count: counts[t.key] }))}
        value={tab}
        onChange={(v) => setPicked(v as ExceptionKey)}
      />
      <CardBody query={query}>{(data) => <Table tab={tab} data={data} />}</CardBody>
    </SectionCard>
  );
}
