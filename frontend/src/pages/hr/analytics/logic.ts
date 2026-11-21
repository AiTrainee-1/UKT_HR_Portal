import type { Tone } from "@/lib/statusTones";
import type {
  AnalyticsRecord,
  AnalyticsSummary,
  AnalyticsTab,
  CategoryMeta,
  DepartmentOption,
  DepartmentRow,
  EmployeeHit,
  HodRow,
  Level,
  Pattern,
  WeeklyPoint,
} from "./types";

// HR Analytics (owner 2026-11-21): the pure part of the page. Filters <-> address, the period presets, levels and their
// colours, the category cards, the attention list (search, sort, pages), the insights, the chart rows and the drill-down
// helpers. Nothing here fetches or renders, so all of it is unit-tested.

// ── Dates (ISO days, never through `new Date("2026-11-20")`, which is UTC midnight) ─────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** Monday first: the server's `byWeekday` keys, in the order the bars are drawn. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const WEEKDAYS_LONG: Record<string, string> = {
  Mon: "Mondays",
  Tue: "Tuesdays",
  Wed: "Wednesdays",
  Thu: "Thursdays",
  Fri: "Fridays",
  Sat: "Saturdays",
  Sun: "Sundays",
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of a Date as "2026-11-21". */
export const isoOf = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** "2026-11-21" -> a local Date at midnight; anything that is not a real day -> null ("2026-02-30" included). */
export function fromIso(iso: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isoOf(d) === iso ? d : null;
}

export const isIso = (iso: string | null | undefined): iso is string => fromIso(iso) !== null;

export function addDays(iso: string, days: number): string {
  const d = fromIso(iso)!;
  d.setDate(d.getDate() + days);
  return isoOf(d);
}

/** The Monday of the week (Mon-Sun) the day falls in. */
export function mondayOf(iso: string): string {
  const d = fromIso(iso)!;
  return addDays(iso, -((d.getDay() + 6) % 7));
}

export const sundayOf = (iso: string): string => addDays(mondayOf(iso), 6);
export const monthStart = (year: number, month: number): string => `${year}-${pad2(month)}-01`;
export const monthEnd = (year: number, month: number): string => isoOf(new Date(year, month, 0));
const minIso = (a: string, b: string) => (a <= b ? a : b);

/** "Mon" for an ISO day. */
export function weekdayOf(iso: string): string {
  const d = fromIso(iso);
  return d ? WEEKDAYS[(d.getDay() + 6) % 7] : "";
}

/** "20 Nov". */
export function dayMonth(iso: string | null | undefined): string {
  const d = fromIso(iso);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : "-";
}

/** "20 Nov 2026". */
export function dateShort(iso: string | null | undefined): string {
  const d = fromIso(iso);
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : "-";
}

/** "1 Nov - 21 Nov 2026"; one day alone; both years when the range crosses a new year. */
export function rangeLabel(from: string, to: string): string {
  const a = fromIso(from);
  const b = fromIso(to);
  if (!a || !b) return "";
  if (from === to) return dateShort(from);
  if (a.getFullYear() !== b.getFullYear()) return `${dateShort(from)} - ${dateShort(to)}`;
  return `${dayMonth(from)} - ${dateShort(to)}`;
}

/** Days into runs of consecutive days: ["2026-11-03", "2026-11-04", "2026-11-09"] -> 3-4 Nov, 9 Nov. */
export function dayRuns(days: string[]): { from: string; to: string }[] {
  const sorted = [...new Set(days.filter(isIso))].sort();
  const out: { from: string; to: string }[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === d) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
}

/** The calm note under the period when the devices sent nothing on some days: "5 days left out: no punches arrived
 *  from the devices (3 Nov - 5 Nov, 9 Nov, 11 Nov)". At most four runs are named. */
export function dataGapNote(days: string[] | null | undefined): string | null {
  const runs = dayRuns(days ?? []);
  if (runs.length === 0) return null;
  const count = runs.reduce(
    (n, r) => n + Math.round((fromIso(r.to)!.getTime() - fromIso(r.from)!.getTime()) / 864e5) + 1,
    0,
  );
  const named = runs
    .slice(0, 4)
    .map((r) => (r.from === r.to ? dayMonth(r.from) : `${dayMonth(r.from)} - ${dayMonth(r.to)}`));
  const more = runs.length > 4 ? ` and ${plural(runs.length - 4, "more run")}` : "";
  return `${plural(count, "day")} left out: no punches arrived from the devices (${named.join(", ")}${more})`;
}

