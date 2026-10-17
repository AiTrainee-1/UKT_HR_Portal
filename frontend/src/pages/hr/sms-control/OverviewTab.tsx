import { Link } from "wouter";
import {
  ArrowRight,
  CircleDollarSign,
  Gauge,
  ListChecks,
  MessageSquareText,
  PlugZap,
  RadioTower,
  Send,
  TimerReset,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSmsOverview, type SmsOverview } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  CHANNEL_LABEL,
  balanceState,
  chartBars,
  formatClock,
  formatNumber,
  formatWhen,
  missingEnv,
  PROVIDER_NAME,
  nextSteps,
  usage,
  type NextStep,
} from "./logic";
import { smsPath } from "./routes";
import { Notice, Panel, StatusCard, UsageBar, stepTone, type Tone } from "./ui";

function Checklist({ steps }: { steps: NextStep[] }) {
  return (
    <Panel
      title="What to do next"
      description="Worked out from the state of the server right now."
      icon={ListChecks}
      testId="sms-next-steps"
    >
      <ol className="space-y-2.5">
        {steps.map((step) => (
          <li key={step.id} data-testid={`sms-step-${step.id}`} data-tone={step.tone}>
            <Notice tone={stepTone(step.tone)}>
              <p className="font-semibold">{step.title}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed opacity-90">{step.detail}</p>
              {step.to && (
                <Link
                  href={step.to}
                  className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-semibold underline underline-offset-2"
                >
                  {step.linkLabel ?? "Open"} <ArrowRight size={12} />
                </Link>
              )}
            </Notice>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function balanceCard(o: SmsOverview): { value: string; sub: string; tone: Tone } {
  const balance = balanceState(o);
  const name = PROVIDER_NAME;
  const look = `Look at the balance in the ${name} panel.`;
  if (balance.kind === "empty") return { value: "Empty", sub: balance.note, tone: "bad" };
  if (balance.amount === null) {
    // 2Factor offers no balance check this system can use safely: the card says where to look instead of showing a number
    return {
      value: "Not shown here",
      sub: balance.note || (o.configured ? look : `Shown once ${name} is set up.`),
      tone: "neutral",
    };
  }
  const checked = o.balance.checkedAt ? `Checked ${formatClock(o.balance.checkedAt)}.` : "";
  const low = balance.kind === "low";
  return {
    value: formatNumber(balance.amount),
    sub: `${low ? "Low: top it up soon. " : ""}${checked}`.trim() || `Left on your ${name} account.`,
    tone: low ? "warn" : "good",
  };
}

function Chart({ days, lastSentAt }: { days: SmsOverview["last7Days"]; lastSentAt: string | null }) {
  const { bars } = chartBars(days);
  const sent = bars.reduce((n, b) => n + b.sent, 0);
  const failed = bars.reduce((n, b) => n + b.failed, 0);
  return (
    <Panel
      title="The last 7 days"
      description={`SMS handed to ${PROVIDER_NAME} each day: the green part was accepted, the red part failed.`}
      icon={RadioTower}
      testId="sms-chart"
    >
      {bars.length === 0 || sent + failed === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground" data-testid="sms-chart-empty">
          No SMS in the last 7 days.
        </p>
      ) : (
        <div role="img" aria-label={`Last 7 days: ${sent} sent, ${failed} failed`}>
          <div className="flex h-36 items-end gap-1.5 sm:gap-2">
            {bars.map((b) => (
              <div
                key={b.date}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
                title={`${b.label}: ${b.sent} sent, ${b.failed} failed`}
                data-testid={`sms-bar-${b.date}`}
              >
                <span className="mb-1 text-center text-[10px] font-semibold tabular-nums text-muted-foreground">
                  {b.total}
                </span>
                <div className="flex flex-col justify-end" style={{ height: "calc(100% - 16px)" }}>
                  <div className="rounded-t-sm bg-red-400" style={{ height: `${b.failedPct}%` }} />
                  <div
                    className={cn("bg-emerald-500", b.failed === 0 && "rounded-t-sm")}
                    style={{ height: `${b.sentPct}%`, minHeight: b.sent ? 2 : 0 }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1.5 sm:gap-2">
            {bars.map((b) => (
              <span key={b.date} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground">
                {b.label}
              </span>
            ))}
          </div>
        </div>
      )}
      {/* the same numbers as a table, for a screen reader */}
      <table className="sr-only" data-testid="sms-chart-table">
        <caption>SMS per day, last 7 days</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Sent</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.date}>
              <td>{b.label}</td>
              <td>{b.sent}</td>
              <td>{b.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-sm bg-emerald-500" /> Sent
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block h-2 w-2 rounded-sm bg-red-400" /> Failed
          </span>
        </span>
        <span data-testid="sms-last-sent">Last SMS sent: {lastSentAt ? formatWhen(lastSentAt) : "none yet"}</span>
      </div>
    </Panel>
  );
}

function Loading() {
  return (
    <div className="space-y-4" data-testid="sms-overview-loading">
      <Skeleton className="h-40 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-56 w-full rounded-2xl" />
    </div>
  );
}

/**
 * Overview: what to do next (from the state of the server), the status cards (channel, 2Factor set up, sending allowed, balance,
 * today, the hour and day usage against the caps, the pause) and the last seven days.
 */
export default function OverviewTab() {
  const { data, isLoading, isError, refetch } = useSmsOverview();

  if (isLoading) return <Loading />;
  if (isError || !data) {
    return (
      <Notice tone="bad" role="alert" testId="sms-overview-error">
        <div className="flex flex-wrap items-center gap-3">
          <span>The SMS overview could not be loaded. Check the connection and try again.</span>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      </Notice>
    );
  }

  const o = data;
  const steps = nextSteps(o);
  const missing = missingEnv(o);
  const hour = usage(o.limits.hourUsed, o.limits.hourlyCap);
  const day = usage(o.limits.dayUsed, o.limits.dailyCap);
  const balance = balanceCard(o);
  const name = PROVIDER_NAME;
  const level = (l: ReturnType<typeof usage>["level"]): Tone => (l === "full" ? "bad" : l === "near" ? "warn" : "good");

  return (
    <div className="space-y-4" data-testid="sms-overview">
      <Checklist steps={steps} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="sms-status-cards">
        <StatusCard
          testId="sms-card-channel"
          label="Codes go by"
          icon={Send}
          value={CHANNEL_LABEL[o.channel]}
          tone={o.channel === "sms" ? "info" : "neutral"}
          sub={
            o.channel === "sms" ? (
              `Login, reset and activation codes are sent as SMS through ${name}.`
            ) : (
              <>
                WhatsApp, as before.{" "}
                <Link href={smsPath("settings", "channel")} className="font-semibold underline underline-offset-2">
                  Change
                </Link>
              </>
            )
          }
        />
        <StatusCard
          testId="sms-card-configured"
          label={`${name} set up`}
          icon={PlugZap}
          value={o.configured ? "Yes" : "No"}
          tone={o.configured ? "good" : "bad"}
          sub={
            o.configured
              ? `All the ${name} values are set on the server.`
              : missing.length > 0
                ? `Missing: ${missing.join(", ")}`
                : "A value still looks like the example text."
          }
        />
        <StatusCard
          testId="sms-card-sending"
          label="This machine sends"
          icon={RadioTower}
          value={o.sendingAllowed ? "Allowed" : "Not allowed"}
          tone={o.sendingAllowed ? "good" : "warn"}
          sub={o.sendingAllowed ? "Real SMS can go out from here." : o.sendingNote || "Sending is switched off here."}
        />
        <StatusCard
          testId="sms-card-balance"
          label={`${name} balance`}
          icon={CircleDollarSign}
          value={balance.value}
          tone={balance.tone}
          sub={balance.sub}
        />
        <StatusCard
          testId="sms-card-today"
          label="Today"
          icon={MessageSquareText}
          value={
            <span className="flex flex-wrap items-baseline gap-x-3 text-base">
              <span data-testid="sms-today-sent">{formatNumber(o.today.sent)} sent</span>
              <span
                data-testid="sms-today-failed"
                className={o.today.failed ? "text-red-700 dark:text-red-400" : "text-muted-foreground"}
              >
                {formatNumber(o.today.failed)} failed
              </span>
              <span
                data-testid="sms-today-blocked"
                className={o.today.blocked ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}
              >
                {formatNumber(o.today.blocked)} blocked
              </span>
            </span>
          }
          sub={
            <Link href={smsPath("messages")} className="font-semibold underline underline-offset-2">
              See the messages
            </Link>
          }
        />
        <StatusCard
          testId="sms-card-hour"
          label="This hour"
          icon={Gauge}
          value={`${formatNumber(o.limits.hourUsed)} of ${formatNumber(o.limits.hourlyCap)}`}
          tone={level(hour.level)}
          sub={hour.level === "full" ? "Cap reached: new codes are refused." : "SMS sent against the hourly cap."}
        >
          <UsageBar
            used={o.limits.hourUsed}
            cap={o.limits.hourlyCap}
            label="SMS used this hour"
            testId="sms-hour-bar"
          />
        </StatusCard>
        <StatusCard
          testId="sms-card-day"
          label="Today against the cap"
          icon={Gauge}
          value={`${formatNumber(o.limits.dayUsed)} of ${formatNumber(o.limits.dailyCap)}`}
          tone={level(day.level)}
          sub={day.level === "full" ? "Cap reached: new codes are refused." : "SMS sent against the daily cap."}
        >
          <UsageBar used={o.limits.dayUsed} cap={o.limits.dailyCap} label="SMS used today" testId="sms-day-bar" />
        </StatusCard>
        <StatusCard
          testId="sms-card-circuit"
          label="Sending"
          icon={TimerReset}
          value={o.circuit.paused ? "Paused" : "Working"}
          tone={o.circuit.paused ? "bad" : "good"}
          sub={
            o.circuit.paused
              ? `After repeated ${name} failures. Starts again${o.circuit.until ? ` at ${formatClock(o.circuit.until)}` : " by itself"}.`
              : `Pauses by itself for ten minutes after three ${name} failures in ten minutes.`
          }
        />
      </div>

      <Chart days={o.last7Days} lastSentAt={o.lastSentAt} />
    </div>
  );
}
