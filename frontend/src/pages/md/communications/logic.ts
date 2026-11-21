// Pure logic of the Communication usage & cost page: the state in the address, labels, colours, the change chips and the
// rows the charts and tables draw. No React here (logic.test.ts covers it).

import { CHART } from "@/components/md/kit/chartTheme";
import { changeTone, inr, inrCompact, monthText, num, type Tone } from "@/lib/md/format";
import type {
  Change,
  Channel,
  ChannelBlock,
  ChannelFilter,
  CommsInsight,
  CommsOverview,
  DayRow,
  PurposeRow,
  SeriesPoint,
  StatusCounts,
  StatusGroup,
  TypeRow,
} from "./types";

export const CHANNELS: Channel[] = ["whatsapp", "sms", "email"];
export const CHANNEL_FILTERS: ChannelFilter[] = ["all", ...CHANNELS];
export const CHANNEL_LABEL: Record<ChannelFilter, string> = {
  all: "All channels",
  whatsapp: "WhatsApp",
  sms: "SMS",
  email: "Gmail",
};
/** One colour per channel, the same on every chart (wine, indigo, dusty rose: never a status colour). */
export const CHANNEL_COLOR: Record<Channel, string> = {
  whatsapp: CHART.brand,
  sms: CHART.deep,
  email: CHART.sky,
};
/** The channels that cost money (Gmail SMTP has no per-email charge). */
export const PAID_CHANNELS: Channel[] = ["whatsapp", "sms"];

export const STATUS_GROUPS: StatusGroup[] = ["sent", "delivered", "failed", "skipped", "waiting"];
export const STATUS_LABEL: Record<StatusGroup, string> = {
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  skipped: "Skipped",
  waiting: "Waiting",
};
export const STATUS_HELP: Record<StatusGroup, string> = {
  sent: "accepted by WhatsApp, 2Factor or Gmail",
  delivered: "WhatsApp only: delivered or read on the phone",
  failed: "the provider refused it, or it could not complete",
  skipped: "not sent on purpose: a limit, a switch, or too late",
  waiting: "still in the WhatsApp queue",
};

export const HISTORY_PAGE_SIZE = 25;

// ── the state in the address ─────────────────────────────────────────────────────────────────────────────────────

export type CommsState = {
  /** "YYYY-MM"; "" = this month */
  month: string;
  channel: ChannelFilter;
  /** history: a status group ("" = all) */
  status: StatusGroup | "";
  /** history: a custom date range ("" = the month) */
  from: string;
  to: string;
  q: string;
  page: number;
  /** history: one purpose (the HRMS module that sent it); needs a channel */
  purpose: string;
};

export type CommsPatch = Partial<CommsState>;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const positiveInt = (raw: string | null): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

export function parseCommsState(search: string): CommsState {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const month = p.get("month") ?? "";
  const channel = p.get("channel") as ChannelFilter | null;
  const status = p.get("status") as StatusGroup | null;
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  const rangeOk = DAY_RE.test(from) && DAY_RE.test(to) && from <= to;
  const ch = channel && CHANNEL_FILTERS.includes(channel) ? channel : "all";
  return {
    month: MONTH_RE.test(month) ? month : "",
    channel: ch,
    status: status && STATUS_GROUPS.includes(status) ? status : "",
    from: rangeOk ? from : "",
    to: rangeOk ? to : "",
    q: (p.get("q") ?? "").trim(),
    page: positiveInt(p.get("page")),
    purpose: ch === "all" ? "" : (p.get("purpose") ?? "").trim(),
  };
}

