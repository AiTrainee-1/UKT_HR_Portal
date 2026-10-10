import { useMemo } from "react";
import { Award, BarChart3, Building2, History, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "../career/common";
import { formatDate } from "../career/dates";
import { EmptyState, ErrorState, ListSkeleton } from "../career/parts";
import { amountOf, departmentBreakdown, monthlyTrend, topIncrements, type IncrementRecord } from "./logic";

type Props = {
  records: IncrementRecord[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  today: string;
};

function Panel({
  icon: Icon,
  title,
  tone,
  children,
  testId,
}: {
  icon: typeof Award;
  title: string;
  tone: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card className="rounded-2xl" data-testid={testId}>
      <CardContent className="space-y-3 p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-gray-800">
          <Icon size={14} className={tone} /> {title}
        </p>
        {children}
      </CardContent>
    </Card>
  );
}

/** The company-wide picture: where increments went, the biggest ones, the last twelve months and the latest ten. */
export default function InsightsTab({ records, loading, failed, onRetry, today }: Props) {
  const departments = useMemo(() => departmentBreakdown(records), [records]);
  const top = useMemo(() => topIncrements(records, 5), [records]);
  const trend = useMemo(() => monthlyTrend(records, today, 12), [records, today]);
  const recent = records.slice(0, 10);
  const peak = Math.max(1, ...trend.map((b) => b.count));
  const topAmount = Math.max(1, ...departments.map((d) => d.totalAmount));

  if (loading) {
    return (
      <Card className="mt-3 rounded-2xl">
        <ListSkeleton />
      </Card>
    );
  }
  if (failed) {
    return (
      <Card className="mt-3 rounded-2xl">
        <ErrorState what="the increment figures" onRetry={onRetry} testId="insights-error" />
      </Card>
    );
  }
  if (records.length === 0) {
    return (
      <Card className="mt-3 rounded-2xl">
        <EmptyState
          testId="insights-empty"
          icon={BarChart3}
          tone="bg-green-50 text-green-600"
          title="Nothing to show yet"
          text="Once increments have been applied, this page shows where they went and how big they were."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4 pt-3" data-testid="insights">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel icon={Building2} title="Department-wise increments" tone="text-indigo-500" testId="insights-departments">
          <div className="space-y-2">
            {departments.map((d) => (
              <div key={d.department} className="rounded-xl border p-2.5">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-gray-800">{d.department}</p>
                    <p className="text-[11px] text-gray-400">
                      {d.employeeCount} employee{d.employeeCount !== 1 ? "s" : ""} · {d.incrementCount} increment
                      {d.incrementCount !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-black text-indigo-700">{d.avgPercent}% avg</p>
                    <p className="text-[11px] font-semibold text-green-600">+{formatMoney(d.totalAmount)}</p>
                  </div>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-indigo-50" aria-hidden>
                  <div
                    className="h-full rounded-full bg-indigo-400"
                    style={{ width: `${Math.max(3, (d.totalAmount / topAmount) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel icon={Award} title="Top increments" tone="text-amber-500" testId="insights-top">
          <div className="space-y-2">
            {top.map((h) => (
              <div key={h.id} className="flex items-center gap-3 rounded-xl border p-2.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-50">
                  <TrendingUp size={13} className="text-amber-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-gray-800">{h.employeeName}</p>
                  <p className="font-mono text-[11px] text-gray-400">{h.employeeCode}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-black text-green-600">+{h.percent}%</p>
                  <p className="text-[10px] text-gray-400">{formatDate(h.effectiveDate)}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel icon={BarChart3} title="Increments by month, last 12 months" tone="text-blue-500" testId="insights-trend">
        <div
          className="flex h-36 items-end gap-1.5"
          role="img"
          aria-label="Number of increments in each of the last twelve months"
        >
          {trend.map((b) => (
            <div
              key={b.key}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
              title={`${b.label}: ${b.count} increment${b.count === 1 ? "" : "s"}, +${formatMoney(b.amount)}`}
            >
              <span className="text-[10px] font-semibold text-gray-500">{b.count || ""}</span>
              <div
                className={b.count ? "w-full rounded-t-md bg-blue-400" : "w-full rounded-t-md bg-gray-100"}
                style={{ height: `${b.count ? Math.max(6, (b.count / peak) * 100) : 3}%` }}
              />
              <span className="w-full truncate text-center text-[9px] text-gray-400">{b.label.slice(0, 3)}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel icon={History} title="Latest increments across the company" tone="text-gray-400" testId="insights-recent">
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {recent.map((h) => (
            <div key={h.id} className="flex items-center gap-3 rounded-xl border p-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-gray-800">
                  {h.employeeName}{" "}
                  <span className="font-mono text-xs font-normal text-gray-400">({h.employeeCode})</span>
                </p>
                <p className="text-[11px] text-gray-400">
                  {formatMoney(h.previousSalary)} → {formatMoney(h.newSalary)} (+{formatMoney(amountOf(h))})
                  {h.notes ? ` · ${h.notes}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-black text-green-600">+{h.percent}%</p>
                <p className="text-[10px] text-gray-400">{formatDate(h.effectiveDate)}</p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
