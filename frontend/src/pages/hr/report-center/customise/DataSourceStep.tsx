import { CalendarDays, Fingerprint, Inbox, Users, Wallet, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CustomDataset, CustomGrain } from "@/lib/api-client/custom-hooks/report-customise";
import { GRAIN_LABEL } from "./builder-logic";

const GRAIN_ICON: Record<CustomGrain, LucideIcon> = {
  employee: Users,
  day: CalendarDays,
  punch: Fingerprint,
  request: Inbox,
  payroll: Wallet,
};

/** Step 1: one card per data source. Switching away from a source the user has worked on asks first (`pending`). */
export function DataSourceStep({
  datasets,
  value,
  pending,
  onPick,
  onConfirm,
  onCancel,
}: {
  datasets: CustomDataset[];
  value: string | null;
  /** A source the user picked while the current one has their own fields or filters: waiting for "Switch". */
  pending: CustomDataset | null;
  onPick: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!datasets.length) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
        No data source is available to your role.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Data source" className="grid gap-2 sm:grid-cols-2">
        {datasets.map((ds) => {
          const on = ds.id === value;
          const Icon = GRAIN_ICON[ds.grain] ?? Users;
          return (
            <button
              key={ds.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`dataset-${ds.id}`}
              onClick={() => onPick(ds.id)}
              className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                on ? "border-sky-300 bg-sky-50/70 ring-1 ring-sky-200" : "bg-white hover:border-gray-300"
              }`}
            >
              <span
                data-report-chip=""
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700 ring-1 ring-sky-100"
              >
                <Icon size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-gray-900">{ds.label}</span>
                {ds.description && (
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{ds.description}</span>
                )}
                <span className="mt-1 block text-[11px] font-semibold text-gray-500">{GRAIN_LABEL[ds.grain]}</span>
              </span>
            </button>
          );
        })}
      </div>
      {pending && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          data-testid="dataset-switch-confirm"
        >
          <p className="mr-auto">
            Switch to <b>{pending.label}</b>? The fields and filters you picked are replaced by its defaults.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Keep current
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} data-testid="dataset-switch-yes">
            Switch
          </Button>
        </div>
      )}
    </div>
  );
}
