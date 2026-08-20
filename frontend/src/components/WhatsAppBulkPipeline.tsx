import { CheckCircle2, Loader2, X, MessageCircle, AlertTriangle } from "lucide-react";
import type { WhatsAppBulkProgress } from "@/lib/api-client/custom-hooks";

// Visual-only progress bar for bulk WhatsApp sends, mirroring
// SalarySlipBulkPipeline's role and layout exactly -purely reflects the
// `data` prop (owned by WhatsAppBulkContext, which owns the actual trigger
// + polling). Never drives the operation itself. Additionally lists each
// failed send with its specific reason, since "no phone on file" vs. a
// Meta API error need different follow-up from HR.
export default function WhatsAppBulkPipeline({ active, data, onDismiss }: {
  active: boolean;
  data: WhatsAppBulkProgress | undefined;
  onDismiss: () => void;
}) {
  if (!active) return null;

  const total = data?.total ?? 0;
  const completed = data?.completed ?? 0;
  const succeeded = data?.succeeded ?? 0;
  const failed = data?.failed ?? 0;
  const overallDone = data?.stage === "completed";
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50/80 via-white to-teal-50/60 p-4 sm:p-5 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            {!overallDone && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            )}
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${overallDone ? "bg-green-500" : "bg-emerald-500"}`} />
          </span>
          <p className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
            <MessageCircle size={13} className="text-emerald-500" />
            {overallDone ? "Bulk WhatsApp send complete" : "Sending via WhatsApp…"}
          </p>
        </div>
        <button onClick={onDismiss} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-white/70" title="Dismiss">
          <X size={14} />
        </button>
      </div>

      <div className="h-1.5 w-full rounded-full bg-emerald-100/70 overflow-hidden mb-2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-teal-500 to-cyan-500 transition-all duration-500 ease-out"
          style={{ width: `${overallDone ? 100 : pct}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
        <span className="flex items-center gap-1">
          {!overallDone && <Loader2 size={11} className="animate-spin text-emerald-500" />}
          {completed} / {total || completed} message{(total || completed) !== 1 ? "s" : ""} processed
        </span>
        <span>{pct}%</span>
      </div>

      {!overallDone && data?.currentEmployee && (
        <p className="text-xs text-gray-400 truncate mb-2">Processing: {data.currentEmployee}</p>
      )}

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

      {overallDone && (data?.failures?.length ?? 0) > 0 && (
        <div className="mt-3 pt-3 border-t border-emerald-100/70 space-y-1 max-h-40 overflow-y-auto">
          <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">Failed sends</p>
          {data!.failures.map((f, i) => (
            <div key={i} className="text-[11px] flex items-start gap-1.5">
              <span className="font-semibold text-gray-700 shrink-0">{f.employeeName} ({f.employeeCode})</span>
              <span className="text-gray-400 truncate">{f.error}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
