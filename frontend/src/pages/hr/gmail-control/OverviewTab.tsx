import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, Eye, Mail, PauseCircle, Send, XCircle } from "lucide-react";
import {
  useGmailOverview,
  type GmailCategory,
  type GmailCounts,
  type GmailMessage,
} from "@/lib/api-client/custom-hooks";
import { CATEGORY_HELP, MessageDetailDialog, StatCard, StatusPill, fmtDateTime } from "./shared";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

function PeriodCard({ title, counts }: { title: string; counts: GmailCounts }) {
  const cells = [
    { label: "Total", value: counts.total, tone: "text-slate-800" },
    { label: "Sent", value: counts.sent, tone: "text-green-700" },
    { label: "Failed", value: counts.failed, tone: counts.failed ? "text-red-600" : "text-gray-400" },
    { label: "Not sent", value: counts.blocked, tone: counts.blocked ? "text-amber-600" : "text-gray-400" },
  ];
  const attempted = counts.sent + counts.failed;
  const rate = attempted ? Math.round((counts.sent / attempted) * 100) : 0;
  return (
    <div className="rounded-2xl border bg-white p-4" data-testid={`period-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-gray-800">{title}</p>
        <p className="text-[11px] text-gray-400">{attempted ? `${rate}% accepted by Gmail` : "nothing sent yet"}</p>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2 text-center">
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
  category: GmailCategory;
  label: string;
  counts: GmailCounts;
  onOpen: () => void;
}) {
  const attempted = counts.sent + counts.failed;
  const pct = attempted ? Math.round((counts.sent / attempted) * 100) : 0;
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
        {counts.sent} sent ·{" "}
        <span className={counts.failed ? "text-red-600 font-semibold" : ""}>{counts.failed} failed</span>
        {counts.blocked ? ` · ${counts.blocked} not sent` : ""}
      </p>
    </button>
  );
}

export default function OverviewTab({
  onOpenCategory,
  onOpenFailures,
  onOpenConfig,
}: {
  onOpenCategory: (category: GmailCategory) => void;
  onOpenFailures: () => void;
  onOpenConfig: () => void;
}) {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useGmailOverview(days);
  const [selected, setSelected] = useState<GmailMessage | null>(null);

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  const t = data.totals;
  const c = data.config;
  const maxDaily = Math.max(1, ...data.daily.map((d) => d.total));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-gray-500">
          Every email the HRMS sent in the last {days} days. "Sent" means Gmail accepted it — Gmail doesn't report
          delivery back. Refreshes every 30 seconds.
        </p>
        <PillTabs size="sm" items={RANGES} value={String(days)} onChange={(v) => setDays(Number(v))} />
      </div>

      {!c.configured && (
        <div
          className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800"
          data-testid="not-configured-banner"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {c.sendingBlockedReason ?? "Email isn't set up, so nothing can be sent."}{" "}
            <button className="underline font-semibold" onClick={onOpenConfig}>
              See what's missing
            </button>
          </span>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <PeriodCard title="Today" counts={data.today} />
        <PeriodCard title="This month" counts={data.thisMonth} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total" value={t.total} sub="emails" icon={Mail} color="bg-slate-100 text-slate-800" />
        <StatCard label="Sent" value={t.sent} sub="accepted by Gmail" icon={Send} color="bg-green-50 text-green-800" />
        <StatCard
          label="Failed"
          value={t.failed}
          sub="see reasons below"
          icon={XCircle}
          color="bg-red-50 text-red-800"
        />
        <StatCard
          label="Not sent"
          value={t.blocked}
          sub="held back by a switch"
          icon={PauseCircle}
          color="bg-amber-50 text-amber-800"
        />
      </div>

      <div className="rounded-2xl border bg-white p-4 text-xs text-gray-600" data-testid="daily-limit">
        <span className="font-semibold text-gray-800">Today's allowance: </span>
        {c.sentToday} sent
        {c.dailyLimit > 0 ? (
          <>
            {" "}
            of your limit of {c.dailyLimit} — {Math.max(0, c.dailyLimit - c.sentToday)} left. Anything over is held back
            as "Not sent".
          </>
        ) : (
          <>
            {" "}
            — no limit set. Gmail itself stops a regular account at about {c.gmailLimits.regular} emails a day (Google
            Workspace about {c.gmailLimits.workspace.toLocaleString("en-IN")}); set a limit under Feature Controls to
            stay clear of it.
          </>
        )}
      </div>

      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">By module</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {data.categories.map((cat) => (
            <CategoryCard
              key={cat.key}
              category={cat.key}
              label={cat.label}
              counts={data.byCategory[cat.key]}
              onOpen={() => onOpenCategory(cat.key)}
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
              <p className="text-xs text-gray-400 py-6 text-center">No emails in this period.</p>
            ) : (
              <div className="flex items-end gap-1 h-32" role="img" aria-label="Emails per day">
                {data.daily.map((d) => (
                  <div
                    key={d.date}
                    className="flex-1 min-w-[6px] h-full flex flex-col justify-end"
                    title={`${d.date}: ${d.total} emails, ${d.failed} failed`}
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
            <CardTitle className="text-sm font-bold">By email type</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byType.length === 0 ? (
              <p className="text-xs text-gray-400 py-6 text-center">Nothing sent yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-400">
                    <th className="font-semibold pb-1">Type</th>
                    <th className="font-semibold pb-1 text-right">Emails</th>
                    <th className="font-semibold pb-1 text-right">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byType.map((r) => (
                    <tr key={r.emailType} className="border-t">
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
              <CheckCircle2 size={14} className="text-emerald-500" /> No failed emails in this period.
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
                        {m.recipientName || m.recipientEmail || "Unknown recipient"} · {m.typeLabel}
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
