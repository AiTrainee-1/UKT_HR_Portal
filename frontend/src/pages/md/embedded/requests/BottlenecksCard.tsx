import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { num } from "@/lib/md/format";
import { QueryError, refreshingClass } from "./cards";
import { hoursText } from "./logic";
import type { Drill, RqBottlenecks } from "./types";

/** Where requests get stuck: the departments whose requests wait longest (and how many only their Department Head can
 *  move), and the approvers ranked by how long they take. A department opens what waits there; an approver, what they
 *  decided in the period. */
export default function BottlenecksCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<RqBottlenecks>;
  ask: string;
  onDrill: (d: Drill) => void;
}) {
  const data = query.data;
  const departments = (data?.departments ?? []).filter((d) => d.waiting > 0);
  const approvers = data?.approvers ?? [];
  return (
    <SectionCard
      title="Where requests get stuck"
      subtitle="Departments with requests waiting, and how long each approver takes to decide"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-requests-bottlenecks"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && (departments.length > 0 || approvers.length > 0) ? (
        <div className="space-y-5">
          {departments.length > 0 && (
            <div>
              <h4 className="md-analytics-subhead">Departments with requests waiting</h4>
              <BarList
                testId="md-requests-departments"
                items={departments.slice(0, 8).map((d) => ({
                  key: d.key,
                  label: d.label,
                  value: d.waiting,
                  color: d.departmentHeadThreeDaysPlus > 0 ? CHART.bad : CHART.brand,
                  sub: [
                    `${num(d.threeDaysPlus)} waited ${data.agedDays}+ days`,
                    d.withDepartmentHead ? `${num(d.withDepartmentHead)} with the Department Head` : null,
                    d.medianHours != null ? `typical decision ${hoursText(d.medianHours)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }))}
                format={(n) => num(n)}
                onSelect={(item) =>
                  onDrill({
                    title: `${String(item.label)}: waiting`,
                    subtitle: "Oldest first, with who each one waits on",
                    params: { status: "waiting", dept: item.key },
                  })
                }
              />
            </div>
          )}
          {approvers.length > 0 && (
            <div>
              <h4 className="md-analytics-subhead">Approvers, slowest first</h4>
              <BarList
                testId="md-requests-approvers"
                items={approvers.slice(0, 8).map((a) => ({
                  key: a.approverName,
                  label: a.roleLabel ? `${a.approverName} (${a.roleLabel})` : a.approverName,
                  value: a.medianHours ?? 0,
                  display: hoursText(a.medianHours),
                  color: CHART.deep,
                  sub: `${num(a.decided)} decided · ${num(a.rejected)} rejected${a.lowSample ? " · small sample" : ""}`,
                }))}
                onSelect={(item) =>
                  onDrill({
                    title: `Decided by ${item.key}`,
                    subtitle: "What this approver decided in the period, newest first",
                    params: { status: "decided", approver: item.key },
                  })
                }
              />
            </div>
          )}
        </div>
      ) : data ? (
        <EmptyBlock title="Nothing is stuck" testId="md-requests-bottlenecks-empty">
          No requests are waiting and nobody decided any in this period for this selection.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
