import { useState } from "react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { Input } from "@/components/ui/input";
import { useMdQuery } from "@/lib/api-client/custom-hooks/md";
import { dayLong, num, pct } from "@/lib/md/format";
import { scopeParams, type ScopeChoice } from "@/lib/md/period";
import CardBody from "./CardBody";
import { ask, type AskContext } from "./logic";
import TabStrip from "./TabStrip";
import type { AttendanceDay, DayGroup } from "./types";

type Mode = "yesterday" | "today" | "date";

const MODES = [
  { value: "yesterday", label: "Yesterday" },
  { value: "today", label: "Today" },
  { value: "date", label: "Pick a day" },
];

const columns = (what: string): Column<DayGroup>[] => [
  {
    key: "name",
    header: what,
    cell: (r) => <span className="font-semibold text-md-ink">{r.name}</span>,
    sortValue: (r) => r.name,
  },
  { key: "present", header: "In", align: "right", sortValue: (r) => r.present, cell: (r) => num(r.present) },
  { key: "absent", header: "Absent", align: "right", sortValue: (r) => r.absent, cell: (r) => num(r.absent) },
  {
    key: "late",
    header: "Late",
    align: "right",
    sortValue: (r) => r.late,
    cell: (r) => (r.late == null ? "—" : num(r.late)),
  },
  { key: "leave", header: "Leave", align: "right", sortValue: (r) => r.leave, cell: (r) => num(r.leave) },
];

/** One day's snapshot ("how many were absent yesterday in Stitching?"): the scope above decides who is counted. */
export default function DayCard({
  scope,
  context,
  className,
}: {
  scope: ScopeChoice;
  context: AskContext;
  className?: string;
}) {
  const [mode, setMode] = useState<Mode>("yesterday");
  const [picked, setPicked] = useState("");
  const date = mode === "date" ? picked : mode;
  const query = useMdQuery<AttendanceDay>(
    "attendance/day",
    { ...scopeParams(scope), date, limit: 8 },
    { enabled: !!date },
  );
  const data = query.data;
  return (
    <SectionCard
      testId="md-attendance-day"
      className={className}
      title="One day"
      subtitle={
        data
          ? `${data.weekday} ${dayLong(data.date)}${data.provisional ? " · provisional, the day is running" : ""}`
          : "Who was in, absent or late"
      }
      loading={query.isPending && !!date}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask.day(context, data?.date ?? "yesterday")} />}
    >
      <TabStrip items={MODES} value={mode} onChange={(v) => setMode(v as Mode)} />
      {mode === "date" && (
        <Input
          type="date"
          value={picked}
          aria-label="Day to show"
          data-testid="md-attendance-day-input"
          className="md-field mb-3 h-9 w-[10.5rem] text-xs"
          onChange={(e) => setPicked(e.target.value)}
        />
      )}
      {!date && <p className="py-6 text-center text-sm text-muted-foreground">Pick a day to see who was in.</p>}
      {date && (
        <CardBody query={query}>
          {(d) =>
            !d.totals || d.isWorkingDay === false ? (
              <EmptyBlock title="Nobody was scheduled" testId="md-attendance-day-empty">
                {d.notes[0] ?? "That day was a weekly off or a holiday."}
              </EmptyBlock>
            ) : (
              <div className="space-y-3">
                <p className="text-[13px] leading-relaxed text-md-ink" data-testid="md-attendance-day-totals">
                  <b>{num(d.totals.present)}</b> of {num(d.totals.expected)} in ({pct(d.totals.attendancePct, 0)}) ·{" "}
                  <b>{num(d.totals.absent)}</b> {d.provisional ? "not in yet" : "absent"}
                  {d.totals.late != null ? ` · ${num(d.totals.late)} late` : ""}
                  {d.totals.leave ? ` · ${num(d.totals.leave)} on leave` : ""}
                  {d.totals.notRecorded ? ` · ${num(d.totals.notRecorded)} not recorded` : ""}
                </p>
                <DataTable
                  columns={columns("Unit")}
                  rows={d.byUnit}
                  rowKey={(r) => r.name}
                  dense
                  pageSize={6}
                  empty="No units."
                  testId="md-attendance-day-units"
                />
                <DataTable
                  columns={columns("Department")}
                  rows={d.byDepartment}
                  rowKey={(r) => r.name}
                  dense
                  pageSize={6}
                  empty="No departments."
                  testId="md-attendance-day-departments"
                />
              </div>
            )
          }
        </CardBody>
      )}
    </SectionCard>
  );
}