/** "20 Nov 2026, 4:05 pm" for an ISO date-time; "" when there is none. */
export function dateTimeText(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── The period ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type PeriodPreset = "this_month" | "last_month" | "this_week" | "last_week" | "month" | "week" | "custom";

export const QUICK_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_week", label: "This week" },
  { value: "last_week", label: "Last week" },
];

const PRESETS = new Set<PeriodPreset>([
  "this_month",
  "last_month",
  "this_week",
  "last_week",
  "month",
  "week",
  "custom",
]);
export const parsePreset = (v: string | null | undefined): PeriodPreset =>
  PRESETS.has(v as PeriodPreset) ? (v as PeriodPreset) : "this_month";

export type ResolvedPeriod = { preset: PeriodPreset; from: string; to: string };

/**
 * The days a period covers, as of `today`. Quick picks follow the calendar (a shared "This week" link is this week when
 * it is opened); a picked month / week / custom range is fixed by its `from` (and `to`). A month or a week still running
 * ends today, like the server's own clamp. A picked period that is not a real day, or starts after today, falls back to
 * its nearest quick pick, so a bad link still opens a sensible page.
 */
export function resolvePeriod(preset: PeriodPreset, rawFrom: string, rawTo: string, today: string): ResolvedPeriod {
  const t = fromIso(today)!;
  const y = t.getFullYear();
  const m = t.getMonth() + 1;
  switch (preset) {
    case "last_month": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { preset, from: monthStart(py, pm), to: monthEnd(py, pm) };
    }
    case "this_week":
      return { preset, from: mondayOf(today), to: today };
    case "last_week": {
      const from = addDays(mondayOf(today), -7);
      return { preset, from, to: addDays(from, 6) };
    }
    case "month": {
      const d = fromIso(rawFrom);
      if (!d) break;
      const from = monthStart(d.getFullYear(), d.getMonth() + 1);
      if (from > today) break;
      return { preset, from, to: minIso(monthEnd(d.getFullYear(), d.getMonth() + 1), today) };
    }
    case "week": {
      if (!isIso(rawFrom)) return resolvePeriod("this_week", "", "", today);
      const from = mondayOf(rawFrom);
      if (from > today) return resolvePeriod("this_week", "", "", today);
      return { preset, from, to: minIso(addDays(from, 6), today) };
    }
    case "custom": {
      if (!isIso(rawFrom) || !isIso(rawTo)) break;
      let [from, to] = rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];
      to = minIso(to, today);
      from = minIso(from, to);
      return { preset, from, to };
    }
    default:
      break;
  }
  return { preset: "this_month", from: monthStart(y, m), to: today };
}

/** What the period button says: "This month", "October 2026", "Week of 10 Nov", "Custom range". */
export function presetLabel(p: ResolvedPeriod): string {
  const quick = QUICK_PRESETS.find((q) => q.value === p.preset);
  if (quick) return quick.label;
  const d = fromIso(p.from)!;
  if (p.preset === "month") return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
  if (p.preset === "week") return `Week of ${dayMonth(p.from)}`;
  return "Custom range";
}

/** The address of a period: a quick pick is its name alone, a picked one carries its days. */
export function periodToUrl(p: ResolvedPeriod): { period: string; from: string; to: string } {
  if (p.preset === "month" || p.preset === "week" || p.preset === "custom")
    return { period: p.preset, from: p.from, to: p.to };
  return { period: p.preset, from: "", to: "" };
}

// ── Filters <-> the address ─────────────────────────────────────────────────────────────────────────────────────────

export type AnalyticsUrl = {
  tab: string;
  period: string;
  from: string;
  to: string;
  dept: string;
  emp: string;
  q: string;
  /** The category drill-down that is open. */
  cat: string;
  /** The employee drill-down that is open. */
  person: string;
};

/** A module constant: useUrlParams leaves a default out of the address. */
export const URL_DEFAULTS: AnalyticsUrl = {
  tab: "staff",
  period: "this_month",
  from: "",
  to: "",
  dept: "",
  emp: "",
  q: "",
  cat: "",
  person: "",
};

