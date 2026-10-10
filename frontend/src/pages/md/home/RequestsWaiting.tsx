import { useEffect, useMemo } from "react";
import { Link } from "wouter";
import { ArrowUpRight, Clock, DoorOpen, Eye, Plane, Timer } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import {
  useListAdvances,
  useListLeaveRequests,
  useListOutpassRequests,
  useListPermissions,
  useListResignations,
  useOnDutyPunchVerificationsHR,
  useOnDutySessionsHR,
} from "@/lib/api-client";
import { permissionTypeLabel } from "@/lib/late-detection";
import { cn } from "@/lib/utils";
import {
  KIND_LABEL,
  summarisePending,
  waitingDays,
  waitingForText,
  waitingText,
  waitingTone,
  type PendingRequest,
  type RequestKind,
} from "./requests-logic";

const REFRESH = { refetchInterval: 30_000 } as never;

const KIND_ICON: Record<RequestKind, typeof Plane> = { leave: Plane, permission: Timer, outpass: DoorOpen };

/** How long a request has waited, as a chip: crimson when it is late, ochre when it is getting old, plain when it is fresh.
 *  The chip also says the time in words, so the colour is never the only thing telling it. */
const TONE_CLASS = {
  late: "md-chip-danger",
  watch: "md-chip-warning",
  fresh: "",
};

/**
 * "Requests waiting": the leave, permission and outpass requests that are still pending, oldest first, each with who it is
 * waiting for (the approval pipelines say so, as on the Requests page). The MD only looks at requests (the server refuses
 * the MD's approve / reject: permission_registry.MD_VIEW_ONLY), so there is no Approve or Reject here; the card leads to
 * the Requests page. Everything else that is waiting (advances, on-duty sessions, resignations) is counted with a way to
 * its page.
 */
