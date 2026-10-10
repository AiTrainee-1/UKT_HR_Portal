import type { UseQueryResult } from "@tanstack/react-query";
import { CalendarCheck } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { DeltaChip } from "@/components/md/kit/StatCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, signed } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import CardBody from "./CardBody";
import { ask, waitText, waitTone, type AskContext } from "./logic";
import type { AttendanceLeave } from "./types";

const WAIT_STYLE = {
  slate: "text-md-ink-soft",
  amber: "font-bold text-md-warning",
  red: "font-bold text-md-danger",
} as const;

/** Leave taken by type, permissions, and the requests waiting for a decision (and for how long). */
export default function LeaveCard({
  query,
  context,
  className,
}: {
  query: UseQueryResult<AttendanceLeave>;
  context: AskContext;
  className?: string;
}) {
  return (
    <SectionCard
      testId="md-attendance-leave"
      className={className}
      title="Leave and approvals"
      subtitle="Approved leave in the period, and what is waiting for a decision right now"
      loading={query.isPending}
      provenance={query.data?.provenance}
      actions={<AskAiButton question={ask.leave(context)} />}
    >
      <CardBody query={query}>
        {(d) => {
          const change = d.delta?.abs;
          const permissions = d.permissions;
          return (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
                <p className="md-analytics-big" data-testid="md-attendance-leave-total">
                  {d.totalDays == null ? "—" : `${num(d.totalDays, 1)} days`}
                </p>
                {change != null && change !== 0 && (
                  <DeltaChip text={`${signed(change, 1)} days`} tone="neutral" direction={change > 0 ? "up" : "down"} />
                )}
                <p className="text-xs text-md-ink-soft">
                  {d.employeesOnLeave != null ? `${num(d.employeesOnLeave)} people on approved leave` : ""}
                  {permissions?.approved != null ? ` · ${num(permissions.approved)} permissions taken` : ""}
                </p>
              </div>
              {d.byType.length === 0 ? (
                <EmptyBlock
                  icon={CalendarCheck}
                  title="No approved leave"
                  className="py-4"
                  testId="md-attendance-leave-empty"
                >
                  No leave request approved for this period.
                </EmptyBlock>
              ) : (
                <BarList
                  items={d.byType.map((t) => ({
                    key: t.key,
                    label: t.name,
                    value: t.days,
                    display: `${num(t.days, 1)} days`,
                    sub: `${num(t.requests)} ${t.requests === 1 ? "request" : "requests"}${t.paid === false ? " · unpaid" : ""}`,
                  }))}
                  color={CHART.leave}
                />
              )}
              <div>
                <p className="md-analytics-subhead">Waiting for a decision</p>
                <ul className="divide-y divide-md-line text-sm" data-testid="md-attendance-leave-pending">
                  {d.pending.map((p) => (
                    <li key={p.kind} className="flex items-baseline justify-between gap-2 py-1.5">
                      <span className="text-md-ink">{p.label}</span>
                      <span className="shrink-0 tabular-nums">
                        <b>{num(p.count)}</b>
                        {p.count > 0 && (
                          <span className={cn("ml-2 text-[11px]", WAIT_STYLE[waitTone(p.oldestDays)])}>
                            oldest {waitText(p.oldestDays)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        }}
      </CardBody>
    </SectionCard>
  );
}
