import { useLocation } from "wouter";
import { CheckCircle2, Loader2, X, MessageCircle } from "lucide-react";
import { useWhatsAppBulk } from "@/contexts/WhatsAppBulkContext";

// Floating indicator that keeps a bulk WhatsApp send visible while the user
// browses other pages. Hidden on the Staff/Production Payroll pages (whose
// Payslip sub-tab already renders the full inline WhatsAppBulkPipeline for
// the same shared state) -mirrors GlobalSalarySlipBulkBanner's role exactly.
export default function GlobalWhatsAppBulkBanner() {
  const [pathname] = useLocation();
  const { showPipeline, isRunning, progress, dismiss } = useWhatsAppBulk();

  if (!showPipeline || pathname.startsWith("/hr/payroll") || pathname.startsWith("/hr/production-payroll")) return null;

  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="fixed bottom-5 right-5 z-[100] w-80 rounded-2xl border border-emerald-100 bg-white/95 backdrop-blur-xl shadow-[0_16px_48px_-12px_rgba(15,40,80,0.35)] p-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 size={15} className="text-emerald-600 animate-spin" />
          ) : (
            <CheckCircle2 size={15} className="text-green-600" />
          )}
          <p className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
            <MessageCircle size={13} className="text-emerald-500" />
            {isRunning ? "Sending via WhatsApp…" : "Bulk WhatsApp send complete"}
          </p>
        </div>
        <button onClick={dismiss} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100" title="Dismiss">
          <X size={13} />
        </button>
      </div>

      {total > 0 && (
        <>
          <div className="h-1.5 w-full rounded-full bg-emerald-100/70 overflow-hidden mb-2">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-teal-500 to-cyan-500 transition-all duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-gray-500">
            {completed} / {total} messages processed
            {!isRunning && <span className="text-green-600 font-semibold"> -running in the background is finished</span>}
          </p>
          {isRunning && progress?.currentEmployee && (
            <p className="text-[11px] text-gray-400 truncate mt-1">Processing: {progress.currentEmployee}</p>
          )}
        </>
      )}
    </div>
  );
}
