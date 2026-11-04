// hod-reminders: hooks/types for the HoD's and Notify sub-tabs of the Requests page (/hr/requests?tab=hods|notify),
// see ./index.ts.
//
// HoD's shows every active Department Head (DepartmentManager) and what is pending WITH them: exactly what that head's
// mobile Approvals tab counts as "mine" (backend/api/mobile_approvals_views.py), per category. Notify is the automatic
// reminder to every head with something pending, on the times / weekdays HR picks, by WhatsApp, email and mobile push.
// The server answers:
//
//   GET  /api/hr/hod-pending?branchId=&departmentId=&search=&onlyPending=1   the board (heads x categories) and the detail
//   GET  /api/hr/hod-reminders/settings      schedule, channels, template, next / last run, channel availability, canEdit
//   PUT  /api/hr/hod-reminders/settings      any subset of {enabled, times, days, channels, template}; a problem is 400
//                                            {"error": "<one sentence>"}; a branch-limited login gets 403
//                                            {"error", "code": "company_wide_rule"} (the schedule is company-wide)
//   POST /api/hr/hod-reminders/preview       {template?} -> {messages: [{managerId, name, pending, text}]}; nothing is sent
//   POST /api/hr/hod-reminders/send          {managerIds?, channels?} -> 202 {run}; the run is processed in the background
//   GET  /api/hr/hod-reminders/runs          {items, total, page, pageSize}
//   GET  /api/hr/hod-reminders/runs/<id>     one run, with its deliveries
//
// Every answer is read leniently (read* below): a key an older or newer server leaves out shows as "unknown" instead of
// crashing the page.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

// ── the board ─────────────────────────────────────────────────────────────────

export type HodCategory = { key: string; label: string };

export type HodPendingItem = {
  category: string;
  categoryLabel: string;
  id: number;
  employeeId: number | null;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  /** The day(s) it is for: "05 Nov 2026", "05 - 07 Nov 2026", "Morning Late-In · 05 Nov". */
  forText: string;
  /** What was asked, short: "Casual Leave · First half", "Leave · 2 days". */
  summary: string;
  raisedAt: string | null;
  waitingDays: number | null;
  /** The HR portal address that opens it: /hr/requests?kind=<k>&focus=<id>. */
  openPath: string;
};

export type HodRow = {
  managerId: number;
  employeeId: number | null;
  code: string;
  name: string;
  designation: string | null;
  departments: string[];
  branch: string | null;
  phone: string | null;
  email: string | null;
  /** Phones registered for push notifications. */
  devices: number;
  pending: number;
  /** null: the head is not allowed to decide that category at all (shown as "—", never as 0). */
  byCategory: Record<string, number | null>;
  oldestPendingAt: string | null;
  oldestDays: number | null;
  /** Oldest first. */
  items: HodPendingItem[];
};

export type HodPendingTotals = {
  hods: number;
  withPending: number;
  pending: number;
  byCategory: Record<string, number>;
};

export type HodPending = {
  generatedAt: string | null;
  /** In display order. */
  categories: HodCategory[];
  totals: HodPendingTotals;
  /** Pending first (most first), then by name. */
  hods: HodRow[];
};

export type HodPendingParams = {
  branchId?: string;
  departmentId?: string;
  search?: string;
  onlyPending?: boolean;
};

// ── the reminder ──────────────────────────────────────────────────────────────

export type HodChannel = "whatsapp" | "email" | "push";
export const HOD_CHANNELS: readonly HodChannel[] = ["whatsapp", "email", "push"];
export type HodChannelSwitches = Record<HodChannel, boolean>;
export type HodChannelStatus = { available: boolean; note: string };

/** pending: not tried yet (the run is still going). off: the channel was switched off for the run. */
export type HodDeliveryStatus = "pending" | "sent" | "failed" | "skipped" | "off";
export type HodChannelDelivery = { status: HodDeliveryStatus; note: string };
export type HodChannelCount = { sent: number; failed: number; skipped: number };

export type HodDelivery = {
  managerId: number;
  name: string;
  pending: number;
  byCategory: Record<string, number | null>;
  text: string;
} & Record<HodChannel, HodChannelDelivery>;

export type HodRunStatus = "running" | "done" | "failed";

