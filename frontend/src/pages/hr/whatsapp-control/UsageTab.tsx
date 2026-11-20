import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import {
  BarChart3,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Coins,
  IndianRupee,
  Layers,
  Receipt,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChartContainer } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WHATSAPP_PRICING_CATEGORIES,
  useWhatsAppUsage,
  whatsAppErrorMessage,
  type WhatsAppPricingCategory,
  type WhatsAppUsage,
} from "@/lib/api-client/custom-hooks";
import { Empty, Kpi, Meter, Notice, Panel } from "./kit";
import {
  PRICING_COLOR,
  PRICING_HELP,
  PRICING_LABEL,
  budgetState,
  chartDays,
  formatCount,
  formatInr,
  formatPct,
  formatRate,
  monthLabel,
  monthOf,
  shiftMonth,
  type Tone,
} from "./logic";
import { categoryLabel, fmtDateTime } from "./shared";
import type { WaAccess, WaTab } from "./tabs";

type ChartRow = ReturnType<typeof chartDays>[number];

function DayTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartRow }[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="font-semibold">
        {new Date(`${d.date}T00:00:00`).toLocaleDateString("en-IN", {
          weekday: "short",
          day: "numeric",
          month: "short",
        })}
      </p>
      {WHATSAPP_PRICING_CATEGORIES.filter((c) => d.byCategory[c] > 0).map((c) => (
        <p key={c} className="mt-0.5 flex items-center gap-1.5">
          <i className="inline-block h-2 w-2 rounded-sm" style={{ background: PRICING_COLOR[c] }} />
          {PRICING_LABEL[c]}: <b className="tabular-nums">{d.byCategory[c]}</b>
        </p>
      ))}
      {d.total === 0 && <p className="mt-0.5 text-muted-foreground">No messages</p>}
      {d.failed > 0 && <p className="mt-0.5 text-red-600">{d.failed} failed</p>}
    </div>
  );
}

