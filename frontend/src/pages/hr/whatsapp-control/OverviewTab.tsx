import type { ReactNode } from "react";
import {
  ArrowRight,
  BadgeCheck,
  CheckCheck,
  Clock3,
  FileCheck2,
  Gauge,
  KeyRound,
  ListChecks,
  MessageCircle,
  Moon,
  PauseCircle,
  PowerOff,
  Send,
  ShieldCheck,
  SignalHigh,
  Webhook,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWhatsAppOverview, whatsAppErrorMessage, type WhatsAppOverview } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip, Dot, Kpi, Meter, Notice, Panel, TemplateStatusChip, VALUE_TINT } from "./kit";
import {
  alertTab,
  alertTone,
  budgetState,
  connectionVerdict,
  formatCount,
  formatInr,
  formatPct,
  numberStatusInfo,
  plural,
  qualityInfo,
  sortAlerts,
  tierInfo,
  webhookHealth,
  type Tone,
} from "./logic";
import type { WaAccess, WaTab } from "./tabs";

const GST = 0.18;

/** A link-like button to another tab, offered only when the role may open that tab. */
function GoLink({
  tab,
  access,
  go,
  children,
  testId,
}: {
  tab: WaTab;
  access: WaAccess;
  go: (tab: WaTab) => void;
  children: ReactNode;
  testId?: string;
}) {
  if (!access.canOpen(tab)) return null;
  return (
    <button
      type="button"
      onClick={() => go(tab)}
      data-testid={testId}
      className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
    >
      {children} <ArrowRight size={11} />
    </button>
  );
}

function HealthFact({
  icon: Icon,
  label,
  children,
  help,
  testId,
}: {
  icon: typeof Gauge;
  label: string;
  children: ReactNode;
  help?: string;
  testId: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-card px-3 py-2.5" title={help} data-testid={testId}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon size={12} className="shrink-0" /> {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold">{children}</p>
    </div>
  );
}

