import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import SegTabs from "../shared/SegTabs";
import { QueryError, refreshingClass } from "./cards";
import { GROUP_TABS, daysText, groupParams } from "./logic";
import type { Drill, GroupBy, LvGroupRow, LvGroups } from "./types";

function rowSub(by: GroupBy, r: LvGroupRow): string {
  const parts: string[] = [];
  if (r.sharePct != null) parts.push(`${pct(r.sharePct)} of the days`);
  parts.push(`${num(r.employeesOnLeave)} ${r.employeesOnLeave === 1 ? "person" : "people"}`);
  if ((by === "department" || by === "unit") && r.daysPerEmployee != null) {
    parts.push(
      `${num(r.daysPerEmployee, 2)} a head${r.vsCompany != null ? ` (${num(r.vsCompany, 2)}x the company)` : ""}`,
    );
  }
  if (r.previousDays) parts.push(`${daysText(r.previousDays)} before`);
  if (r.lowSample) parts.push("small group");
  return parts.join(" · ");
}

/** Where leave goes: by leave type, the reason employees pick, department or unit (departments and units ranked per head,
 *  so a big department does not win by size). A row opens the leave behind it. */
export default function GroupsCard({
  query,
  by,
  onBy,
  ask,
  onDrill,
}: {
  query: UseQueryResult<LvGroups>;
  by: GroupBy;
  onBy: (by: GroupBy) => void;
  ask: string;
  onDrill: (d: Drill) => void;
}) {
  const data = query.data;
  const rows = (data?.rows ?? []).filter((r) => r.leaveDays > 0 || r.previousDays > 0);
  return (
    <SectionCard
      title="Where leave goes"
      subtitle="Approved leave days of the period, with the period before"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-leave-groups"
    >
      <SegTabs
        label="Group by"
        items={GROUP_TABS}
        value={by}
        onChange={(v) => onBy(v as GroupBy)}
        className="mb-4"
        testId="md-leave-group-tabs"
      />
      {query.isError ? (
        <QueryError query={query} />
      ) : rows.length > 0 ? (
        <BarList
          testId="md-leave-group-rows"
          items={rows.map((r) => ({
            key: r.key,
            label: r.label,
            value: r.leaveDays,
            display: daysText(r.leaveDays),
            color: by === "reason" ? CHART.leave : CHART.brand,
            sub: rowSub(by, r),
          }))}
          onSelect={(item) => {
            const row = rows.find((r) => r.key === item.key);
            if (!row) return;
            onDrill({
              title: `Leave: ${row.label}`,
              subtitle: "Who took it, with the dates",
              params: { what: "days", ...groupParams(by, row) },
            });
          }}
        />
      ) : data ? (
        <EmptyBlock title="No leave in this period" testId="md-leave-groups-empty">
          No approved leave falls in this period for this selection.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
