import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { FactoryEmployee } from "@/lib/api-client/custom-hooks";
import { LabelChip } from "./parts";

/** Tick the factory employees an assignment is for (only one payroll category's: the dialog passes those). */
export function EmployeePicker({
  rows,
  picked,
  onPicked,
  loading,
  emptyText,
}: {
  rows: FactoryEmployee[];
  picked: ReadonlySet<number>;
  onPicked: (next: Set<number>) => void;
  loading?: boolean;
  emptyText: string;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${r.name} ${r.code} ${r.label ?? ""}`.toLowerCase().includes(q));
  }, [rows, query]);
  const allShown = shown.length > 0 && shown.every((r) => picked.has(r.id));

  const toggle = (id: number) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onPicked(next);
  };
  const toggleShown = () => {
    const next = new Set(picked);
    for (const r of shown) {
      if (allShown) next.delete(r.id);
      else next.add(r.id);
    }
    onPicked(next);
  };

  return (
    <div className="space-y-2" data-testid="fe-picker">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find by name, code or label"
          aria-label="Find employees"
          className="h-9 pl-8"
          data-testid="fe-picker-search"
        />
      </div>
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span data-testid="fe-picker-count">{picked.size} chosen</span>
        {shown.length > 0 && (
          <button type="button" onClick={toggleShown} className="font-semibold text-blue-600 hover:underline">
            {allShown ? "Untick these" : `Tick all ${shown.length} shown`}
          </button>
        )}
      </div>
      <div className="max-h-64 divide-y overflow-y-auto rounded-xl border">
        {loading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          shown.map((r) => (
            <label
              key={r.id}
              className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-gray-50"
              data-testid={`fe-pick-${r.code}`}
            >
              <Checkbox
                checked={picked.has(r.id)}
                onCheckedChange={() => toggle(r.id)}
                aria-label={`Choose ${r.name}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-gray-900">{r.name}</span>
                <span className="block truncate text-xs text-gray-500">
                  {r.code}
                  {r.shift ? ` · now ${r.shift.name}` : " · no shift"}
                </span>
              </span>
              {r.label && <LabelChip name={r.label} color={r.labelColor} />}
            </label>
          ))
        )}
      </div>
    </div>
  );
}