/** The hero: the business number and its health on the left, this month's spend against the budget on the right. */
function Hero({ data, access, go }: { data: WhatsAppOverview; access: WaAccess; go: (tab: WaTab) => void }) {
  const c = data.connection;
  const verdict = connectionVerdict(c);
  const quality = qualityInfo(c.qualityRating);
  const tier = tierInfo(c.messagingLimitTier);
  const status = numberStatusInfo(c.status);
  const hook = webhookHealth(c.lastWebhookAt);
  const budget = budgetState(data.cost.soFar, data.cost.projected, data.cost.budget);
  const meterTone: Tone = budget.level === "over" ? "bad" : budget.level === "near" ? "warn" : "good";

  return (
    <section
      className="overflow-hidden rounded-3xl border bg-card text-card-foreground shadow-sm"
      data-testid="wa-hero"
      data-verdict={verdict.tone}
    >
      <div className="grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0 bg-gradient-to-br from-emerald-50 via-card to-card p-5 sm:p-6 dark:from-emerald-950">
          <div className="flex flex-wrap items-start gap-3.5">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-sm">
              <MessageCircle size={24} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Business number · Meta WhatsApp Cloud API
              </p>
              <p
                className="mt-0.5 break-words text-2xl font-bold tabular-nums leading-tight"
                data-testid="wa-hero-number"
              >
                {c.displayNumber ?? (c.configured ? "Number not read yet" : "Not connected")}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                {c.verifiedName ? (
                  <>
                    <BadgeCheck size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                    {c.verifiedName}
                  </>
                ) : (
                  "Verified name not known"
                )}
              </p>
            </div>
            <Chip tone={verdict.tone} testId="wa-hero-verdict">
              {verdict.label}
            </Chip>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <HealthFact icon={SignalHigh} label="Quality" help={quality.help} testId="wa-hero-quality">
              <Dot tone={quality.tone}>{quality.label}</Dot>
            </HealthFact>
            <HealthFact
              icon={Gauge}
              label="Messaging limit"
              help="How many different people the number may start a chat with in any 24 hours (Meta raises it as quality stays high)."
              testId="wa-hero-tier"
            >
              {tier.label}
            </HealthFact>
            <HealthFact icon={ShieldCheck} label="Number status" testId="wa-hero-status">
              <Dot tone={status.tone}>{status.label}</Dot>
            </HealthFact>
            <HealthFact
              icon={Webhook}
              label="Webhook"
              help="When Meta last sent a delivery receipt or a template update to this server."
              testId="wa-hero-webhook"
            >
              <Dot tone={hook.tone}>{hook.label}</Dot>
            </HealthFact>
          </div>

          {!c.configured && (
            <Notice
              tone="bad"
              className="mt-4"
              title="WhatsApp is not set up on this server"
              testId="wa-hero-not-configured"
              action={
                access.canOpen("config") ? (
                  <Button size="sm" variant="outline" onClick={() => go("config")} className="h-8 text-xs">
                    Open Settings
                  </Button>
                ) : undefined
              }
            >
              Nothing is sent until the Meta Cloud API keys are in the server's environment. The Settings tab lists
              which ones are missing.
            </Notice>
          )}
          {c.configured && c.blockReasons.length > 0 && (
            <Notice tone="warn" className="mt-4" title="Sending is held back" testId="wa-hero-blocked">
              <ul className="list-disc space-y-0.5 pl-4">
                {c.blockReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Notice>
          )}
        </div>

        <div className="min-w-0 border-t p-5 sm:p-6 lg:border-l lg:border-t-0" data-testid="wa-hero-cost">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Spent this month · estimate
          </p>
          <p className="mt-1 text-3xl font-bold tabular-nums leading-tight" data-testid="wa-hero-spent">
            {formatInr(data.cost.soFar)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{formatInr(data.cost.soFar * (1 + GST))} with 18% GST</p>

          <div className="mt-5 space-y-2">
            {budget.level === "none" ? (
              <p className="text-xs text-muted-foreground" data-testid="wa-hero-no-budget">
                No monthly budget is set.{" "}
                <GoLink tab="config" access={access} go={go}>
                  Set one
                </GoLink>
              </p>
            ) : (
              <>
                <Meter
                  pct={budget.usedPct ?? 0}
                  markPct={budget.projectedPct}
                  tone={meterTone}
                  label="Share of the monthly budget spent"
                  testId="wa-hero-budget-meter"
                />
                <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
                  <span>
                    <b className={cn("tabular-nums", VALUE_TINT[meterTone])}>{formatPct(budget.usedPct)}</b> of{" "}
                    {formatInr(data.cost.budget)}
                  </span>
                  <span>The mark: where the month ends</span>
                </div>
              </>
            )}
          </div>

          <div className="mt-5 flex items-end justify-between gap-3 rounded-2xl bg-muted px-4 py-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Projected month</p>
              <p className="text-xl font-bold tabular-nums" data-testid="wa-hero-projected">
                {formatInr(data.cost.projected)}
              </p>
              <p className="text-[11px] text-muted-foreground">{formatInr(data.cost.projected * (1 + GST))} with GST</p>
            </div>
            {budget.projectedOver && (
              <Chip tone="warn" testId="wa-hero-over-budget">
                Over budget
              </Chip>
            )}
          </div>
          <div className="mt-3">
            <GoLink tab="usage" access={access} go={go} testId="wa-hero-usage-link">
              See usage and cost
            </GoLink>
          </div>
        </div>
      </div>
    </section>
  );
}

function Kpis({ data, onOpenFailures }: { data: WhatsAppOverview; onOpenFailures?: () => void }) {
  const m = data.month;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="wa-kpis">
      <Kpi
        label="Sent this month"
        value={formatCount(m.sent)}
        sub={
          m.queued || m.skipped
            ? `${formatCount(m.queued)} waiting · ${formatCount(m.skipped)} skipped`
            : "accepted by Meta"
        }
        icon={Send}
        testId="wa-kpi-sent"
      />
      <Kpi
        label="Delivered"
        value={formatPct(m.deliveryRate)}
        sub={`${formatCount(m.delivered + m.read)} reached the phone`}
        tone={
          m.deliveryRate === null ? "neutral" : m.deliveryRate >= 90 ? "good" : m.deliveryRate >= 75 ? "warn" : "bad"
        }
        icon={CheckCheck}
        testId="wa-kpi-delivered"
      />
      <Kpi
        label="Read"
        value={formatPct(m.readRate)}
        sub={`${formatCount(m.read)} opened (blue ticks)`}
        tone="info"
        icon={ListChecks}
        testId="wa-kpi-read"
      />
      <Kpi
        label="Failed"
        value={formatCount(m.failed)}
        sub={m.failed ? "not re-sent automatically" : "nothing failed"}
        tone={m.failed ? "bad" : "neutral"}
        icon={XCircle}
        testId="wa-kpi-failed"
      >
        {m.failed > 0 && onOpenFailures && (
          <button
            type="button"
            onClick={onOpenFailures}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
            data-testid="wa-kpi-failed-link"
          >
            See the failures <ArrowRight size={11} />
          </button>
        )}
      </Kpi>
    </div>
  );
}

function Alerts({ data, access, go }: { data: WhatsAppOverview; access: WaAccess; go: (tab: WaTab) => void }) {
  const alerts = sortAlerts(data.alerts);
  return (
    <Panel
      title="Needs your attention"
      description="What stops messages going out, or costs more than it should."
      icon={ShieldCheck}
      testId="wa-alerts"
    >
      {alerts.length === 0 ? (
        <Notice tone="good" testId="wa-alerts-none">
          Nothing needs your attention: every check is fine.
        </Notice>
      ) : (
        <ul className="space-y-2">
          {alerts.map((a, i) => {
            const tab = alertTab(a);
            return (
              <li key={`${a.code}-${i}`}>
                <Notice
                  tone={alertTone(a.level)}
                  testId={`wa-alert-${a.code || i}`}
                  action={
                    tab && access.canOpen(tab) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={() => go(tab)}
                        data-testid={`wa-alert-go-${a.code || i}`}
                      >
                        Fix <ArrowRight size={11} />
                      </Button>
                    ) : undefined
                  }
                >
                  {a.message}
                </Notice>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function TemplatesCard({ data, access, go }: { data: WhatsAppOverview; access: WaAccess; go: (tab: WaTab) => void }) {
  const t = data.templates;
  const missing = t.missingForEnabledTypes;
  return (
    <Panel
      title="Templates"
      description="Every message goes out as a template Meta approved."
      icon={FileCheck2}
      testId="wa-templates-summary"
      actions={
        <GoLink tab="templates" access={access} go={go}>
          Manage
        </GoLink>
      }
    >
      <div className="grid grid-cols-3 gap-2 text-center">
        {(
          [
            ["Approved", t.approved, "good"],
            ["In review", t.pending, "warn"],
            ["Rejected", t.rejected, t.rejected ? "bad" : "neutral"],
          ] as const
        ).map(([label, n, tone]) => (
          <div
            key={label}
            className="rounded-xl bg-muted px-2 py-2.5"
            data-testid={`wa-templates-${label.toLowerCase().replace(" ", "-")}`}
          >
            <p className={cn("text-xl font-bold tabular-nums", VALUE_TINT[tone])}>{formatCount(n)}</p>
            <p className="text-[11px] text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
      {missing.length > 0 ? (
        <Notice tone="warn" className="mt-3" testId="wa-templates-missing">
          <b>{plural(missing.length, "switched-on message type")}</b> {missing.length === 1 ? "has" : "have"} no
          approved template, so {missing.length === 1 ? "it is" : "they are"} skipped:{" "}
          {missing
            .slice(0, 4)
            .map((m) => m.label)
            .join(", ")}
          {missing.length > 4 ? ` and ${missing.length - 4} more` : ""}.
        </Notice>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Every switched-on message type has a template.</p>
      )}
    </Panel>
  );
}

function OtpCard({ data, access, go }: { data: WhatsAppOverview; access: WaAccess; go: (tab: WaTab) => void }) {
  const o = data.otp;
  const tone: Tone = !o.enabled ? "neutral" : o.available ? "good" : "warn";
  return (
    <Panel
      title="Sign-in codes"
      icon={KeyRound}
      testId="wa-otp-summary"
      actions={
        <GoLink tab="otp" access={access} go={go}>
          OTP settings
        </GoLink>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          WhatsApp codes are{" "}
          <b className={VALUE_TINT[tone]} data-testid="wa-otp-summary-state">
            {!o.enabled ? "OFF" : o.available ? "working" : "ON, but not available"}
          </b>
        </p>
        {o.enabled && <TemplateStatusChip status={o.templateStatus} />}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {o.enabled && !o.available
          ? "Employees get no WhatsApp code until the code template is approved and sending is allowed. SMS codes, where switched on, still work."
          : "SMS codes are set on SMS Control and work on their own: either one is enough."}
      </p>
    </Panel>
  );
}

function TodayCard({ data, access, go }: { data: WhatsAppOverview; access: WaAccess; go: (tab: WaTab) => void }) {
  const q = data.queue;
  if (!q) return null;
  return (
    <Panel
      title="Today"
      icon={Clock3}
      testId="wa-today"
      actions={
        <GoLink tab="controls" access={access} go={go}>
          Queue and limits
        </GoLink>
      }
    >
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-muted px-2 py-2.5">
          <p className="text-xl font-bold tabular-nums">{formatCount(q.queued)}</p>
          <p className="text-[11px] text-muted-foreground">waiting</p>
        </div>
        <div className="rounded-xl bg-muted px-2 py-2.5">
          <p className="text-xl font-bold tabular-nums">
            {formatCount(q.sentToday)}
            {q.limits.maxPerDay > 0 && (
              <span className="text-xs font-semibold text-muted-foreground"> / {formatCount(q.limits.maxPerDay)}</span>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground">sent</p>
        </div>
        <div className="rounded-xl bg-muted px-2 py-2.5">
          <p className={cn("text-xl font-bold tabular-nums", q.failedToday ? VALUE_TINT.bad : "")}>
            {formatCount(q.failedToday)}
          </p>
          <p className="text-[11px] text-muted-foreground">failed</p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {!q.engineEnabled && (
          <Notice tone="bad" icon={PowerOff} testId="wa-today-engine-off">
            The WhatsApp engine is <b>OFF</b>: nothing is sent.
          </Notice>
        )}
        {q.paused && (
          <Notice tone="warn" icon={PauseCircle} testId="wa-today-paused">
            <b>Sending is paused.</b> {q.pausedReason || "The server gave no reason."}
          </Notice>
        )}
        {q.inQuietHours && (
          <Notice tone="info" icon={Moon} testId="wa-today-quiet">
            Quiet hours: nothing automatic goes out right now. Sign-in codes still go.
          </Notice>
        )}
      </div>
    </Panel>
  );
}

/** The Overview: one hero (the number's health and the month's spend), the month in four numbers, what needs
 *  attention, and short cards for templates, sign-in codes and today's queue. Refreshes every minute. */
export default function OverviewTab({
  access,
  go,
  onOpenFailures,
}: {
  access: WaAccess;
  go: (tab: WaTab) => void;
  /** Opens Messages filtered to the failures (only offered when the role may open Messages). */
  onOpenFailures?: () => void;
}) {
  const { data, isLoading, error } = useWhatsAppOverview();

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="wa-overview-loading">
        <Skeleton className="h-72 rounded-3xl" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <Notice tone="bad" role="alert" testId="wa-overview-error" title="The overview could not be loaded">
        {whatsAppErrorMessage(error, "Try Refresh in a moment.")}
      </Notice>
    );
  }

  return (
    <div className="space-y-4" data-testid="wa-overview">
      <Hero data={data} access={access} go={go} />
      <Kpis data={data} onOpenFailures={onOpenFailures} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Alerts data={data} access={access} go={go} />
        <div className="space-y-4">
          <TemplatesCard data={data} access={access} go={go} />
          <OtpCard data={data} access={access} go={go} />
          <TodayCard data={data} access={access} go={go} />
        </div>
      </div>
    </div>
  );
}
