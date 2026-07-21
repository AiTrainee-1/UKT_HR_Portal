import { useLocation } from "wouter";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { useResumeScreening } from "@/contexts/ResumeScreeningContext";

// Floating indicator that keeps bulk resume screening progress visible while
// the user browses other pages. Hidden on the Resume Screening page itself,
// since it already renders the full inline ResumeScreeningPipeline for the
// same shared state — mirrors GlobalPayrollBanner's role for payroll runs.
export default function GlobalResumeScreeningBanner() {
  const [pathname] = useLocation();
  const { showPipeline, isScreening, progress, dismiss } = useResumeScreening();

  if (!showPipeline || pathname.startsWith("/hr/recruitment/resume-screening")) return null;

  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="fixed bottom-5 right-5 z-[100] w-80 rounded-2xl border border-violet-100 bg-white/95 backdrop-blur-xl shadow-[0_16px_48px_-12px_rgba(15,40,80,0.35)] p-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isScreening ? (
            <Loader2 size={15} className="text-violet-600 animate-spin" />
          ) : (
            <CheckCircle2 size={15} className="text-green-600" />
          )}
          <p className="text-sm font-bold text-gray-800">
            {isScreening ? "Screening resumes…" : "Resume screening complete"}
          </p>
        </div>
        <button onClick={dismiss} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Dismiss">
          <X size={13} />
        </button>
      </div>

      {total > 0 && (
        <>
          <div className="h-1.5 w-full rounded-full bg-violet-100/70 overflow-hidden mb-2">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-400 via-fuchsia-500 to-pink-500 transition-all duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-gray-500">
            {completed} / {total} resumes processed
            {!isScreening && <span className="text-green-600 font-semibold"> — running in the background is finished</span>}
          </p>
          {isScreening && progress?.currentFile && (
            <p className="text-[11px] text-gray-400 truncate mt-1">Processing: {progress.currentFile}</p>
          )}
        </>
      )}
    </div>
  );
}
