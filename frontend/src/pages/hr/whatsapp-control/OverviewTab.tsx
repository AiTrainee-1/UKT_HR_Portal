import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCheck, CheckCircle2, Clock, Eye, MessageCircle, Send, XCircle } from "lucide-react";
import {
  useWhatsAppOverview,
  type WhatsAppCategory,
  type WhatsAppCounts,
  type WhatsAppMessage,
} from "@/lib/api-client/custom-hooks";
import { CATEGORY_HELP, MessageDetailDialog, StatCard, StatusPill, fmtDateTime } from "./shared";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

function PeriodCard({ title, counts }: { title: string; counts: WhatsAppCounts }) {
  const reached = counts.delivered + counts.read;
  const rate = counts.total ? Math.round((reached / counts.total) * 100) : 0;
  const cells = [
    { label: "Total", value: counts.total, tone: "text-slate-800" },
    { label: "Sent", value: counts.sent, tone: "text-blue-700" },
    { label: "Delivered", value: reached, tone: "text-green-700" },
    { label: "Failed", value: counts.failed, tone: counts.failed ? "text-red-600" : "text-gray-400" },
    { label: "Pending", value: counts.pending, tone: counts.pending ? "text-amber-600" : "text-gray-400" },
  ];
  return (
    <div className="rounded-2xl border bg-white p-4" data-testid={`period-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-gray-800">{title}</p>
        <p className="text-[11px] text-gray-400">{counts.total ? `${rate}% delivered` : "nothing sent yet"}</p>
      </div>
      <div className="mt-2 grid grid-cols-5 gap-2 text-center">
        {cells.map((c) => (
          <div key={c.label}>
            <p className={`text-xl font-black tabular-nums ${c.tone}`}>{c.value}</p>
            <p className="text-[10px] text-gray-500">{c.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryCard({
  category,
  label,
  counts,
  onOpen,
}: {
  category: WhatsAppCategory;
  label: string;
  counts: WhatsAppCounts;
  onOpen: () => void;
}) {
  const ok = counts.accepted;
  const pct = counts.total ? Math.round((ok / counts.total) * 100) : 0;
  return (
    <button onClick={onOpen} className="text-left rounded-2xl border bg-white p-4 hover:shadow-md transition-shadow">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-gray-800">{label}</p>
        <p className="text-2xl font-black tabular-nums">{counts.total}</p>
      </div>
      <p className="text-[11px] text-gray-400 mt-0.5 min-h-[28px]">{CATEGORY_HELP[category] ?? ""}</p>
      <div className="mt-2 h-1.5 rounded-full bg-red-100 overflow-hidden" title={`${pct}% accepted`}>
        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-[11px] text-gray-500">
        {counts.delivered + counts.read} delivered · {counts.sent} sent ·{" "}
        <span className={counts.failed ? "text-red-600 font-semibold" : ""}>{counts.failed} failed</span>
        {counts.pending ? ` · ${counts.pending} pending` : ""}
      </p>
    </button>
  );
}

export default function OverviewTab({
  onOpenCategory,
  onOpenFailures,
  onOpenConfig,
}: {
  onOpenCategory: (category: WhatsAppCategory) => void;
  onOpenFailures: () => void;
  onOpenConfig: () => void;
}) {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useWhatsAppOverview(days);
  const [selected, setSelected] = useState<WhatsAppMessage | null>(null);

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  const t = data.totals;
  const maxDaily = Math.max(1, ...data.daily.map((d) => d.total));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-gray-500">
          Everything sent through the HRMS in the last {days} days. Refreshes every 30 seconds.
        </p>
        <PillTabs size="sm" items={RANGES} value={String(days)} onChange={(v) => setDays(Number(v))} />
      </div>

      {!data.config.configured && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            WhatsApp isn't configured on this server, so nothing can be sent.{" "}
            <button className="underline font-semibold" onClick={onOpenConfig}>
              See what's missing
            </button>
          </span>
        </div>
      )}
      {data.stalePending > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <Clock size={14} className="mt-0.5 shrink-0" />
          <span>
            {data.stalePending} message{data.stalePending === 1 ? "" : "s"} have been Pending for over 10 minutes. That
            usually means the server restarted mid-send; they can be safely ignored.
          </span>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <PeriodCard title="Today" counts={data.today} />
        <PeriodCard title="This month" counts={data.thisMonth} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <StatCard
          label="Total"
          value={t.total}
          sub="messages"
          icon={MessageCircle}
          color="bg-slate-100 text-slate-800"
        />
        <StatCard
          label="Sent"
          value={t.sent}
          sub="accepted, not yet confirmed"
          icon={Send}
          color="bg-blue-50 text-blue-800"
        />
        <StatCard
          label="Delivered"
          value={t.delivered}
          sub="reached the phone"
          icon={CheckCircle2}
          color="bg-green-50 text-green-800"
        />
        <StatCard label="Read" value={t.read} sub="opened" icon={CheckCheck} color="bg-purple-50 text-purple-800" />
        <StatCard label="Pending" value={t.pending} sub="in flight" icon={Clock} color="bg-amber-50 text-amber-800" />
        <StatCard
          label="Failed"
          value={t.failed}
          sub="see reasons below"
          icon={XCircle}
          color="bg-red-50 text-red-800"
        />
      </div>

      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">By module</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {data.categories.map((c) => (
            <CategoryCard
              key={c.key}
              category={c.key}
              label={c.label}
              counts={data.byCategory[c.key]}
              onOpen={() => onOpenCategory(c.key)}
            />
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {data.daily.length === 0 ? (
              <p className="text-xs text-gray-400 py-6 text-center">No messages in this period.</p>
            ) : (
              <div className="flex items-end gap-1 h-32" role="img" aria-label="Messages per day">
                {data.daily.map((d) => (
                  <div
                    key={d.date}
                    className="flex-1 min-w-[6px] flex flex-col justify-end"
                    title={`${d.date}: ${d.total} sent, ${d.failed} failed`}
                  >
                    <div className="bg-red-400 rounded-t-sm" style={{ height: `${(d.failed / maxDaily) * 100}%` }} />
                    <div
                      className="bg-emerald-500"
                      style={{
                        height: `${((d.total - d.failed) / maxDaily) * 100}%`,
                        minHeight: d.total - d.failed ? 2 : 0,
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between text-[10px] text-gray-400 mt-1.5">
              <span>{data.daily[0]?.date}</span>
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <i className="inline-block w-2 h-2 rounded-sm bg-emerald-500" /> OK
                </span>
                <span className="flex items-center gap-1">
                  <i className="inline-block w-2 h-2 rounded-sm bg-red-400" /> Failed
                </span>
              </span>
              <span>{data.daily[data.daily.length - 1]?.date}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">By message type</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byType.length === 0 ? (
              <p className="text-xs text-gray-400 py-6 text-center">Nothing sent yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-400">
                    <th className="font-semibold pb-1">Type</th>
                    <th className="font-semibold pb-1 text-right">Sent</th>
                    <th className="font-semibold pb-1 text-right">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byType.map((r) => (
                    <tr key={r.documentType} className="border-t">
                      <td className="py-1.5">{r.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{r.total}</td>
                      <td
                        className={`py-1.5 text-right tabular-nums ${r.failed ? "text-red-600 font-semibold" : "text-gray-400"}`}
                      >
                        {r.failed}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-bold">Recent failures</CardTitle>
          {data.recentFailures.length > 0 && (
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={onOpenFailures}>
              View all failures
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {data.recentFailures.length === 0 ? (
            <p className="text-xs text-gray-400 py-4 text-center flex items-center justify-center gap-1.5">
              <CheckCircle2 size={14} className="text-emerald-500" /> No failed messages in this period.
            </p>
          ) : (
            <ul className="divide-y">
              {data.recentFailures.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => setSelected(m)}
                    className="w-full text-left py-2 flex items-start gap-3 hover:bg-slate-50 rounded-lg px-2"
                  >
                    <StatusPill status={m.status} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-gray-800">
                        {m.employeeName} · {m.typeLabel}
                      </p>
                      <p className="text-[11px] text-red-700 truncate">{m.error || "No reason recorded"}</p>
                    </div>
                    <span className="text-[10px] text-gray-400 shrink-0">{fmtDateTime(m.createdAt)}</span>
                    <Eye size={12} className="text-gray-300 mt-0.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <MessageDetailDialog message={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