function DailyChart({ usage }: { usage: WhatsAppUsage }) {
  const rows = chartDays(usage.days, usage.month);
  const total = rows.reduce((n, r) => n + r.total, 0);
  return (
    <Panel
      title="Messages per day"
      description="Each bar is one day, split by what Meta charges the messages as."
      icon={BarChart3}
      testId="wa-usage-chart"
    >
      {total === 0 ? (
        <Empty testId="wa-usage-chart-empty">No message in {monthLabel(usage.month)}.</Empty>
      ) : (
        <ChartContainer
          config={Object.fromEntries(
            WHATSAPP_PRICING_CATEGORIES.map((c) => [c, { label: PRICING_LABEL[c], color: PRICING_COLOR[c] }]),
          )}
          className="aspect-auto h-60 w-full"
          role="img"
          aria-label={`${formatCount(total)} messages in ${monthLabel(usage.month)}, per day and pricing category`}
        >
          <BarChart data={rows} margin={{ top: 6, right: 4, left: -22, bottom: 0 }} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={10} />
            <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={40} />
            <Tooltip content={<DayTooltip />} cursor={{ fillOpacity: 0.08 }} />
            {WHATSAPP_PRICING_CATEGORIES.map((c, i) => (
              <Bar
                key={c}
                dataKey={`byCategory.${c}`}
                name={PRICING_LABEL[c]}
                stackId="day"
                fill={PRICING_COLOR[c]}
                radius={i === WHATSAPP_PRICING_CATEGORIES.length - 1 ? [3, 3, 0, 0] : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ChartContainer>
      )}
      <div
        className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground"
        data-testid="wa-usage-legend"
      >
        {WHATSAPP_PRICING_CATEGORIES.map((c) => (
          <span key={c} className="flex items-center gap-1.5" title={PRICING_HELP[c]}>
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: PRICING_COLOR[c] }} />
            {PRICING_LABEL[c]}
          </span>
        ))}
      </div>
      {/* the same numbers as a table, for a screen reader */}
      <table className="sr-only" data-testid="wa-usage-table">
        <caption>Messages per day in {monthLabel(usage.month)}</caption>
        <thead>
          <tr>
            <th>Day</th>
            {WHATSAPP_PRICING_CATEGORIES.map((c) => (
              <th key={c}>{PRICING_LABEL[c]}</th>
            ))}
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date}>
              <td>{r.date}</td>
              {WHATSAPP_PRICING_CATEGORIES.map((c) => (
                <td key={c}>{r.byCategory[c]}</td>
              ))}
              <td>{r.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function CategoryTable({ usage, access, go }: { usage: WhatsAppUsage; access: WaAccess; go: (tab: WaTab) => void }) {
  const total = WHATSAPP_PRICING_CATEGORIES.reduce(
    (t, c) => ({
      messages: t.messages + usage.byCategory[c].messages,
      billable: t.billable + usage.byCategory[c].billable,
      cost: t.cost + usage.byCategory[c].cost,
    }),
    { messages: 0, billable: 0, cost: 0 },
  );
  return (
    <Panel
      title="By pricing category"
      description="Meta charges each delivered message by its category. The rates are before 18% GST."
      icon={Layers}
      testId="wa-usage-categories"
      actions={
        access.canOpen("config") ? (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => go("config")}>
            Rates on Settings
          </Button>
        ) : undefined
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[13px]">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-2 font-semibold">Category</th>
              <th className="px-2 py-2 text-right font-semibold">Messages</th>
              <th className="px-2 py-2 text-right font-semibold">Billable</th>
              <th className="px-2 py-2 text-right font-semibold">Rate</th>
              <th className="py-2 pl-2 text-right font-semibold">Cost</th>
            </tr>
          </thead>
          <tbody>
            {WHATSAPP_PRICING_CATEGORIES.map((c: WhatsAppPricingCategory) => {
              const row = usage.byCategory[c];
              return (
                <tr key={c} className="border-b last:border-b-0" data-testid={`wa-usage-cat-${c}`}>
                  <td className="py-2 pr-2" title={PRICING_HELP[c]}>
                    <span className="flex items-center gap-2 font-medium">
                      <i
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ background: PRICING_COLOR[c] }}
                      />
                      {PRICING_LABEL[c]}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCount(row.messages)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCount(row.billable)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{formatRate(row.rate)}</td>
                  <td className="py-2 pl-2 text-right font-semibold tabular-nums">{formatInr(row.cost)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-semibold" data-testid="wa-usage-cat-total">
              <td className="py-2 pr-2">Total</td>
              <td className="px-2 py-2 text-right tabular-nums">{formatCount(total.messages)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{formatCount(total.billable)}</td>
              <td className="px-2 py-2" />
              <td className="py-2 pl-2 text-right tabular-nums">{formatInr(total.cost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

function MetaFigures({ usage }: { usage: WhatsAppUsage }) {
  const m = usage.meta;
  const diff = m.available && m.cost !== null ? m.cost - usage.cost.soFar : null;
  return (
    <Panel
      title="Meta's own figures"
      description="What Meta's pricing analytics report for the month, to check the estimate against."
      icon={Receipt}
      testId="wa-usage-meta"
    >
      {m.available ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-muted px-3 py-2.5">
              <p className="text-[11px] text-muted-foreground">Cost at Meta</p>
              <p className="text-lg font-bold tabular-nums" data-testid="wa-usage-meta-cost">
                {formatInr(m.cost)}
              </p>
            </div>
            <div className="rounded-xl bg-muted px-3 py-2.5">
              <p className="text-[11px] text-muted-foreground">Charged messages</p>
              <p className="text-lg font-bold tabular-nums">{formatCount(m.volume)}</p>
            </div>
          </div>
          {diff !== null && Math.abs(diff) >= 0.01 && (
            <p className="text-xs text-muted-foreground">
              Meta reports {formatInr(Math.abs(diff))} {diff > 0 ? "more" : "less"} than the estimate (Meta's figures
              lag by up to a day, and use its own exchange rate).
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">Read from Meta {fmtDateTime(m.lastSyncedAt)}.</p>
        </div>
      ) : (
        <Notice tone="neutral" testId="wa-usage-meta-unavailable">
          Meta figures unavailable{m.error ? `: ${m.error}` : "."} The estimate below uses the delivery receipts and the
          rates on Settings.
        </Notice>
      )}
    </Panel>
  );
}

function TypeTable({ usage }: { usage: WhatsAppUsage }) {
  const rows = [...usage.byType].sort((a, b) => b.cost - a.cost || b.messages - a.messages);
  const top = Math.max(1, ...rows.map((r) => r.messages));
  return (
    <Panel
      title="By message type"
      description="Which HRMS messages were sent this month, and what they cost."
      icon={Coins}
      testId="wa-usage-types"
    >
      {rows.length === 0 ? (
        <Empty testId="wa-usage-types-empty">No message this month.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-[13px]">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-2 font-semibold">Message type</th>
                <th className="px-2 py-2 font-semibold">Module</th>
                <th className="w-[30%] px-2 py-2 text-right font-semibold">Messages</th>
                <th className="py-2 pl-2 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.type} className="border-b last:border-b-0" data-testid={`wa-usage-type-${r.type}`}>
                  <td className="py-2 pr-2 font-medium">{r.label}</td>
                  <td className="px-2 py-2 text-muted-foreground">{categoryLabel(r.module)}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <span className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-muted sm:block">
                        <span
                          className="block h-full rounded-full bg-emerald-500"
                          style={{ width: `${(r.messages / top) * 100}%` }}
                        />
                      </span>
                      <span className="w-12 text-right tabular-nums">{formatCount(r.messages)}</span>
                    </div>
                  </td>
                  <td className="py-2 pl-2 text-right font-semibold tabular-nums">{formatInr(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function CostCards({ usage }: { usage: WhatsAppUsage }) {
  const c = usage.cost;
  const budget = budgetState(c.soFar, c.projected, c.budget);
  const tone: Tone = budget.level === "over" ? "bad" : budget.level === "near" ? "warn" : "good";
  const gstPct = Math.round(c.gstRate * 100);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="wa-usage-cost">
      <Kpi
        label={c.isCurrentMonth ? "Cost so far" : "Month's cost"}
        value={formatInr(c.soFar)}
        sub={`${formatInr(c.soFarWithGst)} with ${gstPct}% GST`}
        icon={IndianRupee}
        testId="wa-usage-so-far"
      />
      <Kpi
        label={c.isCurrentMonth ? "Projected month" : "Month total"}
        value={formatInr(c.projected)}
        sub={`${formatInr(c.projectedWithGst)} with ${gstPct}% GST`}
        tone={budget.projectedOver ? "warn" : "neutral"}
        icon={TrendingUp}
        testId="wa-usage-projected"
      />
      <Kpi
        label="Billable messages"
        value={formatCount(usage.totals.billable)}
        sub={`of ${formatCount(usage.totals.sent)} sent · ${formatCount(usage.totals.failed)} failed`}
        icon={Receipt}
        testId="wa-usage-billable"
      />
      <Kpi
        label="Budget"
        value={budget.level === "none" ? "Not set" : formatPct(budget.usedPct)}
        sub={budget.level === "none" ? "Set a monthly budget on Settings" : `of ${formatInr(c.budget)} used`}
        tone={budget.level === "none" ? "neutral" : tone}
        icon={Wallet}
        testId="wa-usage-budget"
      >
        {budget.level !== "none" && (
          <div className="mt-2.5">
            <Meter
              pct={budget.usedPct ?? 0}
              markPct={budget.projectedPct}
              tone={tone}
              label="Share of the budget spent"
            />
          </div>
        )}
      </Kpi>
    </div>
  );
}

/** Usage & Cost: one month at a time (this month by default): cost so far and where the month is heading, with and
 *  without GST; messages per day by pricing category; the category and message-type breakdowns; Meta's own figures. */
export default function UsageTab({
  access,
  go,
  now = new Date(),
}: {
  access: WaAccess;
  go: (tab: WaTab) => void;
  now?: Date;
}) {
  const current = monthOf(now);
  const [month, setMonth] = useState(current);
  const { data, isLoading, isFetching, error } = useWhatsAppUsage(month);

  return (
    <div className="space-y-4" data-testid="wa-usage">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-xl border bg-card p-1 shadow-sm" data-view-safe="">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="Previous month"
            data-testid="wa-usage-prev"
          >
            <ChevronLeft size={15} />
          </Button>
          <span
            className="flex min-w-36 items-center justify-center gap-1.5 px-2 text-sm font-semibold"
            data-testid="wa-usage-month"
          >
            <CalendarRange size={14} className="text-muted-foreground" /> {monthLabel(month)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            disabled={month >= current}
            aria-label="Next month"
            data-testid="wa-usage-next"
          >
            <ChevronRight size={15} />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {isFetching && !isLoading && <span>Loading…</span>}
          {month !== current && (
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setMonth(current)}>
              This month
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      ) : !data ? (
        <Notice tone="bad" role="alert" testId="wa-usage-error" title="Usage could not be loaded">
          {whatsAppErrorMessage(error, "Try Refresh in a moment.")}
        </Notice>
      ) : (
        <>
          <CostCards usage={data} />
          <DailyChart usage={data} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <CategoryTable usage={data} access={access} go={go} />
            <MetaFigures usage={data} />
          </div>
          <TypeTable usage={data} />
          <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="wa-usage-note">
            The estimate counts each delivered message Meta marks as charged (or, before its receipt arrives, each sent
            message that is not a free service reply) at the rate of its category:{" "}
            {WHATSAPP_PRICING_CATEGORIES.map((c) => `${PRICING_LABEL[c]} ${formatRate(data.rates[c])}`).join(", ")} per
            message, plus {Math.round(data.cost.gstRate * 100)}% GST. The projection is the cost so far divided by the
            days gone, times the days in the month.
          </p>
        </>
      )}
    </div>
  );
}
