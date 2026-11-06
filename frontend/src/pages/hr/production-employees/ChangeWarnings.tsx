import { AlertTriangle, Loader2 } from "lucide-react";
import { useCycleChangePreview, type PayCycle } from "@/lib/api-client/custom-hooks";
import { previewWarnings, warningsHeading } from "./logic";

/**
 * The payroll warning inside the "Move ... ?" confirmation (owner 2026-11-06): for every employee in the move who already
 * has payroll, the owner's sentence with the real cycles and dates ("This employee was previously assigned to Weekly
 * Payroll, and payroll has already been generated for the previous period (2 Feb – 8 Feb 2026). If you change the payroll
 * category to Monthly, ..."). Nothing is shown for people with no payroll yet: no needless warnings.
 */
export function ChangeWarnings({ ids, target, open }: { ids: number[]; target: PayCycle | null; open: boolean }) {
  const preview = useCycleChangePreview(ids, target, open);
  if (preview.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-gray-500" role="status" data-testid="pe-preview-loading">
        <Loader2 size={13} className="animate-spin text-amber-600" /> Checking the payroll already generated…
      </p>
    );
  }
  if (preview.isError || !preview.data) {
    return (
      <p className="text-xs text-gray-600" data-testid="pe-preview-error">
        The payroll already generated could not be checked just now. Whatever you choose, a day that was already paid is
        never paid again.
      </p>
    );
  }
  const warnings = previewWarnings(preview.data);
  const configError = target ? preview.data.configError : null;
  if (warnings.length === 0) {
    return configError ? (
      <p className="text-xs text-amber-800" data-testid="pe-preview-config">
        {configError}
      </p>
    ) : null;
  }
  return (
    <div
      className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950"
      data-testid="pe-preview-warnings"
    >
      <p className="flex items-center gap-1.5 font-bold text-amber-900">
        <AlertTriangle size={13} className="shrink-0 text-amber-600" />
        {warningsHeading(warnings.length, preview.data.employees.length)}
      </p>
      <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
        {warnings.map((w) => (
          <li key={w.employeeId} data-testid={`pe-preview-warning-${w.employeeCode}`}>
            {preview.data.employees.length > 1 && (
              <p className="font-semibold text-gray-900">
                {w.name} <span className="font-mono font-normal text-gray-500">({w.employeeCode})</span>
              </p>
            )}
            <p className="leading-relaxed">{w.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
