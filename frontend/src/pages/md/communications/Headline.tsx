// The executive overview: four headline figures, one card per channel (a click narrows the page to that channel), and
// what stands out this month (the server's summary sentence and insights).

import {
  CalendarClock,
  IndianRupee,
  Mail,
  MessageCircle,
  MessagesSquare,
  PiggyBank,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import InsightList from "@/components/md/kit/InsightList";
import SectionCard from "@/components/md/kit/SectionCard";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import {
  CHANNEL_LABEL,
  CHANNELS,
  basisText,
  changeChip,
  channelOf,
  headlineFigures,
  insightsFor,
  perChannelText,
  rateText,
  rupees,
} from "./logic";
import type { Channel, ChannelBlock, ChannelFilter, CommsOverview, SmsBalance } from "./types";

const CHANNEL_ICON = { whatsapp: MessageCircle, sms: Smartphone, email: Mail } as const;
const CHANNEL_TONE: Record<Channel, StatTone> = { whatsapp: "blue", sms: "slate", email: "teal" };

const ids = (data: CommsOverview | undefined, wanted: string[]) =>
  data?.provenance.filter((p) => wanted.includes(p.id)) ?? [];

function budgetTone(used: number | null | undefined): StatTone {
  if (used == null) return "slate";
  return used >= 100 ? "red" : used >= 80 ? "amber" : "green";
}

const BUDGET_HINT: Record<ChannelFilter, string> = {
  all: "A monthly budget can be set on WhatsApp Control and SMS Control.",
  whatsapp: "A monthly budget can be set on WhatsApp Control.",
  sms: "A monthly budget can be set on SMS Control.",
  email: "Gmail has no charge, so it has no budget.",
};

/** The four headline figures of the month, for every channel or the one chosen. */
export function HeadlineKpis({
  data,
  loading,
  channel,
}: {
  data?: CommsOverview;
  loading: boolean;
  channel: ChannelFilter;
}) {
  const t = data ? headlineFigures(data, channel) : undefined;
  const blocks = data?.channels ?? [];
  const block = channel === "all" ? undefined : channelOf(blocks, channel);
  const prev = t?.previous?.month;
  const current = !!data?.isCurrentMonth;
  const tried = t ? t.failed + t.messages : 0;
  const failRate = t && tried ? pct((t.failed / tried) * 100) : "—";
  const messagesSub = !t
    ? undefined
    : block
      ? `${CHANNEL_LABEL[block.channel]} only${block.delivered != null ? `: ${num(block.delivered)} delivered` : ""}`
      : perChannelText(blocks, (b) => num(b.messages));
  const costSub = block
    ? block.costNote
    : "Before GST. WhatsApp and SMS at the rates set in their Control pages; Gmail has no charge.";
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4" data-testid="md-comms-kpis">
        <StatCard
          label="Messages sent"
          value={t ? num(t.messages) : "—"}
          sub={messagesSub}
          icon={MessagesSquare}
          tone="indigo"
          delta={changeChip(t?.change?.messages, prev)}
          spark={t?.sparkMessages}
          loading={loading}
          provenance={ids(data, ["wa-messages", "sms-messages", "email-messages", "change"])}
          testId="md-comms-kpi-messages"
        />
        <StatCard
          label={current ? "Estimated cost so far" : "Estimated cost"}
          value={t ? (t.free ? "No charge" : rupees(t.cost)) : "—"}
          sub={costSub}
          icon={IndianRupee}
          tone="blue"
          delta={t?.free ? null : changeChip(t?.change?.cost, prev, { money: true, higherIsBetter: false })}
          spark={t?.free ? undefined : t?.sparkCost}
          loading={loading}
          provenance={ids(data, ["wa-cost", "sms-cost", "email-cost", "change"])}
          testId="md-comms-kpi-cost"
        />
        {current || !t ? (
          <StatCard
            label="Projected month cost"
            value={t ? (t.free ? "No charge" : rupees(t.projectedCost)) : "—"}
            sub={
              t
                ? `At this pace: ${data?.daysElapsed} of ${data?.daysInMonth} days gone, ${num(t.projectedMessages)} messages expected.`
                : undefined
            }
            icon={CalendarClock}
            tone="purple"
            loading={loading}
            provenance={ids(data, ["projection"])}
            testId="md-comms-kpi-projected"
          />
        ) : (
          <StatCard
            label="Failed messages"
            value={num(t.failed)}
            sub={`${failRate} of the ones tried did not go out.`}
            icon={TriangleAlert}
            tone={t.failed ? "amber" : "green"}
            loading={loading}
            testId="md-comms-kpi-failed"
          />
        )}
        <StatCard
          label="Budget used"
          value={t?.budget ? pct(t.budgetUsedPct) : t ? "No budget" : "—"}
          sub={
            t?.budget
              ? `${rupees(t.budgetCost)} of ${rupees(t.budget)} (${t.budgetChannels.map((c) => CHANNEL_LABEL[c]).join(" + ")} budgets).`
              : t
                ? BUDGET_HINT[channel]
                : undefined
          }
          icon={PiggyBank}
          tone={budgetTone(t?.budgetUsedPct)}
          loading={loading}
          testId="md-comms-kpi-budget"
        />
      </div>
      {t?.previous && (
        <p className="px-1 text-[11px] font-medium text-md-ink-soft" data-testid="md-comms-basis">
          {basisText(t.changeBasis, t.previous.label)}: {num(t.previous.messages)} messages
          {t.free ? "" : `, ${rupees(t.previous.cost)}`}.
        </p>
      )}
    </div>
  );
}

