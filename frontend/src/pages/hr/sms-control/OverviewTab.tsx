import type { ComponentType, ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  Ban,
  BadgeCheck,
  Check,
  CircleDollarSign,
  Gauge,
  KeyRound,
  ListChecks,
  MessageSquareText,
  Minus,
  Percent,
  PlugZap,
  Power,
  RadioTower,
  Send,
  ShieldCheck,
  TimerReset,
  Wallet,
  XCircle,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useSmsOverview, type SmsOverview } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  CODE_PURPOSES,
  CODES_ONLY_TEXT,
  INDEPENDENT_TEXT,
  LOW_BALANCE,
  PROVIDER_NAME,
  PURPOSE_LABEL,
  budgetState,
  formatClock,
  formatNumber,
  formatPct,
  formatRupees,
  formatWhen,
  heroState,
  missingEnv,
  monthLabel,
  overviewAlerts,
  usage,
  type AlertItem,
  type Tone,
} from "./logic";
import { smsPath } from "./routes";
import { ICON_TILE, LoadError, Meter, Notice, Panel, StatTile, TINT, VALUE_TINT } from "./ui";

type IconType = ComponentType<{ size?: number; className?: string }>;

function MoreLink({ to, children, testId }: { to: string; children: ReactNode; testId?: string }) {
  return (
    <Link
      href={to}
      data-testid={testId}
      className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-400"
    >
      {children} <ArrowRight size={11} />
    </Link>
  );
}