export type Filters = {
  tab: AnalyticsTab;
  period: ResolvedPeriod;
  dept: number | null;
  emp: number | null;
  q: string;
};

export type PageState = Filters & { cat: string | null; person: number | null };

const positiveId = (v: string | null | undefined): number | null => {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 ? n : null;
};

export const parseTab = (v: string | null | undefined): AnalyticsTab => (v === "production" ? "production" : "staff");

export function stateFromUrl(url: Partial<AnalyticsUrl>, today: string): PageState {
  return {
    tab: parseTab(url.tab),
    period: resolvePeriod(parsePreset(url.period), url.from ?? "", url.to ?? "", today),
    dept: positiveId(url.dept),
    emp: positiveId(url.emp),
    q: (url.q ?? "").slice(0, 100),
    cat: url.cat ? url.cat : null,
    person: positiveId(url.person),
  };
}

export function stateToUrl(s: Partial<PageState>): Partial<AnalyticsUrl> {
  const out: Partial<AnalyticsUrl> = {};
  if (s.tab !== undefined) out.tab = s.tab;
  if (s.period !== undefined) Object.assign(out, periodToUrl(s.period));
  if (s.dept !== undefined) out.dept = s.dept ? String(s.dept) : "";
  if (s.emp !== undefined) out.emp = s.emp ? String(s.emp) : "";
  if (s.q !== undefined) out.q = s.q.trim();
  if (s.cat !== undefined) out.cat = s.cat ?? "";
  if (s.person !== undefined) out.person = s.person ? String(s.person) : "";
  return out;
}

/** The address query string of a state (defaults left out), and back: the round trip a shared link takes. */
export function toSearch(s: PageState): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(stateToUrl(s)) as [keyof AnalyticsUrl, string][]) {
    if (value && value !== URL_DEFAULTS[key]) params.set(key, value);
  }
  return params.toString();
}

export function fromSearch(search: string, today: string): PageState {
  const params = new URLSearchParams(search);
  const url: Partial<AnalyticsUrl> = {};
  for (const key of Object.keys(URL_DEFAULTS) as (keyof AnalyticsUrl)[]) url[key] = params.get(key) ?? "";
  return stateFromUrl(url, today);
}

/** The query of the summary and category endpoints: every filter of the page. */
export function serverParams(f: Filters): Record<string, string> {
  const out: Record<string, string> = { type: f.tab, from: f.period.from, to: f.period.to };
  if (f.dept) out.departmentId = String(f.dept);
  if (f.emp) out.employeeId = String(f.emp);
  if (f.q.trim()) out.q = f.q.trim();
  return out;
}

/** The employee endpoint ignores the department and the search: only the tab and the period matter there. */
export const employeeParams = (f: Filters): Record<string, string> => ({
  type: f.tab,
  from: f.period.from,
  to: f.period.to,
});

export function filtersActive(f: Filters): boolean {
  return f.dept !== null || f.emp !== null || f.q.trim() !== "" || f.period.preset !== "this_month";
}

/** The departments a tab offers (its own category, or none given), plus the picked one when it belongs to the other tab,
 *  so a filter kept across a tab switch still shows what it is. */
