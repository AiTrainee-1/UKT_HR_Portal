import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useReportEmployeeOptions, type EmployeeOption } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { SelectionChips } from "./MultiSelectFilter";

/** Longest id list we put in a URL (each id is ~5 characters; keeps the query well under proxy limits). */
export const MAX_EMPLOYEES = 200;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Multi-employee picker: server-side search (branch-scoped), selection kept as chips. */
export function EmployeeMultiPicker({
  value,
  onChange,
  departmentIds,
  label,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  departmentIds: string[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 300);
  const labels = useRef(new Map<string, string>());

  const search = useReportEmployeeOptions({ q: debounced, departmentIds, enabled: open });
  // Chips need names even for ids restored from a shared link: resolve those the server side.
  const unknown = value.filter((id) => !labels.current.has(id));
  const resolved = useReportEmployeeOptions({ ids: unknown, enabled: unknown.length > 0 });

  const remember = (list: EmployeeOption[] | undefined) =>
    list?.forEach((o) => labels.current.set(String(o.value), o.label));
  remember(search.data);
  remember(resolved.data);

  const selected = useMemo(() => new Set(value), [value]);
  const toggle = (id: string) => {
    if (selected.has(id)) onChange(value.filter((x) => x !== id));
    else if (value.length < MAX_EMPLOYEES) onChange([...value, id]);
  };
  const chips = value.map((id) => ({ value: id, label: labels.current.get(id) ?? `Employee #${id}` }));
  const results = search.data ?? [];

  return (
    <div>
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
            <span className={value.length ? "text-gray-900" : "text-muted-foreground"}>
              {value.length ? `${value.length} employee${value.length === 1 ? "" : "s"} selected` : "All employees"}
            </span>
            <ChevronsUpDown className="shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[340px] p-0" {...{ [VIEW_SAFE_ATTR]: "" }}>
          <div className="relative border-b p-2">
            <Search
              size={13}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or employee code…"
              aria-label="Search employees"
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="flex items-center justify-between border-b px-3 py-1.5 text-[11px]">
            <span className="text-muted-foreground">
              {value.length ? `${value.length} of ${MAX_EMPLOYEES} max selected` : "Nothing selected = all employees"}
            </span>
            <button type="button" className="font-semibold text-gray-500 hover:underline" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {search.isFetching && results.length === 0 && (
              <p className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" /> Searching…
              </p>
            )}
            {!search.isFetching && results.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">No employee found.</p>
            )}
            {results.map((o) => {
              const id = String(o.value);
              const on = selected.has(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggle(id)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${on ? "bg-sky-50/60" : ""}`}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary">
                    {on && <Check size={12} className="text-primary" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.label}</span>
                    {o.sub && <span className="block truncate text-[11px] text-muted-foreground">{o.sub}</span>}
                  </span>
                  {o.status !== "active" && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">
                      {o.status}
                    </span>
                  )}
                </button>
              );
            })}
            {results.length >= 40 && (
              <p className="border-t px-3 py-1.5 text-center text-[11px] text-muted-foreground">
                Type to narrow the list…
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <SelectionChips items={chips} onRemove={(id) => onChange(value.filter((x) => x !== id))} />
    </div>
  );
}
