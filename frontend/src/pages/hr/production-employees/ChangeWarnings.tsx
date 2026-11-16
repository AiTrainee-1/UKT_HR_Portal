import { AlertTriangle, Loader2 } from "lucide-react";
import type { CycleChangePreview, CycleChangePreviewEmployee, PayCycle } from "@/lib/api-client/custom-hooks";
import { previewWarnings, warningsHeading } from "./logic";

/** The preview query as the page holds it (useCycleChangePreview). */
export type PreviewState = { isLoading: boolean; isError: boolean; data?: CycleChangePreview };

/**
 * The payroll warning inside the "Move ... ?" confirmation (owner 2026-11-06, facts added 2026-11-16): for every worker in
 * the move who already has payroll, the owner's sentence with the real cycles, dates and amounts ("Selvi Rani has already
 * received salary under BiWeekly up to 15 Feb 2026: 2 pay periods, ₹9,100 net ... If you move them to Weekly, the salary
 * already paid for that time will not be paid again: only the remaining eligible days are calculated under Weekly, from
 * 16 Feb 2026."). Nothing is shown for people with no payroll yet: no needless warnings. `conflict`: the facts the server
 * sent when it refused the move for want of a reason (they replace the preview's).
 */
export function ChangeWarnings({
  preview,
  target,
  conflict,
}: {
  preview: PreviewState;
  target: PayCycle | null;
  conflict?: CycleChangePreviewEmployee[] | null;
}) {
  if (!conflict?.length && preview.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-gray-500" role="status" data-testid="pe-preview-loading">
        <Loader2 size={13} className="animate-spin text-amber-600" /> Checking the payroll already generated…
      </p>
    );
  }
  if (!conflict?.length && (preview.isError || !preview.data)) {
    return (
      <p className="text-xs text-gray-600" data-testid="pe-preview-error">
        The payroll already generated could not be checked just now. Whatever you choose, a day that was already paid is
        never paid again.
      </p>
    );
  }
  const warnings = conflict?.length ? conflict : previewWarnings(preview.data);
  const total = conflict?.length ? conflict.length : (preview.data?.employees.length ?? 0);
  const configError = target ? (preview.data?.configError ?? null) : null;
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
        {warningsHeading(warnings.length, total)}
      </p>
      <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
        {warnings.map((w) => (
          <li key={w.employeeId} data-testid={`pe-preview-warning-${w.employeeCode}`}>
            {total > 1 && (
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