export function commsSearch(state: CommsState): string {
  const p = new URLSearchParams();
  if (state.month) p.set("month", state.month);
  if (state.channel !== "all") p.set("channel", state.channel);
  if (state.status) p.set("status", state.status);
  if (state.from && state.to) {
    p.set("from", state.from);
    p.set("to", state.to);
  }
  if (state.q) p.set("q", state.q);
  if (state.purpose && state.channel !== "all") p.set("purpose", state.purpose);
  if (state.page > 1) p.set("page", String(state.page));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** A change applied the way the page means it: a new month drops a custom history range; a new channel drops the
 *  purpose (it belongs to one channel); any history filter starts the list again at page 1. */
export function applyCommsPatch(state: CommsState, patch: CommsPatch): CommsState {
  const next: CommsState = { ...state, ...patch };
  const changed = (k: keyof CommsState) => k in patch && patch[k] !== state[k];
  if (changed("month") && !("from" in patch)) {
    next.from = "";
    next.to = "";
  }
  if (changed("channel") && !("purpose" in patch)) next.purpose = "";
  if (next.channel === "all") next.purpose = "";
  const listKeys: (keyof CommsState)[] = ["month", "channel", "status", "from", "to", "q", "purpose"];
  if (listKeys.some(changed) && !("page" in patch)) next.page = 1;
  next.page = Math.max(1, Math.floor(next.page || 1));
  return next;
}

/** The history request's parameters: the custom range when one is set, else the month (none = this month). */
export function historyParams(state: CommsState) {
  return {
    channel: state.channel,
    ...(state.from && state.to ? { from: state.from, to: state.to } : { month: state.month || undefined }),
    status: state.status || undefined,
    q: state.q || undefined,
    purpose: state.purpose || undefined,
    page: state.page,
    pageSize: HISTORY_PAGE_SIZE,
  };
}

// ── words and numbers ────────────────────────────────────────────────────────────────────────────────────────────

/** Rupees with paise: communication costs are small (a WhatsApp message is about 12 paise). */
export function rupees(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return Math.abs(value) >= 100000 ? inrCompact(value) : inr(value, 2);
}

/** A per-message rate keeps its finer digits: 0.115 -> "₹0.115", 0.2 -> "₹0.20". */
export function rateText(value: number | null | undefined): string {
  if (value == null) return "—";
  const [whole, frac = ""] = value.toFixed(4).replace(/0+$/, "").split(".");
  return `₹${whole}.${frac.padEnd(2, "0")}`;
}

/** A chart axis in rupees: whole rupees from 10 up, paise below. */
export function axisRupees(value: number): string {
  if (Math.abs(value) >= 100000) return inrCompact(value);
  if (Math.abs(value) >= 10) return inr(value, 0);
  return inr(value, value === 0 ? 0 : 2);
}

export type DeltaChipValue = { text: string; tone: Tone; direction: "up" | "down" | "flat" };

/**
 * The change chip of a figure against the month before: "+50% vs Oct", or the amount when the month before had none
 * ("+16 vs Oct"). `money` makes the amount rupees; `higherIsBetter` colours it (null = neutral: more messages is not good
 * or bad news by itself).
 */
export function changeChip(
  change: Change | undefined,
  previousMonth: string | undefined,
  { money = false, higherIsBetter = null }: { money?: boolean; higherIsBetter?: boolean | null } = {},
): DeltaChipValue | null {
  if (!change) return null;
  const direction = change.abs > 0 ? "up" : change.abs < 0 ? "down" : "flat";
  const sign = change.abs > 0 ? "+" : change.abs < 0 ? "-" : "";
  const amount = money ? rupees(Math.abs(change.abs)) : num(Math.abs(change.abs));
  const body =
    change.pct != null ? `${sign}${num(Math.abs(change.pct), Math.abs(change.pct) < 10 ? 1 : 0)}%` : `${sign}${amount}`;
  const vs = previousMonth ? ` vs ${monthText(previousMonth, true)}` : "";
  const tone = higherIsBetter == null ? "neutral" : changeTone(change.abs, higherIsBetter);
  return { text: `${body}${vs}`, tone, direction };
}

/** "projected for the month" or "the whole month", for the line under a change chip. */
export function basisText(basis: "projected" | "actual" | undefined, previousLabel: string | undefined): string {
  if (!previousLabel) return "";
  return basis === "projected"
    ? `This month at its current pace, against ${previousLabel}`
    : `Against ${previousLabel}`;
}

export const channelOf = (blocks: ChannelBlock[] | undefined, channel: Channel): ChannelBlock | undefined =>
  blocks?.find((b) => b.channel === channel);

export type HeadlineFigures = {
  channel: ChannelFilter;
  messages: number;
  failed: number;
  cost: number;
  projectedCost: number;
  projectedMessages: number;
  budget: number | null;
  budgetCost: number | null;
  budgetUsedPct: number | null;
  budgetChannels: Channel[];
  previous?: { month: string; label: string; messages: number; cost: number };
  change?: { messages: Change; cost: Change };
  changeBasis?: "projected" | "actual";
  /** Gmail alone: nothing here costs money */
  free: boolean;
  sparkMessages: number[];
  sparkCost: number[];
};

/** The four headline figures for the channel filter: the company's totals for "all", else that channel's own block (so
 *  every figure on the page follows the filter). */
export function headlineFigures(data: CommsOverview, channel: ChannelFilter): HeadlineFigures {
  if (channel === "all") {
    const t = data.totals;
    return {
      channel,
      messages: t.messages,
      failed: t.failed,
      cost: t.cost,
      projectedCost: t.projectedCost,
      projectedMessages: t.projectedMessages,
      budget: t.budget,
      budgetCost: t.budgetCost,
      budgetUsedPct: t.budgetUsedPct,
      budgetChannels: t.budgetChannels,
      previous: t.previous,
      change: t.change,
      changeBasis: t.changeBasis,
      free: false,
      sparkMessages: data.series.map((p) => p.messages),
      sparkCost: data.series.map((p) => p.cost),
    };
  }
  const b = channelOf(data.channels, channel);
  return {
    channel,
    messages: b?.messages ?? 0,
    failed: b?.failed ?? 0,
    cost: b?.cost ?? 0,
    projectedCost: b?.projectedCost ?? 0,
    projectedMessages: b?.projectedMessages ?? 0,
    budget: b?.budget ?? null,
    budgetCost: b?.budget != null ? b.cost : null,
    budgetUsedPct: b?.budgetUsedPct ?? null,
    budgetChannels: b?.budget != null ? [channel] : [],
    previous: b?.previous,
    change: b?.change,
    changeBasis: b?.changeBasis,
    free: b?.costBasis === "free",
    sparkMessages: data.series.map((p) => p[channel].messages),
    sparkCost: data.series.map((p) => p[channel].cost),
  };
}

/** The insights about the channel shown (company-wide ones always stay). */
export const insightsFor = (items: CommsInsight[], channel: ChannelFilter): CommsInsight[] =>
  channel === "all" ? items : items.filter((i) => !i.channel || i.channel === channel);

/** "WhatsApp 8 · SMS 3 · Gmail 5" */
export function perChannelText(blocks: ChannelBlock[], pick: (b: ChannelBlock) => string): string {
  return CHANNELS.map((c) => channelOf(blocks, c))
    .filter((b): b is ChannelBlock => !!b)
    .map((b) => `${CHANNEL_LABEL[b.channel]} ${pick(b)}`)
    .join(" · ");
}

/** The status groups a channel has: SMS and Gmail have no delivery receipt and no queue. */
export function statusGroupsFor(channel: ChannelFilter): StatusGroup[] {
  return channel === "sms" || channel === "email" ? ["sent", "failed", "skipped"] : STATUS_GROUPS;
}

/** The status switch of the history: "All 24", "Sent 16", ... (a group the channel lacks is left out). */
export function statusItems(counts: StatusCounts | undefined, channel: ChannelFilter) {
  const items: { value: StatusGroup | ""; label: string; count: number | null }[] = [
    { value: "", label: "All", count: counts?.total ?? null },
  ];
  for (const g of statusGroupsFor(channel))
    items.push({ value: g, label: STATUS_LABEL[g], count: counts?.[g] ?? null });
  return items;
}

// ── chart and table rows ─────────────────────────────────────────────────────────────────────────────────────────

/** 12 months of cost per channel (Gmail is always 0, so it is not drawn). */
export const costRows = (series: SeriesPoint[]) =>
  series.map((p) => ({ month: p.month, whatsapp: p.whatsapp.cost, sms: p.sms.cost, total: p.cost }));

/** 12 months of messages per channel, only the channels asked for. */
export const messageRows = (series: SeriesPoint[], channels: Channel[]) =>
  series.map((p) => {
    const row: Record<string, string | number> = { month: p.month };
    for (const c of channels) row[c] = p[c].messages;
    return row;
  });

export type MonthRow = {
  month: string;
  label: string;
  isCurrentMonth: boolean;
  whatsapp: number;
  sms: number;
  email: number;
  messages: number;
  cost: number;
  /** cost against the month before, % (null when the month before cost nothing, or it is the first month) */
  costChangePct: number | null;
};

/** The month-by-month table, newest first, with each month's cost against the month before. */
export function monthRows(series: SeriesPoint[]): MonthRow[] {
  const rows = series.map((p, i) => {
    const prev = series[i - 1];
    return {
      month: p.month,
      label: p.label,
      isCurrentMonth: p.isCurrentMonth,
      whatsapp: p.whatsapp.messages,
      sms: p.sms.messages,
      email: p.email.messages,
      messages: p.messages,
      cost: p.cost,
      costChangePct: prev && prev.cost ? Math.round(((p.cost - prev.cost) / prev.cost) * 1000) / 10 : null,
    };
  });
  return rows.reverse();
}

/** The days of the month with a label for the axis ("05"). */
export const dayRows = (days: DayRow[]) => days.map((d) => ({ ...d, day: d.date.slice(8, 10) }));

export const forChannel = <T extends { channel: Channel }>(rows: T[], channel: ChannelFilter): T[] =>
  channel === "all" ? rows : rows.filter((r) => r.channel === channel);

/** "8 sent · ₹1.44" under a purpose bar; Gmail rows say they are free. */
export function purposeSub(row: PurposeRow | TypeRow): string {
  const parts = [`${num(row.messages)} sent`];
  if (row.failed) parts.push(`${num(row.failed)} failed`);
  if (row.skipped) parts.push(`${num(row.skipped)} skipped`);
  return parts.join(" · ");
}

/** The purposes as ranked bars: by cost when anything in the list costs money, else by messages. */
export function purposeBars(rows: PurposeRow[], channel: ChannelFilter) {
  const list = forChannel(rows, channel);
  const byCost = list.some((r) => r.cost > 0);
  const sorted = [...list].sort((a, b) => (byCost ? b.cost - a.cost : 0) || b.messages - a.messages);
  return {
    byCost,
    items: sorted.map((r) => ({
      key: `${r.channel}:${r.key}`,
      channel: r.channel,
      purpose: r.key,
      label: channel === "all" ? `${r.label} (${CHANNEL_LABEL[r.channel]})` : r.label,
      value: byCost ? r.cost : r.messages,
      display: byCost ? rupees(r.cost) : `${num(r.messages)} sent`,
      sub: byCost ? purposeSub(r) : r.channel === "email" ? "No charge" : purposeSub(r),
      color: CHANNEL_COLOR[r.channel],
    })),
  };
}

/** What the page tells the assistant: the month, the channel and the headline figures. */
export function assistantSummary(
  blocks: ChannelBlock[],
  totals: { messages: number; cost: number; projectedCost: number; isCurrentMonth: boolean },
) {
  const summary: Record<string, string> = {
    "Messages sent": num(totals.messages),
    "Estimated cost (before GST)": rupees(totals.cost),
  };
  if (totals.isCurrentMonth) summary["Projected month cost"] = rupees(totals.projectedCost);
  for (const b of blocks) {
    summary[`${CHANNEL_LABEL[b.channel]}`] =
      `${num(b.messages)} sent, ${num(b.failed)} failed, ${b.costBasis === "free" ? "no charge" : rupees(b.cost)}`;
  }
  return summary;
}
