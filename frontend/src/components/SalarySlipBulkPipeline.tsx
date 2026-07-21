import { CheckCircle2, Loader2, X, Mail, FileStack, AlertTriangle } from "lucide-react";
import type { SalarySlipBulkProgress } from "@/lib/api-client/custom-hooks";

// Visual-only progress bar for Salary Slip bulk download / bulk email,
// mirroring PayrollGenerationPipeline's role and layout — purely reflects
// the `data` prop (owned by SalarySlipBulkContext, which owns the actual
// trigger + polling). Never drives the operation itself.
export default function SalarySlipBulkPipeline({ active, data, onDismiss }: {
  active: boolean;
  data: SalarySlipBulkProgress | undefined;
  onDismiss: () => void;
}) {
  if (!active) return null;

  const kind = data?.kind ?? "pdf";
  const total = data?.total ?? 0;
  const completed = data?.completed ?? 0;
  const succeeded = data?.succeeded ?? 0;
  const failed = data?.failed ?? 0;
  const overallDone = data?.stage === "completed";
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const verb = kind === "email" ? "Emailing" : "Preparing";
  const doneVerb = kind === "email" ? "Bulk email complete" : "Combined PDF ready";

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
          <p className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
            {kind === "email" ? <Mail size={13} className="text-indigo-500" /> : <FileStack size={13} className="text-indigo-500" />}
            {overallDone ? doneVerb : `${verb} salary slips…`}
          </p>
        </div>
        <button onClick={onDismiss} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-white/70" title="Dismiss">
          <X size={14} />
        </button>
      </div>

      <div className="h-1.5 w-full rounded-full bg-indigo-100/70 overflow-hidden mb-2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-indigo-400 via-blue-500 to-cyan-500 transition-all duration-500 ease-out"
          style={{ width: `${overallDone ? 100 : pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
        <span className="flex items-center gap-1">
          {!overallDone && <Loader2 size={11} className="animate-spin text-indigo-500" />}
          {completed} / {total || completed} slip{(total || completed) !== 1 ? "s" : ""} processed
        </span>
        <span>{pct}%</span>
      </div>

      {!overallDone && data?.currentEmployee && (
        <p className="text-xs text-gray-400 truncate mb-2">Processing: {data.currentEmployee}</p>
      )}

      {kind === "email" && (
        <div className="flex items-center gap-3 mt-2">
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
            <CheckCircle2 size={11} /> {succeeded} sent
          </span>
          {failed > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
              <AlertTriangle size={11} /> {failed} failed
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-[11px] text-gray-400 ml-auto">
            {total} total
          </span>
        </div>
      )}
    </div>
  );
}
