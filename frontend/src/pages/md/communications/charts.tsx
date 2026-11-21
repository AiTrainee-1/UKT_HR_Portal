// The page's charts, all from the MD kit (TrendChart, DonutChart) with one colour per channel (logic.CHANNEL_COLOR).

import DonutChart from "@/components/md/kit/DonutChart";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { monthText, num } from "@/lib/md/format";
import { CHANNEL_COLOR, CHANNEL_LABEL, axisRupees, costRows, dayRows, messageRows, rupees } from "./logic";
import type { Channel, ChannelBlock, DayRow, SeriesPoint } from "./types";

const short = (month: string) => monthText(month, true);
/** Message counts are whole: a 1.5 tick (recharts' own choice on a small axis) gets no label instead of a second "2". */
const wholeTick = (v: number) => (Number.isInteger(v) ? num(v) : "");

/** Cost per month, WhatsApp and SMS stacked (Gmail has no charge, so it has no bar). */
export function CostTrendChart({ series, channels }: { series: SeriesPoint[]; channels: Channel[] }) {
  const paid = channels.filter((c) => c !== "email");
  const lines: TrendSeries[] = paid.map((c) => ({
    key: c,
    label: CHANNEL_LABEL[c],
    color: CHANNEL_COLOR[c],
    kind: "bar",
    stackId: "cost",
  }));
  return (
    <div data-testid="md-comms-cost-chart">
      <TrendChart
        data={costRows(series)}
        xKey="month"
        series={lines}
        height={230}
        xFormat={short}
        yFormat={axisRupees}
      />
    </div>
  );
}

/** Messages sent per month, one line per channel. */
export function MessagesTrendChart({ series, channels }: { series: SeriesPoint[]; channels: Channel[] }) {
  const lines: TrendSeries[] = channels.map((c) => ({
    key: c,
    label: CHANNEL_LABEL[c],
    color: CHANNEL_COLOR[c],
    kind: channels.length === 1 ? "area" : "line",
  }));
  return (
    <div data-testid="md-comms-messages-chart">
      <TrendChart
        data={messageRows(series, channels)}
        xKey="month"
        series={lines}
        height={230}
        xFormat={short}
        yFormat={wholeTick}
      />
    </div>
  );
}

/** The month's days: messages sent per channel, stacked. */
export function DailyChart({ days, channels }: { days: DayRow[]; channels: Channel[] }) {
  const bars: TrendSeries[] = channels.map((c) => ({
    key: c,
    label: CHANNEL_LABEL[c],
    color: CHANNEL_COLOR[c],
    kind: "bar",
    stackId: "day",
  }));
  return (
    <div data-testid="md-comms-daily-chart">
      <TrendChart data={dayRows(days)} xKey="day" series={bars} height={210} yFormat={wholeTick} />
    </div>
  );
}

/** The month's messages by channel, with the total in the middle. */
export function ChannelDonut({ blocks, by }: { blocks: ChannelBlock[]; by: "messages" | "cost" }) {
  const slices = blocks
    .filter((b) => by === "messages" || b.costBasis !== "free")
    .map((b) => ({
      name: CHANNEL_LABEL[b.channel],
      value: by === "cost" ? b.cost : b.messages,
      color: CHANNEL_COLOR[b.channel],
    }));
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  return (
    <DonutChart
      data={slices}
      format={by === "cost" ? rupees : (n) => num(n)}
      height={170}
      testId={`md-comms-donut-${by}`}
      center={
        <>
          <span className="text-lg font-black tabular-nums leading-none">
            {by === "cost" ? rupees(total) : num(total)}
          </span>
          <span className="mt-1 text-[11px] font-semibold text-md-ink-soft">
            {by === "cost" ? "estimated" : "sent"}
          </span>
        </>
      }
    />
  );
}
