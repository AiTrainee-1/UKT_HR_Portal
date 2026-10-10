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

const TONE_CLASS = {
  late: "bg-red-100 text-red-800",
  watch: "bg-amber-100 text-amber-800",
  fresh: "bg-slate-100 text-slate-700",
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
        <span className="flex items-center gap-2">
          <Eye size={15} className="text-[#e0a83a]" aria-hidden /> Requests waiting
        </span>
      }
      subtitle="Oldest first. You can look at each one; HR and the Department Heads decide them."
      loading={loading}
      actions={<AskAiButton question="Which requests have been waiting longest, and who are they waiting for?" />}
      testId="md-home-requests"
    >
      {summary.total === 0 ? (
        <p
          className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
          data-testid="md-home-requests-empty"
        >
          No leave, permission or outpass request is waiting.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="md-home-requests-summary">
            <b className="text-2xl font-black text-[#1a3a4a]">{summary.total}</b>
            <span className="text-muted-foreground">waiting</span>
            {(Object.keys(summary.counts) as RequestKind[])
              .filter((k) => summary.counts[k] > 0)
              .map((k) => (
                <span key={k} className="rounded-full bg-[#006496]/[0.07] px-2 py-0.5 font-semibold text-[#006496]">
                  {summary.counts[k]} {KIND_LABEL[k].toLowerCase()}
                </span>
              ))}
            {summary.oldestDays != null && summary.oldestDays > 0 && (
              <span className="ml-auto text-muted-foreground">oldest {waitingText(summary.oldestDays)}</span>
            )}
          </div>

          <ul className="space-y-2" data-testid="md-home-requests-list">
            {summary.items.map((item) => {
              const key = `${item.kind}-${item.id}`;
              const Icon = KIND_ICON[item.kind];
              const days = waitingDays(item.createdAt, now);
              return (
                <li
                  key={key}
                  className="rounded-xl border border-[#006496]/10 bg-white/80 p-3"
                  data-testid={`md-request-${key}`}
                >
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 rounded-lg bg-[#006496]/[0.08] p-1.5 text-[#006496]">
                      <Icon size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-[#1a3a4a]">{item.who}</p>
                      <p className="text-xs text-[#006496]/80">{item.what}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.detail}</p>
                      <p
                        className="mt-1 text-[11px] font-semibold text-[#5b3d00]/80"
                        data-testid={`md-request-${key}-waiting-for`}
                      >
                        {waitingForText(item.waitingFor)}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold",
                        TONE_CLASS[waitingTone(days)],
                      )}
                    >
                      <Clock size={10} className="mr-0.5 inline" /> {waitingText(days)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          {summary.total > summary.items.length && (
            <p className="text-center text-xs text-muted-foreground">
              {summary.total - summary.items.length} more on the Requests page.
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#006496]/10 pt-3 text-xs">
        <Link
          href="/md/requests"
          className="inline-flex items-center gap-1 font-semibold text-[#006496] hover:underline"
          data-testid="md-home-open-requests"
        >
          View all requests <ArrowUpRight size={12} />
        </Link>
        {alsoWaiting.map((x) => (
          <Link
            key={x.id}
            href={x.to}
            className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-800 hover:bg-amber-100"
            data-testid={`md-also-${x.id}`}
          >
            {x.count} {x.label.toLowerCase()}
          </Link>
        ))}
      </div>
    </SectionCard>
  );
}
