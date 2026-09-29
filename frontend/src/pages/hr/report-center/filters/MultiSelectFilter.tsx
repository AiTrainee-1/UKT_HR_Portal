import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";

export interface MultiOption {
  value: string;
  label: string;
}

/** Popover checklist for "all / some of" filters (departments, designations, branches, fixed choices). */
export function MultiSelectFilter({
  options,
  value,
  onChange,
  placeholder = "All",
  label,
}: {
  options: MultiOption[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = useMemo(() => new Set(value), [value]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  }, [options, q]);

  const toggle = (v: string) => onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  const summary =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? "1 selected")
        : `${value.length} selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          className="h-9 w-full justify-between px-3 font-normal"
        >
          <span className={`truncate ${value.length ? "text-gray-900" : "text-muted-foreground"}`}>{summary}</span>
          <ChevronsUpDown className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-0" {...{ [VIEW_SAFE_ATTR]: "" }}>
        {options.length > 7 && (
          <div className="relative border-b p-2">
            <Search
              size={13}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-8 pl-8 text-sm"
              aria-label={`Search ${label}`}
            />
          </div>
        )}
        <div className="flex items-center justify-between border-b px-3 py-1.5 text-[11px]">
          <span className="text-muted-foreground">
            {value.length ? `${value.length} selected` : "Nothing selected = all"}
          </span>
          <div className="flex gap-3">
            <button
              type="button"
              className="font-semibold text-sky-700 hover:underline"
              onClick={() => onChange(Array.from(new Set([...value, ...shown.map((o) => o.value)])))}
            >
              Select all{q ? " shown" : ""}
            </button>
            <button type="button" className="font-semibold text-gray-500 hover:underline" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {shown.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">Nothing matches “{q}”.</p>
          )}
          {shown.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              <Checkbox checked={selected.has(o.value)} onCheckedChange={() => toggle(o.value)} aria-label={o.label} />
              <span className="truncate">{o.label}</span>
              {selected.has(o.value) && <Check size={12} className="ml-auto text-sky-600" />}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Removable chips for a selection (used under pickers that can hold many values). */
export function SelectionChips({
  items,
  onRemove,
}: {
  items: { value: string; label: string }[];
  onRemove: (value: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {items.map((it) => (
        <span
          key={it.value}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-sky-100 bg-sky-50 py-0.5 pl-2 pr-1 text-[11px] font-medium text-sky-800"
        >
          <span className="truncate">{it.label}</span>
          <button
            type="button"
            aria-label={`Remove ${it.label}`}
            onClick={() => onRemove(it.value)}
            className="rounded-full p-0.5 text-sky-600 hover:bg-sky-100"
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}
