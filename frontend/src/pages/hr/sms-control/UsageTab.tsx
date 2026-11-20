import { Bar, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis } from "recharts";
import { Link } from "wouter";
import {
  ArrowRight,
  Ban,
  BadgeCheck,
  BarChart3,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Layers,
  Send,
  XCircle,
} from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { Button } from "@/components/ui/button";
import { ChartContainer } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useSmsUsage, type SmsPurpose, type SmsUsage } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  PROVIDER_NAME,
  PURPOSES,
  PURPOSE_LABEL,
  budgetState,
  chartRows,
  formatNumber,
  formatPct,
  formatRupees,
  formatWhen,
  monthLabel,
  monthOptions,
  percent,
  pickMonth,
  shiftMonth,
  thisMonth,
  type ChartRow,
  type Tone,
} from "./logic";
import { smsPath } from "./routes";
import { LoadError, Meter, Notice, Panel, StatTile, VALUE_TINT } from "./ui";

// The month on screen lives in the address (?month=2026-10), so a link or a reload keeps it. This month is the default and is
// left out of the address.
const URL_DEFAULTS = { month: "" };

/** The colours of the chart's series (fixed hues; the words beside them say the same). */
const SERIES = {
  sent: { label: "Sent", color: "#0284c7" },
  failed: { label: "Failed", color: "#ef4444" },
  blocked: { label: "Blocked", color: "#f59e0b" },
  verified: { label: "Used to sign in", color: "#059669" },
} as const;

function MonthSwitcher({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const options = monthOptions();
  const oldest = options[options.length - 1];
  const current = thisMonth();
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="sms-month-switcher" data-view-safe>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-8 w-8"
        aria-label="Previous month"
        onClick={() => onChange(shiftMonth(month, -1))}
        disabled={month <= oldest}
        data-testid="sms-month-prev"
      >
        <ChevronLeft size={15} />
      </Button>
      <select
        value={month}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Month"
        data-testid="sms-month-select"
        className="h-8 rounded-md border border-input bg-card px-2 text-sm font-semibold text-foreground"
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {monthLabel(m)}
          </option>
        ))}
      </select>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-8 w-8"
        aria-label="Next month"
        onClick={() => onChange(shiftMonth(month, 1))}
        disabled={month >= current}
        data-testid="sms-month-next"
      >
        <ChevronRight size={15} />
      </Button>
      {month !== current && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          onClick={() => onChange(current)}
          data-testid="sms-month-current"
        >
          This month
        </Button>
      )}
    </div>
  );
}

function DayTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartRow }[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs text-card-foreground shadow-md">
      <p className="font-semibold">{d.label}</p>
      {(["sent", "failed", "blocked", "verified"] as const).map((key) => (
        <p key={key} className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
          <i className="inline-block h-2 w-2 rounded-sm" style={{ background: SERIES[key].color }} />
          <span className="font-semibold tabular-nums text-foreground">{d[key]}</span> {SERIES[key].label.toLowerCase()}
        </p>
      ))}
    </div>
  );
}