export type HodRun = {
  id: number;
  trigger: "schedule" | "manual";
  /** The scheduled time it was for ("10:00"); null for a manual send. */
  slot: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  status: HodRunStatus;
  sentBy: string | null;
  /** Why a failed run stopped. */
  error: string | null;
  hods: number;
  counts: Record<HodChannel, HodChannelCount>;
  /** Only on GET /runs/<id>. */
  deliveries?: HodDelivery[];
};

export type HodReminderSettings = {
  enabled: boolean;
  /** "HH:MM", India time. */
  times: string[];
  /** 0 = Monday ... 6 = Sunday. */
  days: number[];
  channels: HodChannelSwitches;
  onlyWithPending: boolean;
  template: string;
  defaultTemplate: string;
  nextRunAt: string | null;
  lastRun: HodRun | null;
  channelStatus: Record<HodChannel, HodChannelStatus>;
  canEdit: boolean;
  companyWide: boolean;
};

export type HodReminderSettingsInput = Partial<
  Pick<HodReminderSettings, "enabled" | "times" | "days" | "channels" | "template">
>;

export type HodPreviewMessage = { managerId: number; name: string; pending: number; text: string };

export type HodRunPage = { items: HodRun[]; total: number; page: number; pageSize: number };

export type HodSendInput = { managerIds?: number[]; channels?: HodChannelSwitches };

// ── reading the answers leniently ─────────────────────────────────────────────

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function counts(raw: unknown, allowNull: true): Record<string, number | null>;
function counts(raw: unknown, allowNull: false): Record<string, number>;
function counts(raw: unknown, allowNull: boolean): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(obj(raw))) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (allowNull && v === null) out[k] = null;
  }
  return out;
}

function readItem(raw: unknown): HodPendingItem | null {
  const r = obj(raw);
  if (typeof r.id !== "number" || !str(r.category)) return null;
  return {
    category: str(r.category),
    categoryLabel: str(r.categoryLabel) || str(r.category),
    id: r.id,
    employeeId: numOrNull(r.employeeId),
    employeeCode: str(r.employeeCode),
    employeeName: str(r.employeeName),
    department: strOrNull(r.department),
    forText: str(r.forText),
    summary: str(r.summary),
    raisedAt: strOrNull(r.raisedAt),
    waitingDays: numOrNull(r.waitingDays),
    openPath: str(r.openPath),
  };
}

function readRow(raw: unknown): HodRow | null {
  const r = obj(raw);
  if (typeof r.managerId !== "number") return null;
  const items = list(r.items)
    .map(readItem)
    .filter((i): i is HodPendingItem => i !== null);
  return {
    managerId: r.managerId,
    employeeId: numOrNull(r.employeeId),
    code: str(r.code),
    name: str(r.name) || `HoD #${r.managerId}`,
    designation: strOrNull(r.designation),
    departments: list(r.departments).filter((d): d is string => typeof d === "string" && d !== ""),
    branch: strOrNull(r.branch),
    phone: strOrNull(r.phone),
    email: strOrNull(r.email),
    devices: num(r.devices),
    pending: typeof r.pending === "number" ? r.pending : items.length,
    byCategory: counts(r.byCategory, true),
    oldestPendingAt: strOrNull(r.oldestPendingAt),
    oldestDays: numOrNull(r.oldestDays),
    items,
  };
}

/** The board with every key present. */
export function readHodPending(raw: unknown): HodPending {
  const r = obj(raw);
  const t = obj(r.totals);
  const hods = list(r.hods)
    .map(readRow)
    .filter((h): h is HodRow => h !== null);
  const categories = list(r.categories)
    .map((c) => obj(c))
    .filter((c) => str(c.key) !== "")
    .map((c) => ({ key: str(c.key), label: str(c.label) || str(c.key) }));
  return {
    generatedAt: strOrNull(r.generatedAt),
    categories,
    totals: {
      hods: typeof t.hods === "number" ? t.hods : hods.length,
      withPending: typeof t.withPending === "number" ? t.withPending : hods.filter((h) => h.pending > 0).length,
      pending: typeof t.pending === "number" ? t.pending : hods.reduce((sum, h) => sum + h.pending, 0),
      byCategory: counts(t.byCategory, false),
    },
    hods,
  };
}

const DELIVERY_STATUSES: readonly HodDeliveryStatus[] = ["pending", "sent", "failed", "skipped", "off"];

