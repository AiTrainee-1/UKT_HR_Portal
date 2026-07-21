import { useLocation } from "wouter";
import { CheckCircle2, Loader2, X, Mail, FileStack } from "lucide-react";
import { useSalarySlipBulk } from "@/contexts/SalarySlipBulkContext";

// Floating indicator that keeps a Salary Slip bulk download/email visible
// while the user browses other pages. Hidden on /hr/salary-slip itself,
// since that page already renders the full inline SalarySlipBulkPipeline
// for the same shared state — mirrors GlobalPayrollBanner's role.
export default function GlobalSalarySlipBulkBanner() {
  const [pathname] = useLocation();
  const { showPipeline, isRunning, kind, progress, dismiss } = useSalarySlipBulk();

  if (!showPipeline || pathname.startsWith("/hr/salary-slip")) return null;

  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="fixed bottom-5 right-5 z-[100] w-80 rounded-2xl border border-indigo-100 bg-white/95 backdrop-blur-xl shadow-[0_16px_48px_-12px_rgba(15,40,80,0.35)] p-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 size={15} className="text-indigo-600 animate-spin" />
          ) : (
            <CheckCircle2 size={15} className="text-green-600" />
          )}
          <p className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
            {kind === "email" ? <Mail size={13} className="text-indigo-500" /> : <FileStack size={13} className="text-indigo-500" />}
            {isRunning
              ? (kind === "email" ? "Emailing salary slips…" : "Preparing salary slips…")
              : (kind === "email" ? "Bulk email complete" : "Combined PDF ready")}
          </p>
        </div>
        <button onClick={dismiss} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Dismiss">
          <X size={13} />
        </button>
      </div>

      {total > 0 && (
        <>
          <div className="h-1.5 w-full rounded-full bg-indigo-100/70 overflow-hidden mb-2">
            <div
              className="h-full rounded-full bg-gradient-to-r from-indigo-400 via-blue-500 to-cyan-500 transition-all duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-gray-500">
            {completed} / {total} slips processed
            {!isRunning && <span className="text-green-600 font-semibold"> — running in the background is finished</span>}
          </p>
          {isRunning && progress?.currentEmployee && (
            <p className="text-[11px] text-gray-400 truncate mt-1">Processing: {progress.currentEmployee}</p>
          )}
        </>
      )}
    </div>
  );
}
