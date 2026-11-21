// Small controls of the Communication page: the channel switch, the history's status switch, search, date range and pager.

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { CHANNEL_COLOR, CHANNEL_FILTERS, CHANNEL_LABEL, statusItems } from "./logic";
import type { Channel, ChannelFilter, StatusCounts, StatusGroup } from "./types";

/** A segmented switch: a frosted track, the chosen item a wine glass pill; scrolls inside itself on a narrow phone. */
function Seg<T extends string>({
  items,
  value,
  onChange,
  label,
  testId,
}: {
  items: { value: T; label: string; count?: number | null }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  testId: string;
}) {
  return (
    <div className="max-w-full overflow-x-auto scrollbar-hide" data-testid={testId}>
      <div role="tablist" aria-label={label} className="md-seg md-shell-seg md-shell-seg-sm">
        {items.map((item) => (
          <button
            key={item.value || "all"}
            type="button"
            role="tab"
            aria-selected={item.value === value}
            onClick={() => onChange(item.value)}
            className="md-seg-item min-h-8 whitespace-nowrap"
            data-testid={`${testId}-${item.value || "all"}`}
          >
            {item.label}
            {item.count != null && <span className="ml-1 tabular-nums opacity-75">{num(item.count)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChannelSwitch({ value, onChange }: { value: ChannelFilter; onChange: (next: ChannelFilter) => void }) {
  return (
    <Seg
      items={CHANNEL_FILTERS.map((c) => ({ value: c, label: c === "all" ? "All" : CHANNEL_LABEL[c] }))}
      value={value}
      onChange={onChange}
      label="Channel"
      testId="md-comms-channel"
    />
  );
}

export function StatusSwitch({
  value,
  onChange,
  counts,
  channel,
}: {
  value: StatusGroup | "";
  onChange: (next: StatusGroup | "") => void;
  counts?: StatusCounts;
  channel: ChannelFilter;
}) {
  return (
    <Seg
      items={statusItems(counts, channel)}
      value={value}
      onChange={onChange}
      label="Status"
      testId="md-comms-status"
    />
  );
}

/** A coloured dot and the channel's name. */
export function ChannelTag({ channel, className }: { channel: Channel; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap font-semibold", className)}>
      <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: CHANNEL_COLOR[channel] }} aria-hidden="true" />
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

/** Name or code search with a short pause, so the list is not asked for on every key. */
export function SearchBox({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const [text, setText] = useState(value);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === last.current) return;
    const timer = setTimeout(() => {
      last.current = trimmed;
      onChange(trimmed);
    }, 300);
    return () => clearTimeout(timer);
  }, [text, onChange]);
  return (
    <div className="relative w-full @lg:w-60">
      <Search
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-md-ink-soft"
        aria-hidden="true"
      />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search name or code"
        aria-label="Search name or code"
        className="md-field h-9 pl-8 pr-8 text-xs"
        data-testid="md-comms-search"
      />
      {text && (
        <button
          type="button"
          className="md-btn md-btn-ghost md-btn-icon absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
          aria-label="Clear the search"
          onClick={() => setText("")}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** From / to dates for the history; "Whole month" goes back to the month chosen at the top. */
export function RangeInputs({
  from,
  to,
  onChange,
  monthText,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  monthText: string;
}) {
  const [a, setA] = useState(from);
  const [b, setB] = useState(to);
  useEffect(() => {
    setA(from);
    setB(to);
  }, [from, to]);
  const apply = (nextA: string, nextB: string) => {
    if (nextA && nextB && nextA <= nextB) onChange({ from: nextA, to: nextB });
  };
  const custom = !!(from && to);
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-md-ink-soft"
      data-testid="md-comms-range"
    >
      <Input
        type="date"
        value={a}
        max={b || undefined}
        aria-label="From date"
        className="md-field h-9 w-[9.25rem] text-xs"
        data-testid="md-comms-from"
        onChange={(e) => {
          setA(e.target.value);
          apply(e.target.value, b);
        }}
      />
      <span>to</span>
      <Input
        type="date"
        value={b}
        min={a || undefined}
        aria-label="To date"
        className="md-field h-9 w-[9.25rem] text-xs"
        data-testid="md-comms-to"
        onChange={(e) => {
          setB(e.target.value);
          apply(a, e.target.value);
        }}
      />
      {custom ? (
        <button
          type="button"
          className="md-btn md-btn-soft md-btn-sm"
          onClick={() => onChange({ from: "", to: "" })}
          data-testid="md-comms-range-clear"
        >
          Whole {monthText}
        </button>
      ) : (
        <span className="px-1">({monthText})</span>
      )}
    </div>
  );
}

export function Pager({
  page,
  pages,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  if (total <= pageSize) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <div
      className="mt-2 flex items-center justify-between gap-3 border-t border-md-line pt-3 text-xs font-medium text-md-ink-soft"
      data-testid="md-comms-pager"
    >
      <span>
        {num(first)}-{num(last)} of {num(total)}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="md-btn md-btn-soft md-btn-icon h-9 w-9"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          data-testid="md-comms-prev"
        >
          <ChevronLeft size={15} />
        </button>
        <span className="tabular-nums">
          {page} / {pages}
        </span>
        <button
          type="button"
          className="md-btn md-btn-soft md-btn-icon h-9 w-9"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages}
          aria-label="Next page"
          data-testid="md-comms-next"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}
