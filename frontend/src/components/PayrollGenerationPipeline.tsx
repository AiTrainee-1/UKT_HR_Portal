import { CheckCircle2, Loader2, X, Users, AlertTriangle } from "lucide-react";
import type { PayrollGenerateProgress } from "@/lib/api-client/custom-hooks";

// Visual-only progress bar for payroll generation. Purely reflects the
// `data` prop (sourced from PayrollGenerationContext, which owns the actual
// polling) — this component never drives generation itself. Mirrors
// BiometricSyncPipeline's role for the sync flow, but payroll iterates over
// dozens/hundreds of employees rather than a handful of devices, so a
// determinate count-based bar fits better than discrete per-item nodes.
export default function PayrollGenerationPipeline({ active, data, onDismiss }: {
  active: boolean;
  data: PayrollGenerateProgress | undefined;
  onDismiss: () => void;
}) {
  if (!active) return null;

  const total = data?.total ?? 0;
  const completed = data?.completed ?? 0;
  const generated = data?.generated ?? 0;
  const skipped = data?.skipped ?? 0;
  const overallDone = data?.stage === "completed";
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50/80 via-white to-blue-50/60 p-4 sm:p-5 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            {!overallDone && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
            )}
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${overallDone ? "bg-green-500" : "bg-indigo-500"}`} />
          </span>
          <p className="text-sm font-bold text-gray-800">
            {overallDone ? "Payroll generation complete" : "Generating payroll…"}
          </p>
        </div>
        <button onClick={onDismiss} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-white/70" title="Dismiss">
          <X size={14} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full rounded-full bg-indigo-100/70 overflow-hidden mb-2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-indigo-400 via-blue-500 to-cyan-500 transition-all duration-500 ease-out"
          style={{ width: `${overallDone ? 100 : pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
        <span className="flex items-center gap-1">
          {!overallDone && <Loader2 size={11} className="animate-spin text-indigo-500" />}
          {overallDone
            ? `${completed} / ${total || completed} employees processed`
            : `${completed} / ${total} employees processed`}
        </span>
        <span>{pct}%</span>
      </div>

      {!overallDone && data?.currentEmployee && (
        <p className="text-xs text-gray-400 truncate mb-2">Processing: {data.currentEmployee}</p>
      )}

      <div className="flex items-center gap-3 mt-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
          <CheckCircle2 size={11} /> {generated} generated
        </span>
        {skipped > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
            <AlertTriangle size={11} /> {skipped} skipped
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-[11px] text-gray-400 ml-auto">
          <Users size={11} /> {total} total
        </span>
      </div>
    </div>
  );
}
