import { useRef } from "react";
import MdLayout from "@/components/md/MdLayout";
import { FilterBar } from "@/components/md/kit/FilterBar";
import MdPageHeader from "@/components/md/kit/MdPageHeader";
import { MonthPicker, thisMonthKey } from "@/components/md/kit/MonthPicker";
import { ErrorBanner, NoteBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { ChannelCards, HeadlineKpis, StandsOut } from "./communications/Headline";
import { History } from "./communications/History";
import { CHANNEL_LABEL, STATUS_LABEL, assistantSummary } from "./communications/logic";
import { MonthDetail } from "./communications/MonthDetail";
import { ChannelSwitch } from "./communications/parts";
import { useCommsData, useCommsState } from "./communications/queries";
import { Trends } from "./communications/Trends";

const scrollTo = (el: HTMLElement | null) => el?.scrollIntoView?.({ behavior: "smooth", block: "start" });

/**
 * Communication usage & cost (/md/communications): how much the HRMS uses WhatsApp, SMS and Gmail and what it costs. The
 * month's headline figures and one card per channel first, then twelve months of cost and messages, then the month in
 * detail (per day, per purpose, per message type) and the message history. Every figure is the HR Control pages' own
 * (WhatsApp Control, SMS Control, Gmail Control). Month, channel and the history's filters live in the address
 * (?month=&channel=&status=&from=&to=&q=&purpose=&page=), so a refresh or a shared link shows the same view.
 */
export default function MdCommunications() {
  const [state, update] = useCommsState();
  const { overview, detail, history, balance } = useCommsData(state);
  const data = overview.data;
  const month = state.month || data?.month || thisMonthKey();
  const max = data?.maxMonth;
  const detailRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const loading = overview.isPending;

  usePublishAssistantContext({
    page: "communications",
    title: "Communication usage & cost",
    filters: {
      Month: data?.label ?? month,
      Channel: CHANNEL_LABEL[state.channel],
      "History status": state.status ? STATUS_LABEL[state.status] : undefined,
      "History dates": state.from && state.to ? `${state.from} to ${state.to}` : undefined,
    },
    summary: data ? assistantSummary(data.channels, data.totals) : undefined,
  });

  return (
    <MdLayout>
      <div className="mx-auto max-w-[1500px] space-y-4 @lg:space-y-5" data-testid="md-comms">
        <MdPageHeader
          title="Communication usage & cost"
          subtitle="How many WhatsApp messages, SMS and emails the HRMS sends, and what they cost."
          updatedAt={data?.generatedAt}
        />
        <FilterBar>
          <MonthPicker value={month} max={max} onChange={(m) => update({ month: m === max ? "" : m })} />
          <ChannelSwitch value={state.channel} onChange={(channel) => update({ channel })} />
        </FilterBar>

        {overview.isError && !data && (
          <ErrorBanner message={describeMdError(overview.error)} onRetry={() => overview.refetch()} />
        )}
        {data?.notes.map((note) => (
          <NoteBanner key={note}>{note}</NoteBanner>
        ))}

        <HeadlineKpis data={data} loading={loading} channel={state.channel} />
        <ChannelCards
          data={data}
          loading={loading}
          balance={balance.data}
          channel={state.channel}
          onChannel={(channel) => update({ channel })}
        />
        <StandsOut data={data} loading={loading} channel={state.channel} />
        <Trends
          data={data}
          loading={loading}
          channel={state.channel}
          onMonth={(m) => {
            update({ month: m === max ? "" : m });
            scrollTo(detailRef.current);
          }}
        />
        <div ref={detailRef} className="scroll-mt-4">
          <MonthDetail
            query={detail}
            channel={state.channel}
            onPurpose={(channel, purpose) => {
              update({ channel, purpose });
              scrollTo(historyRef.current);
            }}
          />
        </div>
        <div ref={historyRef} className="scroll-mt-4">
          <History query={history} state={state} update={update} month={month} />
        </div>
      </div>
    </MdLayout>
  );
}
