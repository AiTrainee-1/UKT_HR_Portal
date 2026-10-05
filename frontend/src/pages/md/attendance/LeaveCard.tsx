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
  slate: "text-slate-600",
  amber: "font-bold text-amber-700",
  red: "font-bold text-red-700",
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
                <p className="text-3xl font-black text-[#1a3a4a]" data-testid="md-attendance-leave-total">
                  {d.totalDays == null ? "—" : `${num(d.totalDays, 1)} days`}
                </p>
                {change != null && change !== 0 && (
                  <DeltaChip text={`${signed(change, 1)} days`} tone="neutral" direction={change > 0 ? "up" : "down"} />
                )}
                <p className="text-xs text-[#006496]/65">
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
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                  Waiting for a decision
                </p>
                <ul className="divide-y text-sm" data-testid="md-attendance-leave-pending">
                  {d.pending.map((p) => (
                    <li key={p.kind} className="flex items-baseline justify-between gap-2 py-1.5">
                      <span className="text-[#1a3a4a]">{p.label}</span>
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