/** One fact of the status line: an icon, what it is, the answer in its tone, and a short line under it. */
function Fact({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  testId,
}: {
  icon: IconType;
  label: string;
  value: string;
  sub: ReactNode;
  tone: Tone;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 bg-card p-3.5 sm:p-4" data-testid={testId} data-tone={tone}>
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", ICON_TILE[tone])}>
        <Icon size={15} />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn("text-sm font-bold leading-snug", VALUE_TINT[tone])} data-testid={`${testId}-value`}>
          {value}
        </p>
        <p className="mt-0.5 break-words text-xs leading-snug text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}

/** The top of the page: what SMS codes are doing right now, in one title and one line, and the four facts it rests on. */
function StatusHero({ o }: { o: SmsOverview }) {
  const state = heroState(o);
  const name = PROVIDER_NAME;
  const missing = missingEnv(o);
  return (
    <section
      className="overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm"
      data-testid="sms-hero"
      data-state={state.id}
      data-tone={state.tone}
    >
      <div
        className={cn(
          "flex flex-wrap items-start gap-4 border-b p-4 sm:p-5",
          state.tone === "neutral" ? "bg-muted" : TINT[state.tone],
        )}
      >
        <span
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-card shadow-sm",
            VALUE_TINT[state.tone],
          )}
        >
          <MessageSquareText size={22} />
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-[11px] font-bold uppercase tracking-wider opacity-80">SMS codes through {name}</p>
          <h3 className="mt-0.5 text-xl font-black leading-tight sm:text-2xl" data-testid="sms-hero-title">
            {state.title}
          </h3>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed opacity-90" data-testid="sms-hero-detail">
            {state.detail}
          </p>
          {o.otpEnabled && o.purposes && (
            <ul className="mt-2.5 flex flex-wrap gap-1.5" data-testid="sms-hero-purposes" aria-label="Offered for">
              {CODE_PURPOSES.map((p) => {
                const on = o.purposes?.[p] === true;
                return (
                  <li
                    key={p}
                    data-testid={`sms-hero-purpose-${p}`}
                    data-on={on ? "true" : "false"}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-0.5 text-[11px] font-semibold",
                      on ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground line-through",
                    )}
                  >
                    {on ? <Check size={11} /> : <Minus size={11} />}
                    {PURPOSE_LABEL[p]}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <span
          className={cn("shrink-0 rounded-full border bg-card px-3 py-1 text-xs font-bold", VALUE_TINT[state.tone])}
          data-testid="sms-hero-badge"
        >
          {state.badge}
        </span>
      </div>

      {/* hairlines between the facts: the grid's own background shows through a 1px gap */}
      <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-4" data-testid="sms-status-cards">
        <Fact
          testId="sms-card-otp"
          icon={Power}
          label="SMS codes"
          value={o.otpEnabled ? "On" : "Off"}
          tone={o.otpEnabled ? "good" : "neutral"}
          sub={
            <MoreLink to={smsPath("settings", "switches")}>
              {o.otpEnabled ? "Change the switches" : "Switch on"}
            </MoreLink>
          }
        />
        <Fact
          testId="sms-card-configured"
          icon={PlugZap}
          label={`${name} set up`}
          value={o.configured ? "Yes" : "No"}
          tone={o.configured ? "good" : "bad"}
          sub={
            o.configured
              ? `The ${name} values are on the server.`
              : missing.length > 0
                ? `Missing: ${missing.join(", ")}`
                : "A value still looks like the example text."
          }
        />
        <Fact
          testId="sms-card-sending"
          icon={RadioTower}
          label="This server sends"
          value={o.sendingAllowed ? "Allowed" : "Not allowed"}
          tone={o.sendingAllowed ? "good" : "warn"}
          sub={o.sendingAllowed ? "Real SMS can go out from here." : o.sendingNote || "Sending is switched off here."}
        />
        <Fact
          testId="sms-card-circuit"
          icon={TimerReset}
          label="Sending"
          value={o.paused ? "Paused" : "Working"}
          tone={o.paused ? "bad" : "good"}
          sub={
            o.paused
              ? o.pauseReason || `Starts again${o.pausedUntil ? ` at ${formatClock(o.pausedUntil)}` : " by itself"}.`
              : `Pauses by itself after repeated ${name} failures or when a cap is used up.`
          }
        />
      </div>

      <div className="flex flex-wrap items-start gap-x-6 gap-y-1.5 border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
        <p className="flex min-w-0 items-start gap-1.5" data-testid="sms-codes-only">
          <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span>{CODES_ONLY_TEXT}</span>
        </p>
        <p className="flex min-w-0 items-start gap-1.5" data-testid="sms-independent">
          <KeyRound size={13} className="mt-0.5 shrink-0" />
          <span>{INDEPENDENT_TEXT}</span>
        </p>
      </div>
    </section>
  );
}

function Alerts({ items }: { items: AlertItem[] }) {
  return (
    <Panel
      title="Needs attention"
      description="Worked out from the state of the server right now, the most serious first."
      icon={ListChecks}
      testId="sms-alerts"
    >
      {items.length === 0 ? (
        <Notice tone="good" testId="sms-alerts-none">
          Nothing needs attention.
        </Notice>
      ) : (
        <ul className="space-y-2">
          {items.map((a, i) => (
            <li key={`${a.id}-${i}`} data-testid={`sms-alert-${a.id}`} data-tone={a.tone}>
              <Notice tone={a.tone}>
                <p>{a.message}</p>
                {a.to && (
                  <Link
                    href={a.to}
                    className="mt-1 inline-flex items-center gap-1 text-[13px] font-semibold underline underline-offset-2"
                  >
                    {a.linkLabel ?? "Open"} <ArrowRight size={12} />
                  </Link>
                )}
              </Notice>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The month's codes: sent, failed, blocked, used, and the two rates. */
function MonthTiles({ o }: { o: SmsOverview }) {
  const m = o.month;
  const rateTone = (r: number | null, good: number, warn: number): Tone =>
    r === null ? "neutral" : r >= good ? "good" : r >= warn ? "warn" : "bad";
  return (
    <section data-testid="sms-month" aria-labelledby="sms-month-title">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="sms-month-title" className="text-[15px] font-semibold">
          {monthLabel(o.monthKey)} so far
        </h3>
        <MoreLink to={smsPath("usage")} testId="sms-month-usage-link">
          Usage &amp; Cost
        </MoreLink>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile
          testId="sms-kpi-sent"
          label="Sent"
          icon={Send}
          tone="info"
          value={formatNumber(m.sent)}
          sub={`${formatNumber(m.requested)} asked for`}
        />
        <StatTile
          testId="sms-kpi-failed"
          label="Failed"
          icon={XCircle}
          tone={m.failed ? "bad" : "neutral"}
          value={formatNumber(m.failed)}
          sub={<MoreLink to={smsPath("messages", undefined, "status=failed")}>See them</MoreLink>}
        />
        <StatTile
          testId="sms-kpi-blocked"
          label="Blocked"
          icon={Ban}
          tone={m.blocked ? "warn" : "neutral"}
          value={formatNumber(m.blocked)}
          sub="Stopped by a limit or the pause"
        />
        <StatTile
          testId="sms-kpi-verified"
          label="Used to sign in"
          icon={BadgeCheck}
          tone="good"
          value={formatNumber(m.verified)}
          sub="SMS codes typed in and accepted"
        />
        <StatTile
          testId="sms-kpi-delivery"
          label="Delivery rate"
          icon={Percent}
          tone={rateTone(m.deliveryRate, 95, 80)}
          value={formatPct(m.deliveryRate)}
          sub={`Accepted by ${PROVIDER_NAME}`}
        />
        <StatTile
          testId="sms-kpi-verified-rate"
          label="Used rate"
          icon={Gauge}
          tone={rateTone(m.verifiedRate, 60, 30)}
          value={formatPct(m.verifiedRate)}
          sub="Of the codes sent, used"
        />
      </div>
    </section>
  );
}

function CostCard({ o }: { o: SmsOverview }) {
  const c = o.cost;
  const b = budgetState(c);
  const tone: Tone = b.level === "over" ? "bad" : b.level === "near" || b.projectedOver ? "warn" : "good";
  return (
    <Panel
      title="Cost this month"
      description={`An estimate: SMS sent × ${c.perSms !== null ? formatRupees(c.perSms, true) : "the price per SMS"} (Settings > Cost).`}
      icon={CircleDollarSign}
      testId="sms-cost"
      actions={<MoreLink to={smsPath("settings", "cost")}>Price and budget</MoreLink>}
    >
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">So far</p>
          <p className="text-3xl font-black tabular-nums" data-testid="sms-cost-so-far">
            {formatRupees(c.soFar)}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">At this pace</p>
          <p className="text-xl font-bold tabular-nums text-muted-foreground" data-testid="sms-cost-projected">
            {formatRupees(c.projected)}
          </p>
        </div>
        {c.budget !== null && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Budget</p>
            <p className="text-xl font-bold tabular-nums text-muted-foreground" data-testid="sms-cost-budget">
              {formatRupees(c.budget)}
            </p>
          </div>
        )}
      </div>
      {b.barPct !== null ? (
        <div className="mt-3" data-testid="sms-budget" data-level={b.level}>
          <Meter
            pct={b.barPct}
            tone={tone}
            label="Share of the monthly budget used"
            testId="sms-budget-bar"
            marker={c.projected !== null && c.budget ? (c.projected / c.budget) * 100 : null}
          />
          <p className={cn("mt-1.5 text-xs font-medium", VALUE_TINT[tone])} data-testid="sms-budget-line">
            {formatPct(b.usedPct)} of the budget used.
            {b.level === "over"
              ? " The budget is passed."
              : b.projectedOver
                ? ` At this pace the month ends ${formatRupees(b.overBy)} over it.`
                : " On course to stay within it."}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="sms-budget-none">
          No monthly budget is set.{" "}
          <Link href={smsPath("settings", "cost")} className="font-semibold underline underline-offset-2">
            Set one
          </Link>{" "}
          to be warned before the bill passes it.
        </p>
      )}
    </Panel>
  );
}

function BalanceCard({ o }: { o: SmsOverview }) {
  const name = PROVIDER_NAME;
  const credits = o.balance.credits;
  const tone: Tone = credits === null ? "neutral" : credits <= 0 ? "bad" : credits <= LOW_BALANCE ? "warn" : "good";
  return (
    <Panel title={`${name} balance`} icon={Wallet} testId="sms-card-balance">
      <p
        className={cn(
          "text-3xl font-black tabular-nums",
          credits === null ? "text-muted-foreground" : VALUE_TINT[tone],
        )}
        data-testid="sms-balance-value"
        data-tone={tone}
      >
        {credits === null ? "Unknown" : formatNumber(credits)}
      </p>
      <p className="mt-1 text-xs leading-snug text-muted-foreground" data-testid="sms-balance-note">
        {credits === null
          ? o.balance.error ||
            (o.configured ? `Look at the balance in the ${name} panel.` : `Shown once ${name} is set up.`)
          : `SMS credits left on the ${name} account.${credits <= LOW_BALANCE ? " Low: top it up soon." : ""}`}
        {o.balance.checkedAt && ` Checked ${formatClock(o.balance.checkedAt)}.`}
      </p>
    </Panel>
  );
}

/** Today: what was sent, and how much of the hourly and daily caps is used. */
function TodayCard({ o }: { o: SmsOverview }) {
  const tone = (l: ReturnType<typeof usage>["level"]): Tone => (l === "full" ? "bad" : l === "near" ? "warn" : "good");
  return (
    <Panel
      title="Today"
      icon={Gauge}
      testId="sms-today"
      actions={<MoreLink to={smsPath("messages")}>See the messages</MoreLink>}
    >
      <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span data-testid="sms-today-sent" className="font-bold">
          {formatNumber(o.today.sent)} sent
        </span>
        <span
          data-testid="sms-today-failed"
          className={o.today.failed ? "font-semibold text-red-700 dark:text-red-400" : "text-muted-foreground"}
        >
          {formatNumber(o.today.failed)} failed
        </span>
        <span
          data-testid="sms-today-blocked"
          className={o.today.blocked ? "font-semibold text-amber-700 dark:text-amber-400" : "text-muted-foreground"}
        >
          {formatNumber(o.today.blocked)} blocked
        </span>
      </p>
      {o.limits && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {(
            [
              ["hour", "This hour", o.limits.hourUsed, o.limits.hourlyCap],
              ["day", "Today", o.limits.dayUsed, o.limits.dailyCap],
            ] as const
          ).map(([id, label, used, cap]) => {
            const u = usage(used, cap);
            return (
              <div key={id} data-testid={`sms-cap-${id}`} data-level={u.level}>
                <p className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-semibold">{label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatNumber(used)} of {formatNumber(cap)} SMS
                  </span>
                </p>
                <Meter pct={u.pct} tone={tone(u.level)} label={`SMS used ${label.toLowerCase()} against the cap`} />
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground" data-testid="sms-last-sent">
        Last SMS sent: {o.lastSentAt ? formatWhen(o.lastSentAt) : "none yet"}
      </p>
    </Panel>
  );
}

function Loading() {
  return (
    <div className="space-y-4" data-testid="sms-overview-loading">
      <Skeleton className="h-52 w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

/**
 * Overview: the status line (SMS codes on or off, 2Factor set up, this server allowed to send, paused), what needs attention,
 * the month's codes and rates, the month's cost against the budget with the projection, the 2Factor balance, and today
 * against the caps. Everything comes from the one overview answer (it needs no other tab's permission).
 */
export default function OverviewTab() {
  const { data, isLoading, isError, refetch } = useSmsOverview();

  if (isLoading) return <Loading />;
  if (isError || !data) {
    return <LoadError what="The SMS overview" onRetry={() => void refetch()} testId="sms-overview-error" />;
  }

  const o = data;
  return (
    <div className="space-y-4" data-testid="sms-overview">
      <StatusHero o={o} />
      <Alerts items={overviewAlerts(o)} />
      <MonthTiles o={o} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <CostCard o={o} />
        <BalanceCard o={o} />
      </div>
      <TodayCard o={o} />
    </div>
  );
}