function costLine(b: ChannelBlock): string {
  if (b.costBasis === "free") return "No per-email charge";
  if (b.channel === "sms") return `${rupees(b.cost)} est. at ${rateText(b.rates?.perSms)} each`;
  return `${rupees(b.cost)} est. (${rupees(b.costWithGst)} with GST)`;
}

function statusLine(b: ChannelBlock): string {
  const parts: string[] = [];
  if (b.delivered != null) parts.push(`${num(b.delivered)} delivered`);
  parts.push(`${num(b.failed)} failed`);
  if (b.skipped) parts.push(`${num(b.skipped)} skipped`);
  if (b.waiting) parts.push(`${num(b.waiting)} waiting`);
  return parts.join(" · ");
}

/** One card per channel: messages, cost, delivery and budget. A click shows only that channel (again: all of them). */
export function ChannelCards({
  data,
  loading,
  balance,
  channel,
  onChannel,
}: {
  data?: CommsOverview;
  loading: boolean;
  balance?: SmsBalance;
  channel: ChannelFilter;
  onChannel: (next: ChannelFilter) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3" data-testid="md-comms-channels">
      {CHANNELS.map((c) => {
        const b = channelOf(data?.channels, c);
        const chosen = channel === c;
        return (
          <div
            key={c}
            className={cn(
              "rounded-[20px] transition-opacity",
              // two a row on a phone, the third across both; three a row once there is room
              c === "email" && "col-span-2 @2xl:col-span-1",
              chosen && "ring-2 ring-md-wine/45",
              channel !== "all" && !chosen && "opacity-70",
            )}
            data-chosen={chosen || undefined}
          >
            <StatCard
              label={CHANNEL_LABEL[c]}
              value={b ? `${num(b.messages)} sent` : "—"}
              icon={CHANNEL_ICON[c]}
              tone={CHANNEL_TONE[c]}
              delta={changeChip(b?.change?.messages, b?.previous?.month)}
              loading={loading}
              onClick={() => onChannel(chosen ? "all" : c)}
              testId={`md-comms-card-${c}`}
              sub={
                b ? (
                  <span className="block space-y-0.5">
                    <span className="block font-semibold text-md-ink">{costLine(b)}</span>
                    <span className="block">{statusLine(b)}</span>
                    {b.budget != null && (
                      <span className="block">
                        Budget {rupees(b.budget)}: {pct(b.budgetUsedPct)} used
                        {data?.isCurrentMonth && b.projectedBudgetPct != null
                          ? `, ${pct(b.projectedBudgetPct)} at this pace`
                          : ""}
                      </span>
                    )}
                    {c === "sms" && balance && (
                      <span
                        className={cn("block", balance.isLow && "font-semibold text-md-danger-700")}
                        data-testid="md-comms-sms-credits"
                      >
                        {balance.credits != null
                          ? `${num(balance.credits)} credits left on 2Factor`
                          : (balance.error ?? "Credits not known")}
                      </span>
                    )}
                    {c === "email" && b.peakDay && (
                      <span className="block">
                        Busiest day {num(b.peakDay.sent)} of {num(b.dailyLimit?.value)} a day allowed
                      </span>
                    )}
                  </span>
                ) : undefined
              }
            />
          </div>
        );
      })}
    </div>
  );
}

/** The server's plain-English summary and what stands out (budget, cost swing, the costliest type, failures, limits). */
export function StandsOut({
  data,
  loading,
  channel,
}: {
  data?: CommsOverview;
  loading: boolean;
  channel: ChannelFilter;
}) {
  return (
    <SectionCard
      title="What stands out"
      subtitle={data ? `${data.label}, worked out from the same figures as the cards` : undefined}
      loading={loading && !data}
      testId="md-comms-standout"
    >
      {data && (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-md-ink" data-testid="md-comms-summary">
            {data.summary}
          </p>
          <InsightList
            items={insightsFor(data.insights, channel).map((i) => ({
              id: i.id,
              severity: i.severity,
              title: i.title,
              detail: i.detail ?? undefined,
              ask: i.ask ?? undefined,
            }))}
            emptyText="No budget, cost or failure problem this month."
          />
        </div>
      )}
    </SectionCard>
  );
}