export default function RequestsWaiting({ onTotal }: { onTotal?: (total: number) => void }) {
  const leaves = useListLeaveRequests(undefined, { query: { refetchInterval: 30_000 } } as never);
  const permissions = useListPermissions(undefined, REFRESH);
  const outpasses = useListOutpassRequests("pending");
  const advances = useListAdvances(undefined, REFRESH);
  const resignations = useListResignations(undefined, REFRESH);
  const onDutySessions = useOnDutySessionsHR("pending");
  const onDutyPunches = useOnDutyPunchVerificationsHR("pending");

  const pending = useMemo<PendingRequest[]>(() => {
    const rows: PendingRequest[] = [];
    for (const l of leaves.data ?? []) {
      if (l.status !== "pending") continue;
      const label = l.isHalfDay
        ? `Half Day Leave (${l.halfDaySlot === "afternoon" ? "Afternoon" : "Morning"})`
        : `${String(l.type).charAt(0).toUpperCase()}${String(l.type).slice(1)} Leave`;
      rows.push({
        kind: "leave",
        id: l.id,
        who: l.employeeName ?? `#${l.employeeId}`,
        what: label,
        detail: `${l.startDate} → ${l.endDate}${l.reason ? ` · ${l.reason}` : ""}`,
        createdAt: String(l.createdAt ?? ""),
        waitingFor: l.approval?.waitingFor ?? [],
      });
    }
    for (const p of permissions.data ?? []) {
      if (p.status !== "pending") continue;
      rows.push({
        kind: "permission",
        id: p.id,
        who: p.employeeName,
        what: `Permission · ${permissionTypeLabel(p) ?? "Type not set"}`,
        detail: `${p.date}${p.permissionTime ? ` at ${p.permissionTime}` : ""}${p.reason ? ` · ${p.reason}` : ""}`,
        createdAt: p.createdAt ?? "",
        waitingFor: p.approval?.waitingFor ?? [],
      });
    }
    for (const o of outpasses.data ?? []) {
      if (o.status !== "pending" || o.source !== "manual") continue;
      rows.push({
        kind: "outpass",
        id: o.id,
        who: o.employee?.name ?? `#${o.employeeId}`,
        what: "Outpass Request",
        detail: `${o.destination} · ${o.reason}`,
        createdAt: o.createdAt,
        waitingFor: o.approval?.waitingFor ?? [],
      });
    }
    return rows;
  }, [leaves.data, permissions.data, outpasses.data]);

  const now = new Date();
  const summary = summarisePending(pending, now, 6);
  const loading = leaves.isLoading || permissions.isLoading || outpasses.isLoading;
  useEffect(() => onTotal?.(summary.total), [summary.total, onTotal]);

  const alsoWaiting = [
    {
      id: "advances",
      label: "Advances",
      count: (advances.data ?? []).filter((a) => a.status === "pending").length,
      to: "/md/requests",
    },
    {
      id: "onduty",
      label: "On-duty (geo)",
      count: (onDutySessions.data ?? []).length + (onDutyPunches.data ?? []).length,
      to: "/md/geo-attendance",
    },
    {
      id: "resignations",
      label: "Resignations",
      count: (resignations.data ?? []).filter((r) => r.status === "pending" || r.status === "dept_approved").length,
      to: "/md/recruitment",
    },
  ].filter((x) => x.count > 0);

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2.5">
          <span className="md-dashboard-icon md-dashboard-icon-wine md-dashboard-icon-sm">
            <Eye size={15} aria-hidden />
          </span>
          Requests waiting
        </span>
      }
      subtitle="Oldest first. You can look at each one; HR and the Department Heads decide them."
      loading={loading}
      actions={<AskAiButton question="Which requests have been waiting longest, and who are they waiting for?" />}
      className="md-dashboard-card"
      testId="md-home-requests"
    >
      {summary.total === 0 ? (
        <p
          className="md-panel-wine flex items-center justify-center gap-2 px-4 py-8 text-center text-sm font-medium text-md-ink-soft"
          data-testid="md-home-requests-empty"
        >
          No leave, permission or outpass request is waiting.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-xs" data-testid="md-home-requests-summary">
            <b className="md-dashboard-figure text-4xl font-black leading-none text-md-wine">{summary.total}</b>
            <span className="font-semibold text-md-ink-soft">waiting</span>
            {(Object.keys(summary.counts) as RequestKind[])
              .filter((k) => summary.counts[k] > 0)
              .map((k) => (
                <span key={k} className="md-chip md-chip-wine">
                  {summary.counts[k]} {KIND_LABEL[k].toLowerCase()}
                </span>
              ))}
            {summary.oldestDays != null && summary.oldestDays > 0 && (
              <span className="ml-auto font-medium text-md-ink-soft">oldest {waitingText(summary.oldestDays)}</span>
            )}
          </div>

          <ul className="space-y-2.5" data-testid="md-home-requests-list">
            {summary.items.map((item) => {
              const key = `${item.kind}-${item.id}`;
              const Icon = KIND_ICON[item.kind];
              const days = waitingDays(item.createdAt, now);
              return (
                <li key={key} className="md-panel md-dashboard-row p-3.5" data-testid={`md-request-${key}`}>
                  <div className="flex items-start gap-3">
                    <span className="md-dashboard-icon md-dashboard-icon-sm md-dashboard-icon-sand">
                      <Icon size={15} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-md-ink">{item.who}</p>
                      <p className="text-xs font-medium text-md-ink">{item.what}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-md-ink-soft">{item.detail}</p>
                      <p
                        className="mt-1.5 text-[11px] font-bold text-md-wine"
                        data-testid={`md-request-${key}-waiting-for`}
                      >
                        {waitingForText(item.waitingFor)}
                      </p>
                    </div>
                    <span className={cn("md-chip shrink-0 tabular-nums", TONE_CLASS[waitingTone(days)])}>
                      <Clock size={11} aria-hidden /> {waitingText(days)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          {summary.total > summary.items.length && (
            <p className="text-center text-xs font-medium text-md-ink-soft">
              {summary.total - summary.items.length} more on the Requests page.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-md-line pt-4 text-xs">
        <Link href="/md/requests" className="md-btn md-btn-primary md-btn-sm" data-testid="md-home-open-requests">
          View all requests <ArrowUpRight size={13} aria-hidden />
        </Link>
        {alsoWaiting.map((x) => (
          <Link
            key={x.id}
            href={x.to}
            className="md-chip md-chip-sand md-dashboard-linkchip"
            data-testid={`md-also-${x.id}`}
          >
            {x.count} {x.label.toLowerCase()}
          </Link>
        ))}
      </div>
    </SectionCard>
  );
}