function readChannelDelivery(raw: unknown): HodChannelDelivery {
  const r = obj(raw);
  const status = DELIVERY_STATUSES.includes(r.status as HodDeliveryStatus) ? (r.status as HodDeliveryStatus) : "off";
  return { status, note: str(r.note) };
}

function readCount(raw: unknown): HodChannelCount {
  const r = obj(raw);
  return { sent: num(r.sent), failed: num(r.failed), skipped: num(r.skipped) };
}

/** One run (null when it is not one). */
export function readHodRun(raw: unknown): HodRun | null {
  const r = obj(raw);
  if (typeof r.id !== "number") return null;
  const c = obj(r.counts);
  const run: HodRun = {
    id: r.id,
    trigger: r.trigger === "schedule" ? "schedule" : "manual",
    slot: strOrNull(r.slot),
    startedAt: strOrNull(r.startedAt),
    finishedAt: strOrNull(r.finishedAt),
    status: r.status === "running" || r.status === "failed" ? r.status : "done",
    sentBy: strOrNull(r.sentBy),
    error: strOrNull(r.error),
    hods: num(r.hods),
    counts: { whatsapp: readCount(c.whatsapp), email: readCount(c.email), push: readCount(c.push) },
  };
  if (Array.isArray(r.deliveries)) {
    run.deliveries = r.deliveries
      .map((d) => obj(d))
      .filter((d) => typeof d.managerId === "number")
      .map((d) => ({
        managerId: d.managerId as number,
        name: str(d.name),
        pending: num(d.pending),
        byCategory: counts(d.byCategory, true),
        text: str(d.text),
        whatsapp: readChannelDelivery(d.whatsapp),
        email: readChannelDelivery(d.email),
        push: readChannelDelivery(d.push),
      }));
  }
  return run;
}

export function readHodRunPage(raw: unknown): HodRunPage {
  const r = obj(raw);
  const items = list(r.items)
    .map(readHodRun)
    .filter((x): x is HodRun => x !== null);
  return {
    items,
    total: typeof r.total === "number" ? r.total : items.length,
    page: typeof r.page === "number" && r.page > 0 ? r.page : 1,
    pageSize: typeof r.pageSize === "number" && r.pageSize > 0 ? r.pageSize : Math.max(items.length, 1),
  };
}

function readChannelStatus(raw: unknown): HodChannelStatus {
  const r = obj(raw);
  // unknown availability is shown as available: the run itself reports a channel that could not deliver
  return { available: r.available !== false, note: str(r.note) };
}

/** The settings with every key present. Channels default ON and days to Mon-Sat, as the server's defaults. */
export function readHodSettings(raw: unknown): HodReminderSettings {
  const r = obj(raw);
  const ch = obj(r.channels);
  const cs = obj(r.channelStatus);
  const days = list(r.days).filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6);
  return {
    enabled: r.enabled === true,
    times: list(r.times).filter((t): t is string => typeof t === "string" && t !== ""),
    days: Array.isArray(r.days) ? [...new Set(days)].sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5],
    channels: { whatsapp: ch.whatsapp !== false, email: ch.email !== false, push: ch.push !== false },
    onlyWithPending: r.onlyWithPending !== false,
    template: str(r.template),
    defaultTemplate: str(r.defaultTemplate),
    nextRunAt: strOrNull(r.nextRunAt),
    lastRun: readHodRun(r.lastRun),
    channelStatus: {
      whatsapp: readChannelStatus(cs.whatsapp),
      email: readChannelStatus(cs.email),
      push: readChannelStatus(cs.push),
    },
    // an older answer without the flag is editable: the server still refuses what it must
    canEdit: r.canEdit !== false,
    companyWide: r.companyWide !== false,
  };
}

export function readHodPreview(raw: unknown): HodPreviewMessage[] {
  return list(obj(raw).messages)
    .map((m) => obj(m))
    .filter((m) => typeof m.managerId === "number")
    .map((m) => ({ managerId: m.managerId as number, name: str(m.name), pending: num(m.pending), text: str(m.text) }));
}

// ── hooks ─────────────────────────────────────────────────────────────────────

export const HOD_PENDING_KEY = "/api/hr/hod-pending";
const REMINDERS = "/api/hr/hod-reminders";
export const HOD_SETTINGS_KEY = `${REMINDERS}/settings`;
export const HOD_PREVIEW_KEY = `${REMINDERS}/preview`;
export const HOD_RUNS_KEY = `${REMINDERS}/runs`;

