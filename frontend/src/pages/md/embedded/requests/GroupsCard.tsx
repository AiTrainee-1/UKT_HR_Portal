import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import SegTabs from "../shared/SegTabs";
import { QueryError, refreshingClass } from "./cards";
import { hoursText } from "./logic";
import type { BreakdownBy, BreakdownRow, Drill, RqBreakdown } from "./types";

export const GROUP_TABS: { value: BreakdownBy; label: string }[] = [
  { value: "kind", label: "Kinds" },
  { value: "department", label: "Departments" },
  { value: "unit", label: "Units" },
  { value: "type", label: "Staff / production" },
];

/** The list filters that narrow a drill-down to one group of this card. */
export function groupParams(by: BreakdownBy, row: Pick<BreakdownRow, "key">): Record<string, string> {
  if (by === "kind") return { kind: row.key };
  if (by === "department") return { dept: row.key };
  if (by === "unit") return row.key === "__none__" ? {} : { branch: row.key };
  return row.key === "__none__" ? {} : { type: row.key };
}

function rowSub(r: BreakdownRow): string {
  const parts = [`${num(r.decided)} decided`];
  if (r.approvalPct != null) parts.push(`${pct(r.approvalPct)} approved`);
  if (r.medianHours != null) parts.push(`typical ${hoursText(r.medianHours)}`);
  if (r.waiting) parts.push(`${num(r.waiting)} waiting`);
  if (r.lowSample && r.decided) parts.push("small sample");
  return parts.join(" · ");
}

/** Requests compared across kinds, departments, units or staff / production: how many came in, how many were approved, how
 *  fast, and what still waits. A row opens the requests behind it. */
export default function GroupsCard({
  query,
  by,
  onBy,
  ask,
  onDrill,
}: {
  query: UseQueryResult<RqBreakdown>;
  by: BreakdownBy;
  onBy: (by: BreakdownBy) => void;
  ask: string;
  onDrill: (d: Drill) => void;
}) {
  const data = query.data;
  return (
    <SectionCard
      title="Where requests come from"
      subtitle="Requests submitted in the period, with the share approved, the typical time to decide and what still waits"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-requests-groups"
    >
      <SegTabs
        label="Group by"
        items={GROUP_TABS}
        value={by}
        onChange={(v) => onBy(v as BreakdownBy)}
        className="mb-4"
        testId="md-requests-group-tabs"
      />
      {query.isError ? (
        <QueryError query={query} />
      ) : data && data.rows.length > 0 ? (
        <BarList
          testId="md-requests-group-rows"
          items={data.rows.map((r) => ({
            key: r.key,
            label: r.label,
            value: r.submitted,
            sub: rowSub(r),
            display: `${num(r.submitted)}`,
          }))}
          format={(n) => num(n)}
          onSelect={(item) => {
            const row = data.rows.find((r) => r.key === item.key);
            if (!row) return;
            onDrill({
              title: `${row.label}: submitted`,
              subtitle: "Requests made in the period, newest first",
              params: { status: "submitted", ...groupParams(by, row) },
            });
          }}
        />
      ) : data ? (
        <EmptyBlock title="No requests in this period" testId="md-requests-groups-empty">
          Nothing was submitted, decided or left waiting for this selection.
        </EmptyBlock>
      ) : null}
      {data?.truncated && (
        <p className="md-analytics-note">
          The {num(data.rows.length)} largest of {num(data.total)} are shown.
        </p>
      )}
    </SectionCard>
  );
}
