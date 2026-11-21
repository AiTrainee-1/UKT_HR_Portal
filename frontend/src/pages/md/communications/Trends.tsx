// Twelve months: cost per channel, messages per channel, the chosen month's share by channel, and a month-by-month table
// whose rows open that month.

import { Mail } from "lucide-react";
import type { Column } from "@/components/md/kit/DataTable";
import DataTable from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { ChannelDonut, CostTrendChart, MessagesTrendChart } from "./charts";
import { CHANNELS, forChannel, monthRows, rupees, type MonthRow } from "./logic";
import type { Channel, ChannelFilter, CommsOverview } from "./types";

const provOf = (data: CommsOverview | undefined, wanted: string[]) =>
  data?.provenance.filter((p) => wanted.includes(p.id)) ?? [];

export function Trends({
  data,
  loading,
  channel,
  onMonth,
}: {
  data?: CommsOverview;
  loading: boolean;
  channel: ChannelFilter;
  onMonth: (month: string) => void;
}) {
  const channels: Channel[] = channel === "all" ? CHANNELS : [channel];
  const series = data?.series ?? [];
  const months = monthRows(series);
  const shown = forChannel(data?.channels ?? [], channel);

  const columns: Column<MonthRow>[] = [
    {
      key: "month",
      header: "Month",
      cell: (r) => (
        <span className={cn("font-semibold", r.month === data?.month && "text-md-wine")}>
          {r.label}
          {r.isCurrentMonth && <span className="ml-1 text-[11px] font-medium text-md-ink-soft">so far</span>}
        </span>
      ),
    },
    // the card is narrow beside the chart: all channels show their total (the split is in the chart), one channel its own
    {
      key: "messages",
      header: channel === "all" ? "Messages" : "Sent",
      cell: (r) => num(channel === "all" ? r.messages : r[channel]),
      align: "right",
    },
    {
      key: "cost",
      header: "Est. cost",
      cell: (r) =>
        channel === "email"
          ? "No charge"
          : rupees(channel === "all" ? r.cost : (series.find((p) => p.month === r.month)?.[channel].cost ?? 0)),
      align: "right",
    },
    ...(channel === "all"
      ? [
          {
            key: "change",
            header: "vs before",
            cell: (r: MonthRow) =>
              r.costChangePct == null ? (
                "—"
              ) : (
                <span className={r.costChangePct > 0 ? "text-md-danger-700" : "text-md-success-700"}>
                  {r.costChangePct > 0 ? "+" : ""}
                  {pct(r.costChangePct, 0)}
                </span>
              ),
            align: "right" as const,
          },
        ]
      : []),
  ];

  return (
    <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-12 @lg:gap-5" data-testid="md-comms-trends">
      <SectionCard
        title="Cost by month"
        subtitle="Estimated, before GST, from the rates set in WhatsApp Control and SMS Control. Gmail has no charge."
        provenance={provOf(data, ["wa-cost", "sms-cost", "email-cost"])}
        loading={loading && !data}
        className="@4xl:col-span-7"
        testId="md-comms-cost"
      >
        {channel === "email" ? (
          <EmptyBlock icon={Mail} title="Gmail has no per-email charge">
            The HRMS sends email through Gmail (SMTP), which charges nothing per email, and no email price is set.
          </EmptyBlock>
        ) : (
          <CostTrendChart series={series} channels={channels} />
        )}
      </SectionCard>
      <SectionCard
        title={data ? `${data.label} by channel` : "By channel"}
        subtitle="Messages sent and the estimated cost, channel by channel."
        loading={loading && !data}
        className="@4xl:col-span-5"
        testId="md-comms-share"
      >
        <div className="space-y-4">
          <ChannelDonut blocks={shown} by="messages" />
          {channel !== "email" && shown.some((b) => b.cost > 0) && <ChannelDonut blocks={shown} by="cost" />}
        </div>
      </SectionCard>
      <SectionCard
        title="Messages sent by month"
        subtitle="Accepted by WhatsApp, 2Factor or Gmail, last 12 months."
        provenance={provOf(data, ["wa-messages", "sms-messages", "email-messages"])}
        loading={loading && !data}
        className="@4xl:col-span-7"
        testId="md-comms-messages"
      >
        <MessagesTrendChart series={series} channels={channels} />
      </SectionCard>
      <SectionCard
        title="Month by month"
        subtitle="Click a month to open it."
        loading={loading && !data}
        className="@4xl:col-span-5"
        testId="md-comms-months"
      >
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            rows={months}
            rowKey={(r) => r.month}
            pageSize={12}
            dense
            onRowClick={(r) => onMonth(r.month)}
            testId="md-comms-month-table"
          />
        </div>
      </SectionCard>
    </div>
  );
}
