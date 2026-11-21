// The message history: every message of the month (or a date range), newest first, with the count of each status, a
// search, and the purpose chosen in the breakdown. Contacts arrive masked; no message text is shown.

import type { UseQueryResult } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { Column } from "@/components/md/kit/DataTable";
import DataTable from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { clockText, dayShort, monthText } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, HISTORY_PAGE_SIZE, STATUS_HELP, rateText, type CommsState } from "./logic";
import { ChannelTag, Pager, RangeInputs, SearchBox, StatusSwitch } from "./parts";
import type { CommsHistory, HistoryItem, StatusGroup } from "./types";
import type { CommsUpdate } from "./queries";

const GROUP_CHIP: Record<StatusGroup, string> = {
  sent: "md-chip-success",
  delivered: "md-chip-success",
  failed: "md-chip-danger",
  skipped: "md-chip-warning",
  waiting: "md-chip-ink",
};

export function History({
  query,
  state,
  update,
  month,
}: {
  query: UseQueryResult<CommsHistory>;
  state: CommsState;
  update: CommsUpdate;
  month: string;
}) {
  const data = query.data;
  const all = state.channel === "all";
  const purposeLabel = data?.items.find((i) => i.purposeKey === state.purpose)?.purposeLabel ?? state.purpose;

  const columns: Column<HistoryItem>[] = [
    {
      key: "at",
      header: "When",
      cell: (r) => (
        <span className="block whitespace-nowrap">
          <span className="block font-semibold">{dayShort(r.at)}</span>
          <span className="block text-[11px] text-md-ink-soft">{clockText(r.at)}</span>
        </span>
      ),
    },
    {
      key: "recipient",
      header: "To",
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block font-semibold">
            {r.recipient}
            {r.recipientCode && (
              <span className="ml-1 text-[11px] font-medium text-md-ink-soft">{r.recipientCode}</span>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-md-ink-soft">
            {all && <ChannelTag channel={r.channel} />}
            <span>{r.typeLabel}</span>
            {r.contact && <span className="tabular-nums">{r.contact}</span>}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <span className="block">
          <span className={cn("md-chip", GROUP_CHIP[r.group])} title={STATUS_HELP[r.group]}>
            {r.statusLabel}
          </span>
          {r.error && (
            <span className="mt-1 block max-w-[16rem] truncate text-[11px] text-md-ink-soft" title={r.error}>
              {r.error}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "cost",
      header: "Est. cost",
      cell: (r) => (r.channel === "email" ? "No charge" : r.estimatedCost ? rateText(r.estimatedCost) : "₹0"),
      align: "right",
      className: "hidden @2xl:table-cell",
    },
  ];

  return (
    <SectionCard
      title="Message history"
      subtitle={
        data
          ? `${all ? "Every channel" : CHANNEL_LABEL[state.channel]}, ${data.period.preset === "this_month" ? "this month" : data.period.label}. Phone numbers and email addresses are masked.`
          : undefined
      }
      provenance={data?.provenance}
      loading={query.isPending}
      testId="md-comms-history"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
          <StatusSwitch
            value={state.status}
            onChange={(status) => update({ status })}
            counts={data?.statusCounts}
            channel={state.channel}
          />
          <RangeInputs
            from={state.from}
            to={state.to}
            onChange={(range) => update(range)}
            monthText={monthText(month || "2026-01")}
          />
          <SearchBox value={state.q} onChange={(q) => update({ q })} />
          {state.purpose && (
            <button
              type="button"
              className="md-chip md-chip-wine"
              onClick={() => update({ purpose: "" })}
              data-testid="md-comms-purpose-chip"
            >
              {purposeLabel}
              <X size={12} aria-label="Show every purpose" />
            </button>
          )}
        </div>
        {query.isError && <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />}
        {data && (
          <>
            <div className="overflow-x-auto">
              <DataTable
                columns={columns}
                rows={data.items}
                rowKey={(r) => r.id}
                pageSize={HISTORY_PAGE_SIZE}
                dense
                empty={
                  state.q || state.status || state.purpose
                    ? "No message matches these filters."
                    : "No message in this period."
                }
                testId="md-comms-history-table"
              />
            </div>
            <Pager
              page={data.page}
              pages={data.pages}
              total={data.total}
              pageSize={data.pageSize}
              onPage={(page) => update({ page })}
            />
          </>
        )}
      </div>
    </SectionCard>
  );
}
