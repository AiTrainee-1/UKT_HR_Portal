import { Factory, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { CATEGORIES } from "./config";
import type { Category, ListStatus } from "./types";

type Props = {
  value: Category;
  counts: Record<Category, Record<ListStatus, number>>;
  loading: boolean;
  onChange: (c: Category) => void;
};

const ICON = { staff: Users, production: Factory } as const;

/** Staff or Production: the first choice on the page, and it decides everything below it. */
export default function CategorySwitch({ value, counts, loading, onChange }: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Kind of employee">
      {(Object.keys(CATEGORIES) as Category[]).map((key) => {
        const cfg = CATEGORIES[key];
        const Icon = ICON[key];
        const on = value === key;
        const n = counts[key];
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={on}
            data-testid={`category-${key}`}
            onClick={() => onChange(key)}
            className={cn(
              "group relative flex items-center gap-4 overflow-hidden rounded-2xl border bg-gradient-to-br p-4 text-left shadow-sm transition-all",
              on
                ? `${cfg.accent.gradient} ${cfg.accent.border} ring-2 ${cfg.accent.ring}`
                : "from-white to-white hover:border-gray-300 hover:shadow",
            )}
          >
            <div
              className={cn(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-colors",
                on ? `${cfg.accent.solid.split(" ")[0]} text-white` : `${cfg.accent.soft} ${cfg.accent.text}`,
              )}
            >
              <Icon size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-black text-gray-900">{cfg.label}</p>
              <p className="text-xs text-gray-500">{cfg.tagline}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-bold", cfg.accent.chip)}>
                  {loading ? "…" : n.active} active
                </span>
                <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-bold text-gray-600">
                  {loading ? "…" : n.inactive} inactive
                </span>
              </div>
            </div>
            <span
              className={cn(
                "absolute right-3 top-3 h-5 w-5 rounded-full border-2 transition-colors",
                on ? `${cfg.accent.border} ${cfg.accent.soft}` : "border-gray-200",
              )}
              aria-hidden="true"
            >
              {on && (
                <span
                  className={cn("m-auto mt-[3px] block h-2.5 w-2.5 rounded-full", cfg.accent.solid.split(" ")[0])}
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
