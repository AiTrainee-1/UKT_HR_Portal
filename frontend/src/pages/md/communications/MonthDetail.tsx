// The chosen month in detail: messages per day, what they were for (purpose), each message type, and WhatsApp's pricing
// categories with Meta's own figure. A purpose opens the history filtered to it.

import type { UseQueryResult } from "@tanstack/react-query";
import type { Column } from "@/components/md/kit/DataTable";
import BarList from "@/components/md/kit/BarList";
import DataTable from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { num } from "@/lib/md/format";
import { DailyChart } from "./charts";
import { CHANNEL_LABEL, CHANNELS, forChannel, purposeBars, rateText, rupees } from "./logic";
import { ChannelTag } from "./parts";
import type { CategoryRow, Channel, ChannelFilter, CommsMonth, TypeRow } from "./types";

export function MonthDetail({
  query,
  channel,
  onPurpose,
}: {
  query: UseQueryResult<CommsMonth>;
  channel: ChannelFilter;
  onPurpose: (channel: Channel, purpose: string) => void;
}) {
  const data = query.data;
  const loading = query.isPending;
  const channels: Channel[] = channel === "all" ? CHANNELS : [channel];
  const bars = purposeBars(data?.byPurpose ?? [], channel);
  const types = forChannel(data?.byType ?? [], channel);
  const showPricing = channel === "all" || channel === "whatsapp";
  const provenance = data?.provenance ?? [];
  const what = channel === "all" ? "every channel" : CHANNEL_LABEL[channel];

  const typeColumns: Column<TypeRow>[] = [
    {
      key: "label",
      header: "Message",
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block font-semibold">{r.label}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-md-ink-soft">
            {channel === "all" && <ChannelTag channel={r.channel} />}
            {r.purposeLabel !== r.label && <span>{r.purposeLabel}</span>}
          </span>
        </span>
      ),
      sortValue: (r) => r.label,
    },
    { key: "messages", header: "Sent", cell: (r) => num(r.messages), sortValue: (r) => r.messages, align: "right" },
    {
      key: "failed",
      header: "Failed",
      cell: (r) => num(r.failed),
      sortValue: (r) => r.failed,
      align: "right",
      className: "hidden @lg:table-cell",
    },
    {
      key: "skipped",
      header: "Skipped",
      cell: (r) => num(r.skipped),
      sortValue: (r) => r.skipped,
      align: "right",
      className: "hidden @2xl:table-cell",
    },
    {
      key: "cost",
      header: "Est. cost",
      cell: (r) => (r.channel === "email" ? "No charge" : rupees(r.cost)),
      sortValue: (r) => r.cost,
      align: "right",
    },
  ];

  const categoryColumns: Column<CategoryRow>[] = [
    { key: "label", header: "Category", cell: (r) => <span className="font-semibold">{r.label}</span> },
    { key: "messages", header: "Sent", cell: (r) => num(r.messages), align: "right" },
    { key: "billable", header: "Billable", cell: (r) => num(r.billable), align: "right" },
    { key: "rate", header: "Rate", cell: (r) => rateText(r.rate), align: "right", className: "hidden @lg:table-cell" },
    { key: "cost", header: "Est. cost", cell: (r) => rupees(r.cost), align: "right" },
  ];

  if (query.isError && !data) {
    return <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />;
  }

  return (
    <div className="space-y-4 @lg:space-y-5" data-testid="md-comms-detail">
      <h3 className="px-1 text-[15px] font-extrabold tracking-tight text-md-ink">
        {data ? `${data.label} in detail` : "The month in detail"}
        <span className="ml-2 text-xs font-semibold text-md-ink-soft">{what}</span>
      </h3>
      <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-12 @lg:gap-5">
        <SectionCard
          title="Messages per day"
          subtitle="Sent on each day of the month (accepted by the provider)."
          loading={loading}
          className="@4xl:col-span-7"
          testId="md-comms-days"
        >
          {data && <DailyChart days={data.days} channels={channels.filter((c) => data.channelsShown.includes(c))} />}
        </SectionCard>
        <SectionCard
          title="What they were for"
          subtitle={
            bars.byCost
              ? "Estimated cost by the HRMS module that sent them. Click one to see its messages."
              : "Messages by the HRMS module that sent them. Click one to see its messages."
          }
          provenance={provenance}
          provenanceIds={["wa-cost", "sms-cost", "email-cost"]}
          loading={loading}
          className="@4xl:col-span-5"
          testId="md-comms-purposes"
        >
          <BarList
            items={bars.items}
            onSelect={(item) => {
              const hit = bars.items.find((b) => b.key === item.key);
              if (hit) onPurpose(hit.channel, hit.purpose);
            }}
            emptyText="Nothing was sent this month."
            testId="md-comms-purpose-bars"
          />
        </SectionCard>
        <SectionCard
          title="By message type"
          subtitle="Every kind of message the HRMS sent this month, the costliest first."
          loading={loading}
          className={showPricing ? "@4xl:col-span-7" : "@4xl:col-span-12"}
          testId="md-comms-types"
        >
          <DataTable
            columns={typeColumns}
            rows={types}
            rowKey={(r) => `${r.channel}:${r.key}`}
            pageSize={8}
            dense
            empty="Nothing was sent this month."
            testId="md-comms-type-table"
          />
        </SectionCard>
        {showPricing && (
          <SectionCard
            title="WhatsApp pricing"
            subtitle="Meta charges per delivered template message by category. Rates before 18% GST, as set in WhatsApp Control."
            provenance={provenance}
            provenanceIds={["wa-cost"]}
            loading={loading}
            className="@4xl:col-span-5"
            testId="md-comms-pricing"
          >
            <div className="space-y-3">
              <DataTable
                columns={categoryColumns}
                rows={data?.byCategory ?? []}
                rowKey={(r) => r.key}
                dense
                empty="No WhatsApp message this month."
                testId="md-comms-category-table"
              />
              <p className="md-panel-sand p-3 text-xs leading-relaxed text-md-ink" data-testid="md-comms-meta">
                {data?.meta?.available
                  ? `Meta's own figure for the month: ${rupees(data.meta.cost)} for ${num(data.meta.volume)} messages (what Meta itself counts and charges).`
                  : (data?.meta?.error ??
                    "Meta's own figure is not available, so the estimate above is what the HRMS works out.")}
              </p>
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
}
