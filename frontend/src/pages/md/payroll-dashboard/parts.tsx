import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Building2, CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Search, Users, X } from "lucide-react";
import ProvenanceButton from "@/components/md/kit/ProvenanceButton";
import { ErrorBanner } from "@/components/md/kit/states";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { monthText, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { explain } from "./glossary";
import { TONE_CHIP, monthOptions, pageInfo, type DashView, type StatusTone } from "./logic";

// ── the three tabs ────────────────────────────────────────────────────────────────────────────────────────────────

const TABS: { id: DashView; label: string; icon: typeof Users }[] = [
  { id: "monthly", label: "Monthly", icon: CalendarRange },
  { id: "departments", label: "Departments", icon: Building2 },
  { id: "employees", label: "Employees", icon: Users },
];

/** Monthly | Departments | Employees: a frosted track, the chosen one a wine glass pill. On a phone the three share the
 *  width equally, so the switch never scrolls. */
export function ViewTabs({ value, onChange }: { value: DashView; onChange: (view: DashView) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Payroll views"
      className="md-seg md-shell-seg grid w-full grid-cols-3 @lg:inline-flex @lg:w-auto"
      data-testid="md-pay-tabs"
    >
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          data-testid={`md-pay-tab-${id}`}
          onClick={() => onChange(id)}
          className={cn(
            "md-seg-item min-h-9 justify-center whitespace-nowrap px-2 text-[12.5px] @lg:px-4 @lg:text-[13px]",
            value === id && "md-money-seg-on",
          )}
        >
          {/* the icons go on a narrow phone, where the three labels need the whole width */}
          <Icon size={14} strokeWidth={2.2} aria-hidden="true" className="hidden shrink-0 @sm:block" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** A small switch inside a card (what a chart shows): the same frosted track, compact. */
export function Seg<T extends string>({
  items,
  value,
  onChange,
  label,
  testId,
}: {
  items: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  testId?: string;
}) {
  return (
    <div className="max-w-full overflow-x-auto scrollbar-hide" data-testid={testId}>
      <div role="tablist" aria-label={label} className="md-seg md-shell-seg md-shell-seg-sm">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={item.value === value}
            onClick={() => onChange(item.value)}
            className={cn("md-seg-item whitespace-nowrap", item.value === value && "md-money-seg-on")}
            data-testid={testId ? `${testId}-${item.value}` : undefined}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── filters ───────────────────────────────────────────────────────────────────────────────────────────────────────

const LATEST = "__latest__";

/** The payroll month: "Latest month" (the server's latest month with slips, named once it is known) or one of the
 *  months that have slips. */
export function MonthSelect({
  value,
  onChange,
  available,
  latest,
}: {
  value: string;
  onChange: (month: string) => void;
  available: string[] | undefined;
  /** the month the server picked for "Latest month" */
  latest: string | null | undefined;
}) {
  const options = monthOptions(available, value);
  return (
    <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto" data-testid="md-pay-month-picker">
      <span className="md-money-filter-icon">
        <CalendarDays size={15} aria-hidden />
      </span>
      <Select value={value || LATEST} onValueChange={(v) => onChange(v === LATEST ? "" : v)}>
        <SelectTrigger
          className="md-field h-9 min-w-0 flex-1 text-[13px] font-semibold sm:w-[13.5rem] sm:flex-none"
          aria-label="Payroll month"
          data-testid="md-pay-month"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LATEST}>Latest month{latest ? ` (${monthText(latest)})` : ""}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The people search: a name or an employee code. Typing waits a moment before it asks the server (one request per
 *  pause, not per key); Enter and the clear button act at once. */
export function SearchBox({
  value,
  onChange,
  delay = 300,
}: {
  value: string;
  onChange: (q: string) => void;
  delay?: number;
}) {
  const [text, setText] = useState(value);
  const sent = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // the address changed under us (Back, a link): show what it says
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    const q = text.trim();
    if (q === sent.current) return;
    const timer = setTimeout(() => {
      sent.current = q;
      onChangeRef.current(q);
    }, delay);
    return () => clearTimeout(timer);
  }, [text, delay]);

  const sendNow = (q: string) => {
    sent.current = q;
    onChangeRef.current(q);
  };

  return (
    <div className="relative w-full sm:w-[17rem]" data-testid="md-pay-search-box">
      <Search
        size={15}
        className="pointer-events-none absolute left-3 z-10 top-1/2 -translate-y-1/2 text-md-ink-soft"
        aria-hidden
      />
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") sendNow(text.trim());
        }}
        placeholder="Search name or employee code"
        aria-label="Search employees by name or code"
        data-testid="md-pay-search"
        className="md-field h-9 w-full pl-9 pr-9 text-[13px] font-medium [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <button
          type="button"
          onClick={() => {
            setText("");
            sendNow("");
          }}
          aria-label="Clear the search"
          data-testid="md-pay-search-clear"
          className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-md-ink-soft hover:bg-md-ink/5 hover:text-md-ink"
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

// ── small pieces ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A coloured pill for a state: sage = all well, ochre = watch, crimson = a problem, periwinkle = information. */
export function ToneChip({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("md-chip whitespace-nowrap", TONE_CHIP[tone], className)} data-tone={tone}>
      {children}
    </span>
  );
}

/** "How is this calculated?" for the figures of a card, from the page's glossary. */
export function Explain({ ids, className }: { ids: string[]; className?: string }) {
  return <ProvenanceButton provenance={explain(...ids)} className={className} label="What does this mean?" />;
}

/** An error inside one card (what the server said, and a retry): the rest of the page keeps working. */
export function CardError({ query }: { query: UseQueryResult<unknown> }) {
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
}

/** True when a query has nothing to show because it failed. */
export const failed = (query: UseQueryResult<unknown>) => query.isError && !query.data;

/** A small figure with its label inside a card: a quiet glass tile (`emphasis`: the wine one). */
export function Figure({
  label,
  value,
  sub,
  emphasis,
  testId,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  emphasis?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <div className={cn("md-money-metric", emphasis && "md-money-metric-wine", className)} data-testid={testId}>
      <p className="text-[11.5px] font-semibold leading-snug text-md-ink-soft sm:text-xs">{label}</p>
      <p
        className="mt-0.5 text-[17px] font-black leading-tight tracking-tight tabular-nums text-md-ink [overflow-wrap:anywhere] sm:text-lg"
        data-testid={testId ? `${testId}-value` : undefined}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] leading-snug text-md-ink-soft">{sub}</p>}
    </div>
  );
}

/** "1-25 of 112 · Page 1 of 5" with Previous / Next. */
export function Pager({
  total,
  page,
  pageSize,
  onPage,
  noun = "employees",
}: {
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  noun?: string;
}) {
  const info = pageInfo(total, page, pageSize);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-md-line pt-3 text-xs font-medium text-md-ink-soft"
      data-testid="md-pay-pager"
    >
      <span className="tabular-nums" data-testid="md-pay-pager-range">
        {info.from}–{info.to} of {num(total)} {noun}
      </span>
      {info.pages > 1 && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="md-btn md-btn-soft md-btn-sm h-8"
            disabled={!info.hasPrev}
            onClick={() => onPage(info.page - 1)}
            data-testid="md-pay-page-prev"
          >
            <ChevronLeft size={14} aria-hidden /> Previous
          </button>
          <span className="px-1 tabular-nums" data-testid="md-pay-page-of">
            Page {info.page} of {info.pages}
          </span>
          <button
            type="button"
            className="md-btn md-btn-soft md-btn-sm h-8"
            disabled={!info.hasNext}
            onClick={() => onPage(info.page + 1)}
            data-testid="md-pay-page-next"
          >
            Next <ChevronRight size={14} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

// ── chart pieces ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A chart's box: the height the card asks for, kept to 220 px while the page is phone-narrow (md-shell-chart). */
export function ChartFrame({
  height,
  children,
  testId,
  phoneCap = true,
  grow = false,
}: {
  height: number;
  children: ReactNode;
  testId?: string;
  /** false: keep the full height on a phone too (a bar per department needs its rows) */
  phoneCap?: boolean;
  /** fill the rest of a stretched card (at least `height`; 220 px on a phone): its card is a flex column */
  grow?: boolean;
}) {
  if (grow) {
    return (
      <div
        className="h-[220px] w-full min-w-0 @lg:h-auto @lg:min-h-[var(--md-chart-min)] @lg:flex-1"
        style={{ "--md-chart-min": `${height}px` } as CSSProperties}
        data-testid={testId}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      className={cn(phoneCap ? "md-shell-chart" : undefined, "w-full min-w-0")}
      style={(phoneCap ? { "--md-chart-h": `${height}px` } : { height }) as CSSProperties}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export type LegendItem = { key: string; label: string; color: string; shape: "bar" | "line" | "dash" };

/** A series' mark: a square for bars, a line (solid or dashed) for lines: the shape tells the series apart as well as
 *  the colour does. */
export function Swatch({ color, shape }: { color: string; shape: LegendItem["shape"] }) {
  if (shape === "bar")
    return <span className="md-money-swatch shrink-0" style={{ background: color }} aria-hidden="true" />;
  return (
    <svg width="16" height="8" viewBox="0 0 16 8" className="shrink-0" aria-hidden="true">
      <line
        x1="1"
        y1="4"
        x2="15"
        y2="4"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray={shape === "dash" ? "3 3" : undefined}
      />
    </svg>
  );
}

/** The legend under a chart. With `hidden` + `onToggle` each item is a switch that hides or shows its series. */
export function ChartLegend({
  items,
  hidden,
  onToggle,
  testId,
}: {
  items: LegendItem[];
  hidden?: Set<string>;
  onToggle?: (key: string) => void;
  testId?: string;
}) {
  return (
    <ul className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1" data-testid={testId}>
      {items.map((item) => {
        const off = hidden?.has(item.key) ?? false;
        const body = (
          <>
            <Swatch color={item.color} shape={item.shape} />
            <span className={cn(off && "line-through decoration-md-ink-soft/70")}>{item.label}</span>
          </>
        );
        return (
          <li key={item.key}>
            {onToggle ? (
              <button
                type="button"
                aria-pressed={!off}
                onClick={() => onToggle(item.key)}
                className={cn(
                  "inline-flex min-h-7 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-md-ink-700 transition-colors hover:bg-md-ink/5",
                  off && "opacity-50",
                )}
                data-testid={testId ? `${testId}-${item.key}` : undefined}
              >
                {body}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11.5px] font-semibold text-md-ink-700">
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export type TooltipLine = {
  label: string;
  value: string;
  color?: string;
  shape?: LegendItem["shape"];
  strong?: boolean;
};

/** A chart's tooltip: a title and lines of label / value, on the portal's light glass. */
export function TooltipCard({ title, lines, foot }: { title: ReactNode; lines: TooltipLine[]; foot?: ReactNode }) {
  return (
    // md-shell-popover owns the padding (none): the inner box adds it
    <div className="md-shell-popover min-w-[12rem] max-w-[17rem] text-xs text-md-ink">
      <div className="px-3 py-2.5">
        <p className="mb-1.5 text-[12.5px] font-extrabold">{title}</p>
        <ul className="space-y-1">
          {lines.map((l) => (
            <li key={l.label} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5 text-md-ink-soft">
                {l.color && <Swatch color={l.color} shape={l.shape ?? "bar"} />}
                <span className={cn("truncate", l.strong && "font-bold text-md-ink")}>{l.label}</span>
              </span>
              <span className={cn("shrink-0 tabular-nums", l.strong ? "font-extrabold" : "font-semibold")}>
                {l.value}
              </span>
            </li>
          ))}
        </ul>
        {foot && <p className="mt-1.5 border-t border-md-line pt-1.5 text-[11px] text-md-ink-soft">{foot}</p>}
      </div>
    </div>
  );
}
