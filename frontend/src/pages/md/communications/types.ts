// The Communication usage & cost page's contract with the server (backend api/md_portal/analytics/comms.py, routes at
// /api/md/comms/*). Money is rupees (2 places; a WhatsApp rate keeps 4), percentages 0-100, "no data" is null.

import type { MdEnvelope, MdInsightDto, MdPeriod } from "@/lib/md/types";

export type Channel = "whatsapp" | "sms" | "email";
export type ChannelFilter = "all" | Channel;
export type StatusGroup = "sent" | "delivered" | "failed" | "skipped" | "waiting";

export type Change = { abs: number; pct: number | null } | null;

/** One channel's month: the same keys for the three (a figure a channel does not have is null). */
export type ChannelBlock = {
  channel: Channel;
  label: string;
  provider: string;
  /** accepted by the provider (WhatsApp sent + delivered + read; SMS sent; email sent) */
  messages: number;
  /** every logged attempt (sent, failed, skipped, waiting) */
  attempts: number;
  /** WhatsApp only: delivered or read (SMS and SMTP have no receipt) */
  delivered: number | null;
  read?: number;
  failed: number;
  skipped: number;
  waiting: number;
  billable?: number;
  verified?: number;
  deliveryRate: number | null;
  readRate?: number | null;
  verifiedRate?: number | null;
  failureRate: number | null;
  projectedMessages: number;
  cost: number;
  costWithGst: number | null;
  projectedCost: number;
  projectedCostWithGst: number | null;
  gstRate: number | null;
  budget: number | null;
  budgetUsedPct: number | null;
  projectedBudgetPct: number | null;
  /** "estimate" (rates set in WhatsApp / SMS Control) or "free" (Gmail) */
  costBasis: "estimate" | "free";
  costNote: string;
  rates: Record<string, number> | null;
  previous?: { month: string; label: string; messages: number; cost: number };
  change?: { messages: Change; cost: Change };
  changeBasis?: "projected" | "actual";
  meta?: MetaFigure | null;
  peakDay?: { date: string; sent: number } | null;
  dailyLimit?: { value: number; source: string };
};

export type MetaFigure = { available: boolean; cost: number | null; volume: number | null; error: string | null };

export type SeriesPoint = {
  month: string;
  label: string;
  isCurrentMonth: boolean;
  messages: number;
  cost: number;
} & Record<Channel, { messages: number; cost: number; failed: number }>;

export type CommsInsight = MdInsightDto & { channel: Channel | null };

export type CommsTotals = {
  label: string;
  isCurrentMonth: boolean;
  daysElapsed: number;
  messages: number;
  attempts: number;
  failed: number;
  cost: number;
  projectedCost: number;
  projectedMessages: number;
  budget: number | null;
  budgetCost: number | null;
  budgetUsedPct: number | null;
  budgetChannels: Channel[];
  previous: { month: string; label: string; messages: number; cost: number };
  change: { messages: Change; cost: Change };
  changeBasis: "projected" | "actual";
};

/** GET /api/md/comms/overview?month=&months= */
export type CommsOverview = MdEnvelope & {
  month: string;
  label: string;
  isCurrentMonth: boolean;
  daysInMonth: number;
  daysElapsed: number;
  /** this month (IST): the latest month that can be picked */
  maxMonth: string;
  totals: CommsTotals;
  channels: ChannelBlock[];
  series: SeriesPoint[];
  insights: CommsInsight[];
  summary: string;
};

export type DayRow = { date: string; failed: number; total: number } & Partial<Record<Channel, number>>;

export type TypeRow = {
  channel: Channel;
  key: string;
  label: string;
  purposeKey: string;
  purposeLabel: string;
  messages: number;
  failed: number;
  skipped: number;
  billable: number | null;
  verified?: number;
  cost: number;
};

export type PurposeRow = {
  channel: Channel;
  key: string;
  label: string;
  messages: number;
  failed: number;
  skipped: number;
  cost: number;
  types: number;
};

export type CategoryRow = {
  key: string;
  label: string;
  messages: number;
  billable: number;
  rate: number;
  cost: number;
};

/** GET /api/md/comms/month?month=&channel= */
export type CommsMonth = MdEnvelope & {
  month: string;
  label: string;
  channel: ChannelFilter;
  channelsShown: Channel[];
  isCurrentMonth: boolean;
  daysInMonth: number;
  daysElapsed: number;
  channels: ChannelBlock[];
  days: DayRow[];
  byPurpose: PurposeRow[];
  byType: TypeRow[];
  byCategory: CategoryRow[];
  meta: MetaFigure | null;
};

export type HistoryItem = {
  id: string;
  channel: Channel;
  /** factory wall clock, "2026-11-05T10:42:10" */
  at: string;
  recipient: string;
  recipientCode: string | null;
  /** masked: "••••••1234", "ab•••@gmail.com" */
  contact: string;
  typeLabel: string;
  purposeKey: string;
  purposeLabel: string;
  status: string;
  statusLabel: string;
  group: StatusGroup;
  error: string;
  pricingCategory: string | null;
  estimatedCost: number;
};

export type StatusCounts = {
  sent: number;
  delivered: number | null;
  failed: number;
  skipped: number;
  waiting: number;
  total: number;
};

/** GET /api/md/comms/history?channel=&month= | from=&to= &status=&q=&purpose=&page=&pageSize= */
export type CommsHistory = MdEnvelope & {
  period: MdPeriod;
  channel: ChannelFilter;
  status: StatusGroup | null;
  purpose: string | null;
  q: string;
  items: HistoryItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  statusCounts: StatusCounts;
  channelCounts: Partial<Record<Channel, Record<StatusGroup, number>>>;
};

/** GET /api/md/comms/sms-balance */
export type SmsBalance = MdEnvelope & {
  credits: number | null;
  checkedAt: string | null;
  error: string | null;
  lowCredits: number;
  isLow: boolean;
};