/** The query string of the board ("onlyPending=1" only when asked). */
export function hodPendingQuery(params: HodPendingParams): string {
  const qs = new URLSearchParams();
  if (params.branchId) qs.set("branchId", params.branchId);
  if (params.departmentId) qs.set("departmentId", params.departmentId);
  if (params.search?.trim()) qs.set("search", params.search.trim());
  if (params.onlyPending) qs.set("onlyPending", "1");
  return qs.toString();
}

/** The board. Refreshes every minute; a filter change keeps the old board on screen until the new one is in. */
export const useHodPending = (params: HodPendingParams = {}, options: { enabled?: boolean } = {}) =>
  useQuery<HodPending>({
    queryKey: [HOD_PENDING_KEY, params],
    queryFn: async () => {
      const qs = hodPendingQuery(params);
      return readHodPending(await customFetch<unknown>(`${HOD_PENDING_KEY}${qs ? `?${qs}` : ""}`));
    },
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });

export const useHodReminderSettings = () =>
  useQuery<HodReminderSettings>({
    queryKey: [HOD_SETTINGS_KEY],
    queryFn: async () => readHodSettings(await customFetch<unknown>(HOD_SETTINGS_KEY)),
    // the next / last run move on by themselves
    refetchInterval: 60_000,
  });

/** Saves a subset of the settings and puts the answer (the settings as they now are) in the cache. */
export const useUpdateHodReminderSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: HodReminderSettingsInput): Promise<HodReminderSettings> => {
      const answer = await customFetch<unknown>(HOD_SETTINGS_KEY, { method: "PUT", body: JSON.stringify(body) });
      // an answer that is not the settings is followed by a read, so the cache never holds anything else
      if (answer && typeof answer === "object" && Array.isArray((answer as Loose).times))
        return readHodSettings(answer);
      return readHodSettings(await customFetch<unknown>(HOD_SETTINGS_KEY));
    },
    onSuccess: (data) => {
      queryClient.setQueryData([HOD_SETTINGS_KEY], data);
      void queryClient.invalidateQueries({ queryKey: [HOD_PREVIEW_KEY] });
    },
  });
};

/** What each head would get now, with `template` (the saved one when null). A POST, but nothing is sent. */
export const useHodReminderPreview = (template: string | null, options: { enabled?: boolean } = {}) =>
  useQuery<HodPreviewMessage[]>({
    queryKey: [HOD_PREVIEW_KEY, template],
    queryFn: async () =>
      readHodPreview(
        await customFetch<unknown>(HOD_PREVIEW_KEY, {
          method: "POST",
          body: JSON.stringify(template === null ? {} : { template }),
        }),
      ),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });

/** Starts a run now. The answer comes back at once (202) with the run, which is then processed in the background. */
export const useSendHodReminders = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: HodSendInput): Promise<HodRun> => {
      const answer = obj(
        await customFetch<unknown>(`${REMINDERS}/send`, { method: "POST", body: JSON.stringify(body) }),
      );
      const run = readHodRun(answer.run ?? answer);
      if (!run) throw new Error("The server did not say which run it started.");
      return run;
    },
    onSuccess: (run) => {
      queryClient.setQueryData([HOD_RUNS_KEY, run.id], run);
      void queryClient.invalidateQueries({ queryKey: [HOD_RUNS_KEY, "page"] });
    },
  });
};

/** The run history, newest first. Polls faster while a run on the page is still going. */
export const useHodReminderRuns = (page: number, pageSize: number) =>
  useQuery<HodRunPage>({
    queryKey: [HOD_RUNS_KEY, "page", { page, pageSize }],
    queryFn: async () =>
      readHodRunPage(await customFetch<unknown>(`${HOD_RUNS_KEY}?page=${page}&pageSize=${pageSize}`)),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === "running") ? 3_000 : 30_000),
  });

/** One run with its deliveries; polled every 2 s while it is still running. `id` null asks for nothing. */
export const useHodReminderRun = (id: number | null) =>
  useQuery<HodRun | null>({
    queryKey: [HOD_RUNS_KEY, id],
    queryFn: async () => readHodRun(await customFetch<unknown>(`${HOD_RUNS_KEY}/${id}`)),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2_000 : false),
  });
