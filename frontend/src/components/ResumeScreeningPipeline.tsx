import { CheckCircle2, Loader2, X, FileText, AlertTriangle } from "lucide-react";
import type { ResumeScreeningProgress } from "@/lib/api-client/custom-hooks";

// Visual-only progress bar for bulk resume screening. Purely reflects the
// `data` prop (sourced from ResumeScreeningContext, which owns the actual
// polling) — mirrors PayrollGenerationPipeline's role for payroll generation.
export default function ResumeScreeningPipeline({ active, data, onDismiss }: {
  active: boolean;
  data: ResumeScreeningProgress | undefined;
  onDismiss: () => void;
}) {
  if (!active) return null;

  const total = data?.total ?? 0;
  const completed = data?.completed ?? 0;
  const screened = data?.screened ?? 0;
  const failed = data?.failed ?? 0;
  const overallDone = data?.stage === "completed";
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50/80 via-white to-fuchsia-50/60 p-4 sm:p-5 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            {!overallDone && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
            )}
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${overallDone ? "bg-green-500" : "bg-violet-500"}`} />
          </span>
          <p className="text-sm font-bold text-gray-800">
            {overallDone ? "Screening complete" : "Screening resumes…"}
          </p>
        </div>
        <button onClick={onDismiss} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-white/70" title="Dismiss">
          <X size={14} />
        </button>
      </div>

      <div className="h-1.5 w-full rounded-full bg-violet-100/70 overflow-hidden mb-2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-400 via-fuchsia-500 to-pink-500 transition-all duration-500 ease-out"
          style={{ width: `${overallDone ? 100 : pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
        <span className="flex items-center gap-1">
          {!overallDone && <Loader2 size={11} className="animate-spin text-violet-500" />}
          {completed} / {total || completed} resumes processed
        </span>
        <span>{pct}%</span>
      </div>

      {!overallDone && data?.currentFile && (
        <p className="text-xs text-gray-400 truncate mb-2">Processing: {data.currentFile}</p>
      )}

      <div className="flex items-center gap-3 mt-2">
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
          <CheckCircle2 size={11} /> {screened} screened
        </span>
        {failed > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
            <AlertTriangle size={11} /> {failed} failed
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-[11px] text-gray-400 ml-auto">
          <FileText size={11} /> {total} total
        </span>
      </div>
    </div>
  );
}