function DailyChart({ usage }: { usage: SmsUsage }) {
  const rows = chartRows(usage.month, usage.days);
  const any = rows.some((r) => r.total > 0 || r.verified > 0);
  return (
    <Panel
      title="Day by day"
      description={`SMS codes each day of ${monthLabel(usage.month)}: sent, failed and blocked stacked, and the line of codes that were used.`}
      icon={BarChart3}
      testId="sms-usage-chart"
    >
      {!any ? (
        <p className="py-10 text-center text-sm text-muted-foreground" data-testid="sms-usage-chart-empty">
          No SMS in {monthLabel(usage.month)}.
        </p>
      ) : (
        <div role="img" aria-label={`SMS per day in ${monthLabel(usage.month)}`}>
          <ChartContainer
            config={Object.fromEntries(Object.entries(SERIES).map(([k, v]) => [k, { label: v.label, color: v.color }]))}
            className="aspect-auto h-60 w-full"
          >
            <ComposedChart data={rows} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="day" tickLine={false} interval="preserveStartEnd" minTickGap={10} />
              <YAxis allowDecimals={false} tickLine={false} width={44} />
              <Tooltip content={<DayTooltip />} cursor={{ fillOpacity: 0.06 }} />
              <Bar dataKey="sent" stackId="sms" fill={SERIES.sent.color} isAnimationActive={false} name="Sent" />
              <Bar dataKey="failed" stackId="sms" fill={SERIES.failed.color} isAnimationActive={false} name="Failed" />
              <Bar
                dataKey="blocked"
                stackId="sms"
                fill={SERIES.blocked.color}
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
                name="Blocked"
              />
              <Line
                dataKey="verified"
                type="monotone"
                stroke={SERIES.verified.color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                name="Used to sign in"
              />
            </ComposedChart>
          </ChartContainer>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {Object.values(SERIES).map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <i className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
      {/* the same numbers as a table, for a screen reader (and for the tests: the chart draws nothing without a size) */}
      <table className="sr-only" data-testid="sms-usage-table">
        <caption>SMS per day, {monthLabel(usage.month)}</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Sent</th>
            <th>Failed</th>
            <th>Blocked</th>
            <th>Used</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date} data-date={r.date}>
              <td>{r.label}</td>
              <td>{r.sent}</td>
              <td>{r.failed}</td>
              <td>{r.blocked}</td>
              <td>{r.verified}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function PurposeTable({ usage }: { usage: SmsUsage }) {
  const price = usage.cost.perSms;
  const purposes = PURPOSES.filter((p) => p !== "test" || usage.byPurpose.test.sent + usage.byPurpose.test.failed > 0);
  return (
    <Panel
      title="By purpose"
      description="What the codes were for. A test is sent from the Test tab and opens nothing."
      icon={Layers}
      testId="sms-by-purpose"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th scope="col" className="py-2 pr-3 font-semibold">
                Purpose
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Sent
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Failed
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Blocked
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Used
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Used rate
              </th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">
                Estimated cost
              </th>
            </tr>
          </thead>
          <tbody>
            {purposes.map((p: SmsPurpose) => {
              const c = usage.byPurpose[p];
              return (
                <tr key={p} className="border-b last:border-b-0" data-testid={`sms-purpose-${p}`}>
                  <th scope="row" className="py-2.5 pr-3 text-left font-semibold">
                    {PURPOSE_LABEL[p]}
                  </th>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(c.sent)}</td>
                  <td
                    className={cn(
                      "px-3 py-2.5 text-right tabular-nums",
                      c.failed ? "text-red-700 dark:text-red-400" : "text-muted-foreground",
                    )}
                  >
                    {formatNumber(c.failed)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2.5 text-right tabular-nums",
                      c.blocked ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
                    )}
                  >
                    {formatNumber(c.blocked)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {p === "test" ? "—" : formatNumber(c.verified)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    {p === "test" ? "—" : formatPct(percent(c.verified, c.sent))}
                  </td>
                  <td className="py-2.5 pl-3 text-right tabular-nums">
                    {price === null ? "—" : formatRupees(c.sent * price)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CostPanel({ usage }: { usage: SmsUsage }) {
  const c = usage.cost;
  const b = budgetState(c);
  const current = c.isCurrentMonth;
  const tone: Tone = b.level === "over" ? "bad" : b.level === "near" || b.projectedOver ? "warn" : "good";
  return (
    <Panel
      title="Cost"
      description={
        current
          ? "An estimate from the SMS sent and the price per SMS, and where the month ends at this pace."
          : "An estimate from the SMS sent in the month and the price per SMS."
      }
      icon={CircleDollarSign}
      testId="sms-usage-cost"
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {current ? "So far" : "Month total"}
          </dt>
          <dd className="text-2xl font-black tabular-nums" data-testid="sms-usage-so-far">
            {formatRupees(c.soFar)}
          </dd>
        </div>
        {current && (
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Projected for the month
            </dt>
            <dd className="text-2xl font-black tabular-nums text-muted-foreground" data-testid="sms-usage-projected">
              {formatRupees(c.projected)}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Price per SMS</dt>
          <dd className="font-semibold tabular-nums" data-testid="sms-usage-price">
            {formatRupees(c.perSms, true)}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Monthly budget</dt>
          <dd className="font-semibold tabular-nums" data-testid="sms-usage-budget">
            {c.budget === null ? "None" : formatRupees(c.budget)}
          </dd>
        </div>
      </dl>
      {b.barPct !== null && (
        <div className="mt-3" data-testid="sms-usage-budget-meter" data-level={b.level}>
          <Meter
            pct={b.barPct}
            tone={tone}
            label="Share of the monthly budget used"
            marker={current && c.projected !== null && c.budget ? (c.projected / c.budget) * 100 : null}
          />
          <p className={cn("mt-1.5 text-xs font-medium", VALUE_TINT[tone])}>
            {formatPct(b.usedPct)} of the budget used.
            {b.level === "over"
              ? " The budget is passed."
              : current && b.projectedOver
                ? ` At this pace the month ends ${formatRupees(b.overBy)} over it.`
                : ""}
          </p>
        </div>
      )}
      <p className="mt-3 text-xs leading-snug text-muted-foreground">
        Only SMS {PROVIDER_NAME} accepted are counted; failed and blocked ones cost nothing. Your {PROVIDER_NAME}{" "}
        invoice is the final word. Change the price or the budget in{" "}
        <Link href={smsPath("settings", "cost")} className="font-semibold underline underline-offset-2">
          Settings &gt; Cost
        </Link>
        .
      </p>
    </Panel>
  );
}

/**
 * Usage & Cost: one month at a time (this month by default): its totals and rates, the day-by-day chart, the codes by purpose
 * and their estimated cost, the cost so far against the budget and, for the current month, where it ends at this pace.
 */
export default function UsageTab() {
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const month = pickMonth(url.month);
  const { data, isLoading, isError, isFetching, refetch } = useSmsUsage(month === thisMonth() ? "" : month);
  const setMonth = (next: string) => setUrl({ month: next === thisMonth() ? "" : next });

  // the answer on screen may still be the month before while the next one loads
  const usage = data;
  const t = usage?.totals;

  return (
    <div className="space-y-4" data-testid="sms-usage">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          <CalendarRange size={16} className="text-muted-foreground" /> {monthLabel(month)}
          {isFetching && !isLoading && (
            <span className="text-[11px] font-normal text-muted-foreground" data-testid="sms-usage-refreshing">
              Updating…
            </span>
          )}
        </h3>
        <MonthSwitcher month={month} onChange={setMonth} />
      </div>

      {isLoading ? (
        <div className="space-y-4" data-testid="sms-usage-loading">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-72 w-full rounded-2xl" />
        </div>
      ) : isError || !usage || !t ? (
        <LoadError what="The SMS usage" onRetry={() => void refetch()} testId="sms-usage-error" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="sms-usage-totals">
            <StatTile
              testId="sms-usage-sent"
              label="Sent"
              icon={Send}
              tone="info"
              value={formatNumber(t.sent)}
              sub={`Delivery rate ${formatPct(t.deliveryRate)}`}
            />
            <StatTile
              testId="sms-usage-failed"
              label="Failed"
              icon={XCircle}
              tone={t.failed ? "bad" : "neutral"}
              value={formatNumber(t.failed)}
              sub={`${PROVIDER_NAME} did not accept them`}
            />
            <StatTile
              testId="sms-usage-blocked"
              label="Blocked"
              icon={Ban}
              tone={t.blocked ? "warn" : "neutral"}
              value={formatNumber(t.blocked)}
              sub="Stopped before sending"
            />
            <StatTile
              testId="sms-usage-verified"
              label="Used to sign in"
              icon={BadgeCheck}
              tone="good"
              value={formatNumber(t.verified)}
              sub={`Used rate ${formatPct(t.verifiedRate)}`}
            />
          </div>

          <DailyChart usage={usage} />

          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <PurposeTable usage={usage} />
            <CostPanel usage={usage} />
          </div>

          {(usage.balance.credits !== null || usage.balance.error) && (
            <Notice tone={usage.balance.credits === null ? "neutral" : "info"} testId="sms-usage-balance">
              {usage.balance.credits !== null ? (
                <>
                  <b>{formatNumber(usage.balance.credits)}</b> SMS credits left on the {PROVIDER_NAME} account
                  {usage.balance.checkedAt ? ` (checked ${formatWhen(usage.balance.checkedAt)})` : ""}.
                </>
              ) : (
                <>
                  {PROVIDER_NAME} balance unknown: {usage.balance.error}
                </>
              )}
            </Notice>
          )}
          <p className="text-xs text-muted-foreground">
            Every SMS is in the{" "}
            <Link href={smsPath("messages")} className="inline-flex items-center gap-0.5 font-semibold underline">
              Messages <ArrowRight size={11} />
            </Link>{" "}
            list, with its outcome.
          </p>
        </>
      )}
    </div>
  );
}