export function departmentChoices(
  options: DepartmentOption[],
  tab: AnalyticsTab,
  selected: number | null,
): { id: number; label: string; foreign: boolean }[] {
  const own = options
    .filter((d) => !d.category || d.category === tab)
    .map((d) => ({ id: d.id, label: d.name, foreign: false }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (selected && !own.some((d) => d.id === selected)) {
    const other = options.find((d) => d.id === selected);
    own.unshift({
      id: selected,
      label: other ? `${other.name} (${other.category ?? "other"} department)` : `Department #${selected}`,
      foreign: true,
    });
  }
  return own;
}

/** The filters in words, for an export's subtitle and the screen reader: ["Department: IT", "Search: sur"]. */
export function filterWords(f: Filters, names: { department?: string | null; employee?: string | null }): string[] {
  const out: string[] = [];
  if (f.dept) out.push(`Department: ${names.department ?? `#${f.dept}`}`);
  if (f.emp) out.push(`Employee: ${names.employee ?? `#${f.emp}`}`);
  if (f.q.trim()) out.push(`Search: "${f.q.trim()}"`);
  return out;
}

export const TAB_LABEL: Record<AnalyticsTab, string> = { staff: "Staff", production: "Production" };

// ── Levels ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const LEVELS: Level[] = ["high", "attention", "watch", "ok"];

export const LEVEL_META: Record<Level, { label: string; tone: Tone; dot: string; hint: string; color: string }> = {
  high: {
    label: "High",
    tone: "danger",
    dot: "bg-red-500",
    hint: "Twice a limit or more, or over the limit in 3 or more categories",
    color: "#dc2626",
  },
  attention: {
    label: "Attention",
    tone: "warning",
    dot: "bg-amber-500",
    hint: "At or over the limit in at least one category",
    color: "#d97706",
  },
  watch: {
    label: "Watch",
    tone: "info",
    dot: "bg-blue-500",
    hint: "Has records, but under every limit",
    color: "#2563eb",
  },
  ok: {
    label: "OK",
    tone: "neutral",
    dot: "bg-slate-400",
    hint: "Nothing that counts towards a level",
    color: "#64748b",
  },
};

export const levelRank = (l: Level): number => LEVELS.indexOf(l);
export const parseLevel = (v: string | null | undefined): Level => (LEVELS.includes(v as Level) ? (v as Level) : "ok");

// ── Numbers and words ───────────────────────────────────────────────────────────────────────────────────────────────

/** 3 -> "3", 2.76 -> "2.8". */
export const num1 = (n: number | null | undefined): string =>
  n === null || n === undefined || Number.isNaN(n) ? "-" : String(Math.round(n * 10) / 10);

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "21%". */
export const pct = (rate: number | null | undefined): string =>
  rate === null || rate === undefined || Number.isNaN(rate) ? "-" : `${Math.round(rate * 100)}%`;

/** Hours as people say them: "45 min", "19.5 h", "2.9 days". */
export function hoursText(h: number | null | undefined): string {
  if (h === null || h === undefined || Number.isNaN(h)) return "-";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${num1(h)} h`;
  return `${num1(h / 24)} days`;
}

// ── Categories ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** "4+ days a month · 3 for this period"; an informational category says it never raises a level. */
export function thresholdText(
  c: Pick<CategoryMeta, "thresholdPerMonth" | "threshold" | "unit" | "informational">,
): string {
  if (c.informational) return "For reference: never raises a level";
  const base = `${num1(c.thresholdPerMonth)}+ ${c.unit} a month`;
  return c.threshold === c.thresholdPerMonth ? base : `${base} · ${num1(c.threshold)} for this period`;
}

/** How a card looks: calm (nobody over the limit), attention, high (someone at twice the limit), info (reference only). */
export type CardState = "calm" | "attention" | "high" | "info";
export function cardState(c: CategoryMeta): CardState {
  if (c.informational) return "info";
  if (c.high > 0) return "high";
  if (c.flagged > 0) return "attention";
  return "calm";
}

/** The people with the most of one category: count, then the overall score. */
export function topEmployees(employees: EmployeeHit[], key: string, n = 3): EmployeeHit[] {
  return employees
    .filter((e) => (e.counts[key] ?? 0) > 0)
    .sort((a, b) => (b.counts[key] ?? 0) - (a.counts[key] ?? 0) || b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, n);
}

export const weeklyValues = (weekly: WeeklyPoint[], key: string): number[] => weekly.map((w) => w.counts[key] ?? 0);

/** A sparkline's SVG path through the values, inside a w x h box (2 px air at the top and the bottom). */
export function sparkPath(values: number[], w = 96, h = 28): string {
  if (values.length === 0) return "";
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const y = (v: number) => Math.round((h - 2 - (v / max) * (h - 4)) * 10) / 10;
  if (values.length === 1) return `M0 ${y(values[0])} L${w} ${y(values[0])}`;
  return values.map((v, i) => `${i === 0 ? "M" : "L"}${Math.round(i * step * 10) / 10} ${y(v)}`).join(" ");
}

/** A category's chips on one employee: the categories with records, those over the limit first, then by how far. */
export function flagChips(
  e: Pick<EmployeeHit, "counts" | "flags">,
  categories: CategoryMeta[],
): { key: string; label: string; count: number; flagged: boolean; informational: boolean }[] {
  return categories
    .filter((c) => (e.counts[c.key] ?? 0) > 0)
    .map((c) => ({
      key: c.key,
      label: c.label,
      count: e.counts[c.key] ?? 0,
      flagged: e.flags.includes(c.key),
      informational: c.informational,
      ratio: c.threshold > 0 ? (e.counts[c.key] ?? 0) / c.threshold : 0,
    }))
    .sort(
      (a, b) =>
        Number(b.flagged) - Number(a.flagged) || Number(a.informational) - Number(b.informational) || b.ratio - a.ratio,
    )
    .map(({ ratio: _ratio, ...chip }) => chip);
}

// ── The attention list ──────────────────────────────────────────────────────────────────────────────────────────────

export type LevelFilter = "needs" | "all" | Level;

export const LEVEL_FILTERS: { value: LevelFilter; label: string }[] = [
  { value: "needs", label: "Needing attention" },
  { value: "high", label: "High" },
  { value: "attention", label: "Attention" },
  { value: "watch", label: "Watch" },
  { value: "all", label: "Everyone with records" },
];

export const inLevel = (e: Pick<EmployeeHit, "level">, f: LevelFilter): boolean =>
  f === "all" ? true : f === "needs" ? e.level === "high" || e.level === "attention" : e.level === f;

/** Name, code, designation or department contain every word typed (any order, any case). */
export function matchesQuery(e: Pick<EmployeeHit, "name" | "code" | "designation" | "department">, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [e.name, e.code, e.designation ?? "", e.department ?? ""].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function levelCounts(list: Pick<EmployeeHit, "level">[]): Record<LevelFilter, number> {
  const out: Record<LevelFilter, number> = { needs: 0, all: list.length, high: 0, attention: 0, watch: 0, ok: 0 };
  for (const e of list) {
    out[e.level] += 1;
    if (e.level === "high" || e.level === "attention") out.needs += 1;
  }
  return out;
}

export type SortKey = "score" | "name" | "department" | "level" | "lastDate" | "flags";
export type Sort = { key: SortKey; dir: "asc" | "desc" };
export const DEFAULT_SORT: Sort = { key: "score", dir: "desc" };

/** The way a column opens: names A to Z, the rest biggest / newest / most serious first. */
export const FIRST_DIR: Record<SortKey, Sort["dir"]> = {
  score: "desc",
  name: "asc",
  department: "asc",
  level: "desc",
  lastDate: "desc",
  flags: "desc",
};

export function sortEmployees<T extends EmployeeHit>(list: T[], sort: Sort): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const by = (a: T, b: T): number => {
    switch (sort.key) {
      case "name":
        return a.name.localeCompare(b.name);
      case "department":
        return (a.department ?? "").localeCompare(b.department ?? "") || a.name.localeCompare(b.name) * sign;
      case "level":
        return levelRank(b.level) - levelRank(a.level) || a.score - b.score;
      case "lastDate":
        return (a.lastDate ?? "").localeCompare(b.lastDate ?? "");
      case "flags":
        return a.flags.length - b.flags.length || a.score - b.score;
      default:
        return a.score - b.score;
    }
  };
  return [...list].sort((a, b) => by(a, b) * sign || a.name.localeCompare(b.name));
}

export const PAGE_SIZE = 25;

export function pageOf<T>(list: T[], page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  return {
    rows: list.slice(start, start + size),
    page: current,
    pages,
    first: list.length ? start + 1 : 0,
    last: Math.min(start + size, list.length),
    total: list.length,
  };
}

// ── Insights: what stands out, in words, each one a way into the detail ────────────────────────────────────────────

export type InsightAction =
  | { type: "level"; level: LevelFilter }
  | { type: "category"; key: string }
  | { type: "employee"; id: number }
  | { type: "department"; id: number }
  | { type: "hods" };

export type Insight = {
  id: string;
  tone: "danger" | "warning" | "info" | "success";
  title: string;
  detail?: string;
  action?: InsightAction;
  actionLabel?: string;
};

const listNames = (names: string[], more: number): string =>
  more > 0
    ? `${names.join(", ")} and ${more} more`
    : names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
      : (names[0] ?? "");

/** The last week that is complete inside the period, and the one before it: issues per week, both. */
export function weekOverWeek(
  weekly: WeeklyPoint[],
  categories: CategoryMeta[],
  periodTo: string,
): { last: number; before: number; weekStart: string } | null {
  const counted = new Set(categories.filter((c) => !c.informational).map((c) => c.key));
  const total = (w: WeeklyPoint) =>
    Object.entries(w.counts).reduce((n, [k, v]) => (counted.has(k) ? n + (v ?? 0) : n), 0);
  const complete = weekly.filter((w) => w.weekEnd <= periodTo);
  if (complete.length < 2) return null;
  const last = complete[complete.length - 1];
  const before = complete[complete.length - 2];
  return { last: total(last), before: total(before), weekStart: last.weekStart };
}

export function buildInsights(s: AnalyticsSummary, max = 5): Insight[] {
  const out: Insight[] = [];
  const counted = s.categories.filter((c) => !c.informational);
  if (s.totals.employeesWithIssues === 0) {
    return [
      {
        id: "clear",
        tone: "success",
        title: "No attendance issue in this period",
        detail: `Nobody in the ${plural(s.totals.employeesInScope, "employee")} in scope has a record in any category.`,
      },
    ];
  }

  const high = s.employees.filter((e) => e.level === "high");
  if (high.length > 0) {
    const names = high.slice(0, 2).map((e) => e.name);
    out.push({
      id: "high",
      tone: "danger",
      title: `${plural(high.length, "employee needs", "employees need")} a close look`,
      detail: `${listNames(names, high.length - names.length)} ${high.length === 1 ? "is" : "are"} at twice a limit, or over the limit in 3 or more categories.`,
      action: high.length === 1 ? { type: "employee", id: high[0].id } : { type: "level", level: "high" },
      actionLabel: high.length === 1 ? "Open" : "Show them",
    });
  }

  const top = [...counted].sort((a, b) => b.flagged - a.flagged || b.total - a.total)[0];
  if (top && top.flagged > 0) {
    out.push({
      id: `top-${top.key}`,
      tone: "warning",
      title: `${top.label} is the most common issue`,
      detail: `${plural(top.flagged, "employee is", "employees are")} at or over ${num1(top.threshold)} ${top.unit} in this period (${plural(top.total, "occurrence")} in all).`,
      action: { type: "category", key: top.key },
      actionLabel: "See who",
    });
  }

  const wow = weekOverWeek(s.weekly, s.categories, s.period.to);
  if (wow && wow.before > 0 && Math.max(wow.last, wow.before) >= 5) {
    const change = (wow.last - wow.before) / wow.before;
    if (Math.abs(change) >= 0.25) {
      out.push({
        id: "trend",
        tone: change > 0 ? "warning" : "success",
        title: `Issues ${change > 0 ? "rose" : "fell"} ${Math.round(Math.abs(change) * 100)}% in the week of ${dayMonth(wow.weekStart)}`,
        detail: `${wow.last} records that week against ${wow.before} the week before.`,
      });
    }
  }

  const hot = s.departments
    .filter((d) => d.flagged >= 2 && d.employees > 0)
    .sort((a, b) => b.flagged / b.employees - a.flagged / a.employees || b.flagged - a.flagged)[0];
  if (hot) {
    out.push({
      id: `dept-${hot.id}`,
      tone: "info",
      title: `${hot.name} has the largest share flagged`,
      detail: `${hot.flagged} of ${plural(hot.employees, "employee")} (${pct(hot.flagged / hot.employees)}) are at or over a limit.`,
      action: { type: "department", id: hot.id },
      actionLabel: "Filter to it",
    });
  }

  const waitingLong = s.hods.reduce((n, h) => n + h.waitingLong, 0);
  if (waitingLong > 0) {
    const heads = s.hods.filter((h) => h.waitingLong > 0).length;
    out.push({
      id: "hods-waiting",
      tone: "warning",
      title: `${plural(waitingLong, "request has", "requests have")} waited more than 2 days`,
      detail: `With ${plural(heads, "Department Head")}. The HOD view shows who.`,
      action: { type: "hods" },
      actionLabel: "HOD view",
    });
  }

  const watch = s.employees.filter((e) => e.level === "watch").length;
  if (watch > 0) {
    out.push({
      id: "watch",
      tone: "info",
      title: `${plural(watch, "employee is", "employees are")} close to a limit`,
      detail: "They have records but are still under every limit: worth a word before they cross it.",
      action: { type: "level", level: "watch" },
      actionLabel: "Show them",
    });
  }
  return out.slice(0, max);
}

// ── Chart rows ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Indigo, cyan, pink, lime: checked together for colour-blind separation; amber and red are kept for the levels. */
export const TREND_COLORS = ["#4f46e5", "#0891b2", "#db2777", "#65a30d"] as const;
export const MAX_TREND_SERIES = TREND_COLORS.length;

/** The categories the weekly trend opens with: the three counted ones with the most records. */
export function defaultTrendKeys(categories: CategoryMeta[]): string[] {
  return categories
    .filter((c) => !c.informational && c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 3)
    .map((c) => c.key);
}

/** A colour per shown category that stays with it while others come and go (a colour follows its category, not its
 *  place): kept ones keep theirs, a new one takes the first free colour. */
export function assignColors(keys: string[], previous: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const k of keys) {
    if (previous[k] && !used.has(previous[k])) {
      out[k] = previous[k];
      used.add(previous[k]);
    }
  }
  for (const k of keys) {
    if (out[k]) continue;
    const free = TREND_COLORS.find((c) => !used.has(c)) ?? TREND_COLORS[0];
    out[k] = free;
    used.add(free);
  }
  return out;
}

export function weeklyRows(weekly: WeeklyPoint[], keys: string[]): Record<string, string | number>[] {
  return weekly.map((w) => {
    const row: Record<string, string | number> = {
      label: dayMonth(w.weekStart),
      range: rangeLabel(w.weekStart, w.weekEnd),
    };
    for (const k of keys) row[k] = w.counts[k] ?? 0;
    return row;
  });
}

export function departmentRows(departments: DepartmentRow[], limit = 10) {
  return [...departments]
    .filter((d) => d.employees > 0 || d.flagged > 0)
    .sort((a, b) => b.flagged - a.flagged || b.employees - a.employees || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((d) => ({
      id: d.id,
      name: d.name,
      flagged: d.flagged,
      others: Math.max(0, d.employees - d.flagged),
      employees: d.employees,
    }));
}

export function distributionRows(categories: CategoryMeta[]) {
  return categories
    .filter((c) => !c.informational)
    .map((c) => ({
      key: c.key,
      label: c.label,
      high: c.high,
      attention: Math.max(0, c.flagged - c.high),
      flagged: c.flagged,
      affected: c.affected,
    }))
    .sort((a, b) => b.flagged - a.flagged || b.affected - a.affected);
}

// ── HOD view ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type HodSortKey =
  "name" | "decided" | "rejectionRate" | "avgResponseHours" | "waitingNow" | "waitingLong" | "oldestWaitingHours";
export type HodSort = { key: HodSortKey; dir: "asc" | "desc" };
/** The Department Head whose request has waited longest comes first. */
export const DEFAULT_HOD_SORT: HodSort = { key: "oldestWaitingHours", dir: "desc" };

export function sortHods(list: HodRow[], sort: HodSort): HodRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const value = (h: HodRow): number | string =>
    sort.key === "name"
      ? h.name
      : sort.key === "avgResponseHours" || sort.key === "oldestWaitingHours"
        ? (h[sort.key] ?? -1)
        : h[sort.key];
  return [...list].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const by = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
    return by * sign || b.waitingNow - a.waitingNow || a.name.localeCompare(b.name);
  });
}

/** A Department Head worth a look: something waiting over 2 days, or rejecting a lot of what they decide. */
export const hodNeedsLook = (h: HodRow): boolean => h.waitingLong > 0 || (h.decided >= 5 && h.rejectionRate >= 0.4);

// ── The drill-downs ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One bar per weekday (Mon-Sun), the busiest marked; a missing day counts 0. */
export function weekdayBars(pattern: Pick<Pattern, "byWeekday"> | null | undefined) {
  const counts = WEEKDAYS.map((d) => Number(pattern?.byWeekday?.[d] ?? 0) || 0);
  const max = Math.max(0, ...counts);
  return WEEKDAYS.map((day, i) => ({
    day,
    count: counts[i],
    pct: max > 0 ? Math.round((counts[i] / max) * 100) : 0,
    peak: max > 0 && counts[i] === max,
  }));
}

/** "Mostly on Mondays" when the server gives no note but one weekday clearly leads (half or more of 3+). */
export function patternNote(pattern: Pick<Pattern, "byWeekday" | "note"> | null | undefined): string | null {
  if (pattern?.note) return pattern.note;
  const bars = weekdayBars(pattern);
  const total = bars.reduce((n, b) => n + b.count, 0);
  const peaks = bars.filter((b) => b.peak);
  if (total >= 3 && peaks.length === 1 && peaks[0].count / total >= 0.5)
    return `Mostly on ${WEEKDAYS_LONG[peaks[0].day]}`;
  return null;
}

const KNOWN_PATTERN_KEYS = new Set(["byWeekday", "longestStreak", "lastDate", "note"]);

/** "avgFirstPunch" -> "Avg first punch". */
export const humanize = (key: string): string => {
  const words = key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The numbers a category adds to its pattern (first punches, hours ...), as label / value pairs. */
export function patternExtras(pattern: Pattern | null | undefined): { label: string; value: string }[] {
  if (!pattern) return [];
  return Object.entries(pattern)
    .filter(([k, v]) => !KNOWN_PATTERN_KEYS.has(k) && (typeof v === "string" || typeof v === "number") && v !== "")
    .map(([k, v]) => ({ label: humanize(k), value: typeof v === "number" ? num1(v) : String(v) }));
}

/** Count against the limit: the bar fills to the limit at 50% (so twice the limit is a full bar). */
export function againstLimit(count: number, threshold: number, informational: boolean) {
  if (informational || threshold <= 0) return { pct: count > 0 ? 100 : 0, ratio: 0, over: false, double: false };
  const ratio = count / threshold;
  return {
    pct: Math.min(100, Math.round((ratio / 2) * 100)),
    ratio,
    over: count >= threshold,
    double: count >= threshold * 2,
  };
}

/** "20 Nov" or "20 Nov - 22 Nov". */
export const recordDays = (r: Pick<AnalyticsRecord, "date" | "endDate">): string =>
  r.endDate && r.endDate !== r.date ? `${dayMonth(r.date)} - ${dayMonth(r.endDate)}` : dayMonth(r.date);

export const RECORD_STATUS_TONE: Record<string, Tone> = {
  approved: "success",
  completed: "success",
  pending: "warning",
  pending_hod: "warning",
  pending_hr: "info",
  rejected: "danger",
  cancelled: "neutral",
  absent: "danger",
  edited: "accent",
};

export const statusLabel = (s: string | null | undefined): string =>
  s ? humanize(s.replace(/^pending_hod$/, "waiting for HOD").replace(/^pending_hr$/, "waiting for HR")) : "";

/** Timeline records grouped by month, newest first: [{ month: "November 2026", items }]. */
export function groupByMonth<T extends { date: string }>(records: T[]): { month: string; items: T[] }[] {
  const out: { month: string; items: T[] }[] = [];
  for (const r of [...records].sort((a, b) => b.date.localeCompare(a.date))) {
    const d = fromIso(r.date);
    const month = d ? `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}` : "Undated";
    const last = out[out.length - 1];
    if (last && last.month === month) last.items.push(r);
    else out.push({ month, items: [r] });
  }
  return out;
}

/** The categories of one tab in the server's order, with the employee's count in each, records first. */
export function orderedCategoryKeys(categories: Record<string, { count: number; category: CategoryMeta }>): string[] {
  return Object.keys(categories).sort(
    (a, b) =>
      Number(categories[b].count > 0) - Number(categories[a].count > 0) ||
      Number(categories[a].category.informational) - Number(categories[b].category.informational),
  );
}

/** The short name of a category for chips: "Frequent late arrival" -> "Late arrival" is the server's job; we only
 *  trim a leading "Frequent " so a row of chips stays short. */
export const shortLabel = (label: string): string => {
  const s = label.replace(/^Frequent\s+/i, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
