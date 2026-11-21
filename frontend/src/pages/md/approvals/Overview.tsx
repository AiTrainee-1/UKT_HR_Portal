import { CheckCircle2, Hourglass, Inbox, Timer } from "lucide-react";
import BarList from "@/components/md/kit/BarList";
import { monthLabel } from "@/components/md/kit/MonthPicker";
import StatCard from "@/components/md/kit/StatCard";
import { SkeletonBlock } from "@/components/md/kit/states";
import { num } from "@/lib/md/format";
import type { ApprovalsOverview, KindFilter } from "./logic";
import { MonthColumns } from "./parts";
import type { Hod, RequestStatusFilter } from "./types";

const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** The overview in two sentences, so the MD reads the situation before the figures. */
export function overviewSentence(hod: Hod, o: ApprovalsOverview, month: string | null): string {
  const when = month ? `In ${monthLabel(month)}` : "Altogether";
  const first = hod.name.split(" ")[0];
  const decided =
    o.received === 0
      ? `${when}, no request reached ${first}.`
      : `${when}, ${plural(o.received, "request")} reached ${first}: ${num(o.approved)} approved, ${num(o.rejected)} rejected, ${num(o.open)} still open.`;
  const waiting =
    hod.pending.total === 0
      ? " Nothing waits at their step now."
      : ` ${plural(hod.pending.total, "request")} ${hod.pending.total === 1 ? "waits" : "wait"} at their step now${
          o.oldestWaitingDays != null
            ? `; the oldest has waited ${o.oldestWaitingDays === 0 ? "less than a day" : plural(o.oldestWaitingDays, "day")}`
            : ""
        }.`;
  return decided + waiting;
}

/**
 * What the Department Head's requests look like, before the list: waiting now, what came in and how it was decided in the
 * chosen month, by kind and over six months. Every figure narrows the list below when clicked (a status, a kind, a month).
 */
export default function Overview({
  hod,
  overview,
  month,
  loading,
  onStatus,
  onKind,
  onMonth,
}: {
  hod: Hod;
  overview: ApprovalsOverview | undefined;
  month: string | null;
  loading: boolean;
  onStatus: (status: RequestStatusFilter) => void;
  onKind: (kind: KindFilter) => void;
  onMonth: (month: string) => void;
}) {
  if (!overview) {
    return loading ? <SkeletonBlock rows={3} /> : null;
  }
  const o = overview;
  const when = month ? monthLabel(month) : "all months";
  return (
    <div className="space-y-4" data-testid="md-approvals-overview">
      <p className="text-[13px] leading-relaxed text-md-ink" data-testid="md-approvals-summary">
        {overviewSentence(hod, o, month)}
      </p>
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <StatCard
          label="Waiting now"
          value={num(hod.pending.total)}
          sub={
            o.oldestWaitingDays != null
              ? `Oldest waiting ${o.oldestWaitingDays === 0 ? "under a day" : plural(o.oldestWaitingDays, "day")}`
              : "At the Department Head's step"
          }
          icon={Hourglass}
          tone={hod.pending.total > 0 ? "amber" : "slate"}
          onClick={() => onStatus("pending")}
          testId="md-approvals-kpi-waiting"
        />
        <StatCard
          label={`Requests in ${when}`}
          value={num(o.received)}
          sub={`${num(o.approved)} approved · ${num(o.rejected)} rejected · ${num(o.open)} open`}
          icon={Inbox}
          tone="blue"
          onClick={() => onStatus("all")}
          testId="md-approvals-kpi-received"
        />
        <StatCard
          label="Approved"
          value={o.approvalRatePct == null ? "—" : `${o.approvalRatePct}%`}
          sub={o.approved + o.rejected ? `of ${plural(o.approved + o.rejected, "decision")}` : "Nothing decided yet"}
          icon={CheckCircle2}
          tone="green"
          onClick={() => onStatus("approved")}
          testId="md-approvals-kpi-rate"
        />
        <StatCard
          label="Days to decide"
          value={o.avgDecisionDays == null ? "—" : num(o.avgDecisionDays, o.avgDecisionDays % 1 ? 1 : 0)}
          sub="Average, from sending to the decision"
          icon={Timer}
          tone="indigo"
          testId="md-approvals-kpi-days"
        />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-2">
        <div className="rounded-2xl border border-white/80 bg-white/45 p-4">
          <p className="mb-3 text-[13px] font-extrabold text-md-ink">By type of request · {when}</p>
          <BarList
            items={o.byKind.map((k) => ({ key: k.kind, label: k.label, value: k.count }))}
            onSelect={(item) => onKind(item.key as KindFilter)}
            emptyText="No request in this month."
            testId="md-approvals-by-kind"
          />
        </div>
        <div className="rounded-2xl border border-white/80 bg-white/45 p-4">
          <p className="mb-3 text-[13px] font-extrabold text-md-ink">Six months</p>
          <MonthColumns
            months={o.months.map((m) => ({ month: m.month, label: m.label, a: m.received, b: m.decided }))}
            first="Requests"
            second="Decided"
            onPick={onMonth}
            active={month}
            testId="md-approvals-months"
          />
        </div>
      </div>
    </div>
  );
}
